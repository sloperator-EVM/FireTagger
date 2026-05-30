# FireTagger API Backend

This directory contains the backend database foundation for the FireTagger API.

## Database migrations

Install the API dependencies, set `DATABASE_URL` to a PostgreSQL connection string, and run Alembic from this directory:

```bash
python -m pip install -r requirements.txt
export DATABASE_URL="postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger"
alembic upgrade head
```

The initial migration creates the `player_tiers` and `audit_logs` tables plus the PostgreSQL `player_tier` enum.
