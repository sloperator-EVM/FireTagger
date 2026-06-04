"""Create player tier and audit log tables."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0001_player_tiers_audit_logs"
down_revision = None
branch_labels = None
depends_on = None

PLAYER_TIER_VALUES = (
    "LT5",
    "HT5",
    "LT4",
    "HT4",
    "LT3",
    "HT3",
    "LT2",
    "HT2",
    "LT1",
    "HT1",
)
player_tier_enum = postgresql.ENUM(*PLAYER_TIER_VALUES, name="player_tier", create_type=False)


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM(*PLAYER_TIER_VALUES, name="player_tier").create(bind, checkfirst=True)

    op.create_table(
        "player_tiers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minecraft_username", sa.String(length=16), nullable=False),
        sa.Column("minecraft_username_lower", sa.String(length=16), nullable=False),
        sa.Column("discord_user_id", sa.String(length=32), nullable=False),
        sa.Column("tier", player_tier_enum, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "minecraft_username_lower = lower(minecraft_username)",
            name=op.f("ck_player_tiers_minecraft_username_lower_normalized"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_player_tiers")),
        sa.UniqueConstraint("discord_user_id", name=op.f("uq_player_tiers_discord_user_id")),
        sa.UniqueConstraint(
            "minecraft_username_lower", name=op.f("uq_player_tiers_minecraft_username_lower")
        ),
    )
    op.execute(
        """
        CREATE FUNCTION set_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_player_tiers_updated_at
        BEFORE UPDATE ON player_tiers
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at()
        """
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("actor", sa.String(length=128), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("minecraft_username", sa.String(length=16), nullable=True),
        sa.Column("discord_user_id", sa.String(length=32), nullable=True),
        sa.Column("old_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("new_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_logs")),
    )


def downgrade() -> None:
    op.drop_table("audit_logs")
    op.execute("DROP TRIGGER IF EXISTS trg_player_tiers_updated_at ON player_tiers")
    op.drop_table("player_tiers")
    op.execute("DROP FUNCTION IF EXISTS set_updated_at()")
    postgresql.ENUM(*PLAYER_TIER_VALUES, name="player_tier").drop(op.get_bind(), checkfirst=True)
