"""Player tier assignment model."""

from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, Enum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.tiers import Tier
from app.db.base import Base


class PlayerTier(Base):
    """Mapping between a Minecraft username, Discord user, and assigned tier."""

    __tablename__ = "player_tiers"
    __table_args__ = (
        CheckConstraint(
            "minecraft_username_lower = lower(minecraft_username)",
            name="minecraft_username_lower_normalized",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    minecraft_username: Mapped[str] = mapped_column(String(16), nullable=False)
    minecraft_username_lower: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    discord_user_id: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    tier: Mapped[Tier] = mapped_column(
        Enum(Tier, name="player_tier", native_enum=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
