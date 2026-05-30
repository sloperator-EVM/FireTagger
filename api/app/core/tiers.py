"""Shared player tier definitions and presentation metadata."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final

from app.core.config import settings


class Tier(StrEnum):
    """Allowed player tier values, ordered from lowest to highest."""

    LT5 = "LT5"
    HT5 = "HT5"
    LT4 = "LT4"
    HT4 = "HT4"
    LT3 = "LT3"
    HT3 = "HT3"
    LT2 = "LT2"
    HT2 = "HT2"
    LT1 = "LT1"
    HT1 = "HT1"


@dataclass(frozen=True)
class TierMetadata:
    """Display metadata for a player tier."""

    key: Tier
    display_name: str
    display_color: str
    color_code: str


def _override_metadata(tier: Tier, metadata: TierMetadata) -> TierMetadata:
    """Apply optional environment-driven display overrides for a tier."""

    override = settings.tier_color_overrides.get(tier.value, {})
    if not isinstance(override, dict):
        return metadata
    return TierMetadata(
        key=tier,
        display_name=_override_string(override, "display_name", metadata.display_name),
        display_color=_override_string(override, "display_color", metadata.display_color),
        color_code=_override_string(override, "color_code", metadata.color_code),
    )


def _override_string(override: dict[str, Any], key: str, default: str) -> str:
    """Return a non-empty string override value or the default."""

    value = override.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else default


ORDERED_TIERS: Final[tuple[Tier, ...]] = tuple(Tier)

_DEFAULT_TIER_METADATA: Final[dict[Tier, TierMetadata]] = {
    Tier.LT5: TierMetadata(
        key=Tier.LT5,
        display_name="Low Tier 5",
        display_color="dark_gray",
        color_code="§8",
    ),
    Tier.HT5: TierMetadata(
        key=Tier.HT5,
        display_name="High Tier 5",
        display_color="gray",
        color_code="§7",
    ),
    Tier.LT4: TierMetadata(
        key=Tier.LT4,
        display_name="Low Tier 4",
        display_color="dark_green",
        color_code="§2",
    ),
    Tier.HT4: TierMetadata(
        key=Tier.HT4,
        display_name="High Tier 4",
        display_color="green",
        color_code="§a",
    ),
    Tier.LT3: TierMetadata(
        key=Tier.LT3,
        display_name="Low Tier 3",
        display_color="dark_aqua",
        color_code="§3",
    ),
    Tier.HT3: TierMetadata(
        key=Tier.HT3,
        display_name="High Tier 3",
        display_color="aqua",
        color_code="§b",
    ),
    Tier.LT2: TierMetadata(
        key=Tier.LT2,
        display_name="Low Tier 2",
        display_color="gold",
        color_code="§6",
    ),
    Tier.HT2: TierMetadata(
        key=Tier.HT2,
        display_name="High Tier 2",
        display_color="yellow",
        color_code="§e",
    ),
    Tier.LT1: TierMetadata(
        key=Tier.LT1,
        display_name="Low Tier 1",
        display_color="red",
        color_code="§c",
    ),
    Tier.HT1: TierMetadata(
        key=Tier.HT1,
        display_name="High Tier 1",
        display_color="dark_red",
        color_code="§4",
    ),
}

TIER_METADATA: Final[dict[Tier, TierMetadata]] = {
    tier: _override_metadata(tier, metadata)
    for tier, metadata in _DEFAULT_TIER_METADATA.items()
}

VALID_TIER_KEYS: Final[frozenset[str]] = frozenset(tier.value for tier in ORDERED_TIERS)


def get_tier_metadata(tier: Tier) -> TierMetadata:
    """Return display metadata for a valid tier."""

    return TIER_METADATA[tier]
