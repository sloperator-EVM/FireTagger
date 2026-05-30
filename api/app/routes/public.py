"""Public, unauthenticated API routes consumed by the Minecraft mod."""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Callable
from datetime import UTC, datetime
from time import monotonic
from typing import Final

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.tiers import Tier, get_tier_metadata
from app.db.session import get_db
from app.models.player_tier import PlayerTier

router = APIRouter(tags=["public"])

LOOKUP_RATE_LIMIT: Final[tuple[int, int]] = (
    settings.public_lookup_rate_limit,
    settings.rate_limit_window_seconds,
)
FULL_MAPPING_RATE_LIMIT: Final[tuple[int, int]] = (
    settings.public_mapping_rate_limit,
    settings.rate_limit_window_seconds,
)
_minecraft_username_max_length: Final[int] = 16
_rate_limit_windows: dict[str, deque[float]] = defaultdict(deque)


def _error_response(
    status_code: int,
    error: str,
    message: str,
    details: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """Return the stable error shape expected by clients."""

    return JSONResponse(
        status_code=status_code,
        content={"error": error, "message": message, "details": details},
        headers=headers,
    )


def _client_key(request: Request, scope: str) -> str:
    """Build a best-effort rate-limit key for a public caller."""

    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        client_host = forwarded_for.split(",", maxsplit=1)[0].strip()
    elif request.client is not None:
        client_host = request.client.host
    else:
        client_host = "unknown"
    return f"{scope}:{client_host}"


def _rate_limiter(
    max_requests: int, window_seconds: int, scope: str
) -> Callable[[Request], JSONResponse | None]:
    """Create a simple in-process sliding-window rate limiter dependency."""

    def dependency(request: Request) -> JSONResponse | None:
        now = monotonic()
        key = _client_key(request, scope)
        request_times = _rate_limit_windows[key]

        while request_times and now - request_times[0] >= window_seconds:
            request_times.popleft()

        if len(request_times) >= max_requests:
            retry_after = max(1, int(window_seconds - (now - request_times[0])))
            return _error_response(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many requests. Please retry later.",
                details={
                    "limit": max_requests,
                    "window_seconds": window_seconds,
                    "retry_after_seconds": retry_after,
                },
                headers={"Retry-After": str(retry_after)},
            )

        request_times.append(now)
        return None

    return dependency


def _normalize_minecraft_username(minecraft_username: str) -> str:
    """Normalize a Minecraft username for case-insensitive database lookup."""

    return minecraft_username.strip().lower()


def _validate_minecraft_username(minecraft_username: str) -> JSONResponse | None:
    """Validate route username input and return a predictable error when invalid."""

    normalized = minecraft_username.strip()
    if not normalized:
        return _error_response(
            status.HTTP_400_BAD_REQUEST,
            "invalid_minecraft_username",
            "Minecraft username is required.",
        )
    if len(normalized) > _minecraft_username_max_length:
        return _error_response(
            status.HTTP_400_BAD_REQUEST,
            "invalid_minecraft_username",
            "Minecraft username must be 16 characters or fewer.",
            details={"max_length": _minecraft_username_max_length},
        )
    return None


def _tier_payload(assignment: PlayerTier, include_username: bool = True) -> dict[str, object]:
    """Serialize a player tier assignment into the public mod-facing shape."""

    tier = Tier(assignment.tier)
    metadata = get_tier_metadata(tier)
    payload: dict[str, object] = {
        "tier": tier.value,
        "display_name": metadata.display_name,
        "color": metadata.display_color,
        "color_code": metadata.color_code,
        "updated_at": assignment.updated_at.isoformat() if assignment.updated_at else None,
    }
    if include_username:
        payload = {"username": assignment.minecraft_username, **payload}
    return payload


def _last_updated(assignments: list[PlayerTier]) -> str:
    """Return the newest assignment update timestamp or current time for an empty table."""

    timestamps = [assignment.updated_at for assignment in assignments if assignment.updated_at]
    if not timestamps:
        return datetime.now(UTC).isoformat()
    return max(timestamps).isoformat()


@router.get("/tiers/{minecraft_username}", response_model=None)
def get_player_tier(
    minecraft_username: str,
    rate_limit_response: JSONResponse | None = Depends(
        _rate_limiter(*LOOKUP_RATE_LIMIT, scope="tiers_lookup")
    ),
    db: Session = Depends(get_db),
) -> dict[str, object] | JSONResponse:
    """Return one player's tier by case-insensitive Minecraft username."""

    if rate_limit_response is not None:
        return rate_limit_response

    validation_error = _validate_minecraft_username(minecraft_username)
    if validation_error is not None:
        return validation_error

    try:
        assignment = db.scalar(
            select(PlayerTier).where(
                PlayerTier.minecraft_username_lower
                == _normalize_minecraft_username(minecraft_username)
            )
        )
    except SQLAlchemyError:
        return _error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "database_unavailable",
            "Tier data is temporarily unavailable.",
        )

    if assignment is None:
        return _error_response(
            status.HTTP_404_NOT_FOUND,
            "tier_not_found",
            "No tier assignment exists for that Minecraft username.",
            details={"minecraft_username": minecraft_username},
        )

    return _tier_payload(assignment)


@router.get("/tiers", response_model=None)
def get_all_player_tiers(
    rate_limit_response: JSONResponse | None = Depends(
        _rate_limiter(*FULL_MAPPING_RATE_LIMIT, scope="tiers_full_mapping")
    ),
    db: Session = Depends(get_db),
) -> dict[str, object] | JSONResponse:
    """Return every player tier assignment keyed by Minecraft username."""

    if rate_limit_response is not None:
        return rate_limit_response

    try:
        assignments = list(
            db.scalars(select(PlayerTier).order_by(PlayerTier.minecraft_username_lower)).all()
        )
    except SQLAlchemyError:
        return _error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "database_unavailable",
            "Tier data is temporarily unavailable.",
        )

    return {
        "last_updated": _last_updated(assignments),
        "players": {
            assignment.minecraft_username: _tier_payload(assignment, include_username=False)
            for assignment in assignments
        },
    }
