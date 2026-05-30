"""Application configuration for the API service."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from typing import Any


def _env_bool(name: str, default: bool) -> bool:
    """Parse a boolean environment variable with a safe default."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "t", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    """Parse a positive integer environment variable with a safe default."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        parsed_value = int(raw_value)
    except ValueError:
        return default
    return parsed_value if parsed_value > 0 else default


def _env_list(name: str) -> tuple[str, ...]:
    """Parse a comma-separated environment variable into a tuple of strings."""

    raw_value = os.getenv(name, "")
    return tuple(value.strip() for value in raw_value.split(",") if value.strip())


def _env_json_object(name: str) -> dict[str, Any]:
    """Parse a JSON object from an environment variable, ignoring invalid values."""

    raw_value = os.getenv(name)
    if not raw_value:
        return {}
    try:
        parsed_value = json.loads(raw_value)
    except json.JSONDecodeError:
        return {}
    return parsed_value if isinstance(parsed_value, dict) else {}


@dataclass(frozen=True)
class Settings:
    """Runtime settings loaded from environment variables."""

    app_name: str = os.getenv("APP_NAME", "FireTagger API")
    environment: str = os.getenv("ENVIRONMENT", "development")
    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger",
    )
    admin_api_key: str = os.getenv("ADMIN_API_KEY", os.getenv("API_KEY", "change-me"))
    public_lookup_rate_limit: int = field(
        default_factory=lambda: _env_int("PUBLIC_LOOKUP_RATE_LIMIT", 120)
    )
    public_mapping_rate_limit: int = field(
        default_factory=lambda: _env_int("PUBLIC_MAPPING_RATE_LIMIT", 12)
    )
    admin_rate_limit: int = field(default_factory=lambda: _env_int("ADMIN_RATE_LIMIT", 10))
    rate_limit_window_seconds: int = field(
        default_factory=lambda: _env_int("RATE_LIMIT_WINDOW_SECONDS", 60)
    )
    cors_origins: tuple[str, ...] = field(default_factory=lambda: _env_list("CORS_ORIGINS"))
    tier_color_overrides: dict[str, Any] = field(
        default_factory=lambda: _env_json_object("TIER_COLOR_OVERRIDES")
    )
    database_startup_check: bool = field(
        default_factory=lambda: _env_bool("DATABASE_STARTUP_CHECK", True)
    )

    @property
    def api_key(self) -> str:
        """Backward-compatible alias for code still referring to the admin API key."""

        return self.admin_api_key


settings = Settings()
