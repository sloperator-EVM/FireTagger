# FireTagger API Backend

FastAPI backend for FireTagger tier lookups and authenticated tier administration.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger` | SQLAlchemy database URL. |
| `ADMIN_API_KEY` | `change-me` | API key required for `/admin/*` routes via `X-API-Key`. |
| `PUBLIC_LOOKUP_RATE_LIMIT` | `120` | Requests per rate-limit window for `GET /tiers/{minecraft_username}`. |
| `PUBLIC_MAPPING_RATE_LIMIT` | `12` | Requests per rate-limit window for `GET /tiers`. |
| `ADMIN_RATE_LIMIT` | `10` | Requests per rate-limit window for admin routes. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Shared sliding-window length for API rate limits. |
| `CORS_ORIGINS` | empty | Comma-separated browser origins. |
| `TIER_COLOR_OVERRIDES` | `{}` | Optional JSON object keyed by tier. |
| `DATABASE_STARTUP_CHECK` | `true` | Run a database connectivity check before serving requests. |

## Local development

```bash
python -m pip install -r requirements.txt
export DATABASE_URL="postgresql+psycopg://firetagger:firetagger@localhost:5432/firetagger"
alembic upgrade head
uvicorn app.main:app --reload
```

## Routes

- `GET /health`
- `GET /tiers/{minecraft_username}`
- `GET /tiers`
- `GET /admin/tiers`
- `GET /admin/tiers/{minecraft_username}`
- `POST /admin/tiers`
- `PATCH /admin/tiers/{minecraft_username}`
- `DELETE /admin/tiers/{minecraft_username}`

Admin routes require `X-API-Key`.

## Docker Compose

From the repository root:

```bash
cp .env.example .env
docker compose up -d --build postgres api
```

The API image runs migrations automatically at container startup.
