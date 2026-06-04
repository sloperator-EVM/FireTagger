"""Authenticated administrative API routes for managing player tiers."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import admin_rate_limiter, require_admin_api_key
from app.core.tiers import Tier
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.player_tier import PlayerTier
from app.schemas import (
    AdminAssignRequest,
    AdminDeleteResponse,
    AdminUpdateRequest,
    PlayerTierResponse,
)

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin_api_key), Depends(admin_rate_limiter())],
)

DEFAULT_ACTOR = "api-key-admin"


def _normalize_minecraft_username(minecraft_username: str) -> str:
    """Normalize a Minecraft username for case-insensitive uniqueness checks."""

    return minecraft_username.strip().lower()


def _tier_value(tier: Tier | str) -> str:
    """Return a JSON-safe tier string for API and audit payloads."""

    return tier.value if isinstance(tier, Tier) else tier


def _assignment_snapshot(assignment: PlayerTier) -> dict[str, Any]:
    """Serialize the mutable fields of a player tier assignment for audit logging."""

    return {
        "minecraft_username": assignment.minecraft_username,
        "discord_user_id": assignment.discord_user_id,
        "tier": _tier_value(assignment.tier),
    }


def _actor(provided_actor: str | None) -> str:
    """Resolve the actor recorded in audit logs."""

    return provided_actor or DEFAULT_ACTOR


def _write_audit_log(
    db: Session,
    *,
    actor: str,
    action: str,
    old_value: dict[str, Any] | None,
    new_value: dict[str, Any] | None,
) -> None:
    """Append an audit log row for an admin tier mutation."""

    reference = new_value or old_value or {}
    db.add(
        AuditLog(
            actor=actor,
            action=action,
            minecraft_username=reference.get("minecraft_username"),
            discord_user_id=reference.get("discord_user_id"),
            old_value=old_value,
            new_value=new_value,
        )
    )


def _raise_conflict(message: str, details: dict[str, object]) -> None:
    """Raise a standardized 409 response for uniqueness conflicts."""

    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error": "tier_assignment_conflict", "message": message, "details": details},
    )


def _raise_not_found(minecraft_username: str) -> None:
    """Raise a standardized 404 response for missing player assignments."""

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={
            "error": "tier_assignment_not_found",
            "message": "No tier assignment exists for that Minecraft username.",
            "details": {"minecraft_username": minecraft_username},
        },
    )


def _raise_database_unavailable() -> None:
    """Raise a standardized 503 response when persistence fails unexpectedly."""

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "error": "database_unavailable",
            "message": "Tier data is temporarily unavailable.",
            "details": None,
        },
    )


def _find_conflicting_assignment(
    db: Session,
    *,
    minecraft_username: str,
    discord_user_id: str,
    current_id: int | None = None,
) -> PlayerTier | None:
    """Return an existing row that conflicts with the requested unique identifiers."""

    statement = select(PlayerTier).where(
        or_(
            PlayerTier.minecraft_username_lower
            == _normalize_minecraft_username(minecraft_username),
            PlayerTier.discord_user_id == discord_user_id,
        )
    )
    if current_id is not None:
        statement = statement.where(PlayerTier.id != current_id)
    return db.scalar(statement)


@router.get("/tiers", response_model=None)
def list_player_tiers(db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        assignments = list(
            db.scalars(select(PlayerTier).order_by(PlayerTier.minecraft_username_lower)).all()
        )
    except SQLAlchemyError:
        _raise_database_unavailable()

    return {
        "players": [
            PlayerTierResponse.from_assignment(assignment).model_dump(mode="json")
            for assignment in assignments
        ]
    }


@router.get("/tiers/{minecraft_username}", response_model=PlayerTierResponse)
def get_admin_player_tier(
    minecraft_username: str,
    db: Session = Depends(get_db),
) -> PlayerTierResponse:
    try:
        assignment = db.scalar(
            select(PlayerTier).where(
                PlayerTier.minecraft_username_lower
                == _normalize_minecraft_username(minecraft_username)
            )
        )
    except SQLAlchemyError:
        _raise_database_unavailable()

    if assignment is None:
        _raise_not_found(minecraft_username)

    return PlayerTierResponse.from_assignment(assignment)


@router.post("/tiers", response_model=PlayerTierResponse, status_code=status.HTTP_201_CREATED)
def create_player_tier(
    request: AdminAssignRequest,
    db: Session = Depends(get_db),
) -> PlayerTierResponse:
    """Create a new Minecraft-to-Discord tier assignment."""

    actor = _actor(request.actor)
    try:
        conflict = _find_conflicting_assignment(
            db,
            minecraft_username=request.minecraft_username,
            discord_user_id=request.discord_user_id,
        )
        if conflict is not None:
            conflict_fields: list[str] = []
            if conflict.minecraft_username_lower == _normalize_minecraft_username(
                request.minecraft_username
            ):
                conflict_fields.append("minecraft_username")
            if conflict.discord_user_id == request.discord_user_id:
                conflict_fields.append("discord_user_id")
            _raise_conflict(
                "A tier assignment already exists for that Minecraft username or Discord user ID.",
                {"fields": conflict_fields},
            )

        assignment = PlayerTier(
            minecraft_username=request.minecraft_username,
            minecraft_username_lower=_normalize_minecraft_username(request.minecraft_username),
            discord_user_id=request.discord_user_id,
            tier=request.tier,
        )
        db.add(assignment)
        db.flush()
        new_value = _assignment_snapshot(assignment)
        _write_audit_log(
            db,
            actor=actor,
            action="create_tier_assignment",
            old_value=None,
            new_value=new_value,
        )
        db.commit()
        db.refresh(assignment)
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as exc:
        db.rollback()
        if "uq_player_tiers" in str(exc.orig):
            _raise_conflict(
                "A tier assignment already exists for that Minecraft username or Discord user ID.",
                {"fields": ["minecraft_username", "discord_user_id"]},
            )
        _raise_database_unavailable()
    except SQLAlchemyError:
        db.rollback()
        _raise_database_unavailable()

    return PlayerTierResponse.from_assignment(assignment)


@router.patch("/tiers/{minecraft_username}", response_model=PlayerTierResponse)
def update_player_tier(
    minecraft_username: str,
    request: AdminUpdateRequest,
    db: Session = Depends(get_db),
) -> PlayerTierResponse:
    """Update an existing player's tier and, when needed, Discord user ID."""

    actor = _actor(request.actor)
    update_fields = request.model_fields_set - {"actor"}
    if not update_fields:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "empty_update",
                "message": "Provide at least one tier assignment field to update.",
                "details": {"fields": ["tier", "discord_user_id", "minecraft_username"]},
            },
        )

    try:
        assignment = db.scalar(
            select(PlayerTier)
            .where(PlayerTier.minecraft_username_lower == _normalize_minecraft_username(minecraft_username))
            .with_for_update()
        )
        if assignment is None:
            _raise_not_found(minecraft_username)

        next_username = request.minecraft_username or assignment.minecraft_username
        next_discord_user_id = request.discord_user_id or assignment.discord_user_id
        conflict = _find_conflicting_assignment(
            db,
            minecraft_username=next_username,
            discord_user_id=next_discord_user_id,
            current_id=assignment.id,
        )
        if conflict is not None:
            conflict_fields: list[str] = []
            if conflict.minecraft_username_lower == _normalize_minecraft_username(next_username):
                conflict_fields.append("minecraft_username")
            if conflict.discord_user_id == next_discord_user_id:
                conflict_fields.append("discord_user_id")
            _raise_conflict(
                "Another tier assignment already uses that Minecraft username or Discord user ID.",
                {"fields": conflict_fields},
            )

        old_value = _assignment_snapshot(assignment)
        if request.minecraft_username is not None:
            assignment.minecraft_username = request.minecraft_username
            assignment.minecraft_username_lower = _normalize_minecraft_username(
                request.minecraft_username
            )
        if request.discord_user_id is not None:
            assignment.discord_user_id = request.discord_user_id
        if request.tier is not None:
            assignment.tier = request.tier
        db.flush()
        new_value = _assignment_snapshot(assignment)
        _write_audit_log(
            db,
            actor=actor,
            action="update_tier_assignment",
            old_value=old_value,
            new_value=new_value,
        )
        db.commit()
        db.refresh(assignment)
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as exc:
        db.rollback()
        if "uq_player_tiers" in str(exc.orig):
            _raise_conflict(
                "Another tier assignment already uses that Minecraft username or Discord user ID.",
                {"fields": ["minecraft_username", "discord_user_id"]},
            )
        _raise_database_unavailable()
    except SQLAlchemyError:
        db.rollback()
        _raise_database_unavailable()

    return PlayerTierResponse.from_assignment(assignment)


@router.delete("/tiers/{minecraft_username}", response_model=AdminDeleteResponse)
def delete_player_tier(
    minecraft_username: str,
    actor: str | None = Query(default=None, min_length=1, max_length=128),
    db: Session = Depends(get_db),
) -> AdminDeleteResponse:
    """Delete a player tier assignment and return the removed assignment summary."""

    audit_actor = _actor(actor.strip() if actor is not None else None)
    deleted_at = datetime.now(UTC)
    try:
        assignment = db.scalar(
            select(PlayerTier)
            .where(PlayerTier.minecraft_username_lower == _normalize_minecraft_username(minecraft_username))
            .with_for_update()
        )
        if assignment is None:
            _raise_not_found(minecraft_username)

        old_value = _assignment_snapshot(assignment)
        db.delete(assignment)
        _write_audit_log(
            db,
            actor=audit_actor,
            action="delete_tier_assignment",
            old_value=old_value,
            new_value=None,
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError:
        db.rollback()
        _raise_database_unavailable()

    return AdminDeleteResponse(
        deleted=True,
        minecraft_username=old_value["minecraft_username"],
        discord_user_id=old_value["discord_user_id"],
        tier=Tier(old_value["tier"]),
        actor=audit_actor,
        deleted_at=deleted_at,
    )
