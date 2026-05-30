"""Application configuration for the API service."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    """Runtime settings loaded from environment variables."""

    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger",
    )
    api_key: str = os.getenv("API_KEY", "change-me")


settings = Settings()
