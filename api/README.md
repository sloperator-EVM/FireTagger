# FireTagger API Backend

This directory contains the FastAPI backend for FireTagger tier lookups and authenticated tier administration.

## Configuration

The API is configured through environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger` | SQLAlchemy database URL. |
| `ADMIN_API_KEY` | `change-me` | API key required for `/admin/*` mutations via `X-API-Key`. |
| `PUBLIC_LOOKUP_RATE_LIMIT` | `120` | Requests per rate-limit window for `GET /tiers/{minecraft_username}`. |
| `PUBLIC_MAPPING_RATE_LIMIT` | `12` | Requests per rate-limit window for `GET /tiers`. |
| `ADMIN_RATE_LIMIT` | `10` | Requests per rate-limit window for admin routes. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Shared sliding-window length for API rate limits. |
| `CORS_ORIGINS` | empty | Comma-separated browser origins; CORS middleware is only enabled when this is set. |
| `TIER_COLOR_OVERRIDES` | `{}` | Optional JSON object keyed by tier, e.g. `{"HT1":{"display_color":"dark_red","color_code":"§4"}}`. |
| `DATABASE_STARTUP_CHECK` | `true` | Run a database connectivity check before serving requests. |

## Local development

Install the API dependencies and run migrations from this directory:

```bash
python -m pip install -r requirements.txt
export DATABASE_URL="postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger"
alembic upgrade head
```

Start the API with Uvicorn:

```bash
uvicorn app.main:app --reload
```

The app exposes:

- `GET /health` for service and database health.
- `GET /tiers/{minecraft_username}` and `GET /tiers` for public tier reads.
- `/admin/tiers` routes for authenticated administrative mutations.

API errors use a stable `{"error", "message", "details"}` envelope so future Discord bot behavior can consume responses and forward unexpected failures to `#tagger-logs`.

## Docker Compose

From the repository root, provide a non-default admin key and start PostgreSQL plus the API:

```bash
ADMIN_API_KEY="replace-me" docker compose up --build
```

## Database migrations

The initial migration creates the `player_tiers` and `audit_logs` tables plus the PostgreSQL `player_tier` enum.
