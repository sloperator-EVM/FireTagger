"""Pydantic schemas for public and admin player tier API payloads."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.tiers import Tier
from app.schemas.tier import TierMetadata


class PlayerTierResponse(BaseModel):
    """Public single-player tier assignment response."""

    model_config = ConfigDict(from_attributes=True)

    minecraft_username: str
    discord_user_id: str
    tier: Tier
    tier_metadata: TierMetadata
    updated_at: datetime | None = None

    @classmethod
    def from_assignment(cls, assignment: object) -> "PlayerTierResponse":
        """Build a public response from an ORM-style player tier assignment."""

        tier = Tier(getattr(assignment, "tier"))
        return cls(
            minecraft_username=getattr(assignment, "minecraft_username"),
            discord_user_id=getattr(assignment, "discord_user_id"),
            tier=tier,
            tier_metadata=TierMetadata.for_tier(tier),
            updated_at=getattr(assignment, "updated_at", None),
        )


class AllPlayerTiersResponse(BaseModel):
    """Public mapping of Minecraft usernames to tier assignments."""

    players: dict[str, PlayerTierResponse]


class AdminAssignRequest(BaseModel):
    """Admin request payload for assigning a tier to a player."""

    model_config = ConfigDict(extra="forbid")

    minecraft_username: str = Field(..., min_length=1, max_length=16)
    discord_user_id: str = Field(..., min_length=1, max_length=32)
    tier: Tier

    @field_validator("minecraft_username")
    @classmethod
    def normalize_minecraft_username(cls, value: str) -> str:
        """Trim and validate the Minecraft username before database access."""

        username = value.strip()
        if not username:
            raise ValueError("minecraft_username is required")
        return username

    @field_validator("discord_user_id")
    @classmethod
    def normalize_discord_user_id(cls, value: str) -> str:
        """Trim and validate the Discord user ID before database access."""

        discord_user_id = value.strip()
        if not discord_user_id:
            raise ValueError("discord_user_id is required")
        return discord_user_id


class AdminUpdateRequest(BaseModel):
    """Admin request payload for updating an existing player tier assignment."""

    model_config = ConfigDict(extra="forbid")

    minecraft_username: str | None = Field(default=None, min_length=1, max_length=16)
    discord_user_id: str | None = Field(default=None, min_length=1, max_length=32)
    tier: Tier | None = None

    @field_validator("minecraft_username")
    @classmethod
    def normalize_optional_minecraft_username(cls, value: str | None) -> str | None:
        """Trim an optional Minecraft username before database access."""

        if value is None:
            return value
        username = value.strip()
        if not username:
            raise ValueError("minecraft_username cannot be blank")
        return username

    @field_validator("discord_user_id")
    @classmethod
    def normalize_optional_discord_user_id(cls, value: str | None) -> str | None:
        """Trim an optional Discord user ID before database access."""

        if value is None:
            return value
        discord_user_id = value.strip()
        if not discord_user_id:
            raise ValueError("discord_user_id cannot be blank")
        return discord_user_id
