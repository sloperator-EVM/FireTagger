"""Pydantic schemas for tier metadata and shared API responses."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.tiers import Tier, TierMetadata as CoreTierMetadata, get_tier_metadata


class TierMetadata(BaseModel):
    """Public display metadata for a valid player tier."""

    key: Tier
    display_name: str
    display_color: str
    color_code: str

    @classmethod
    def from_core(cls, metadata: CoreTierMetadata) -> "TierMetadata":
        """Build API-facing tier metadata from shared core metadata."""

        return cls(
            key=metadata.key,
            display_name=metadata.display_name,
            display_color=metadata.display_color,
            color_code=metadata.color_code,
        )

    @classmethod
    def for_tier(cls, tier: Tier) -> "TierMetadata":
        """Build API-facing metadata for a valid tier."""

        return cls.from_core(get_tier_metadata(tier))


class ErrorResponse(BaseModel):
    """Standardized error payload returned by API endpoints."""

    error: str
    message: str
    details: dict[str, Any] | None = None


class DeleteResponse(BaseModel):
    """Response returned after deleting a player tier assignment."""

    deleted: bool
    minecraft_username: str | None = None
    discord_user_id: str | None = None
    message: str | None = None


class TierInput(BaseModel):
    """Shared strict tier input schema that rejects unknown tiers during validation."""

    model_config = ConfigDict(extra="forbid")

    tier: Tier = Field(..., description="A valid tier key, e.g. HT1 or LT5.")
