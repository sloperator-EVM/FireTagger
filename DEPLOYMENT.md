# FireTagger deployment

## Fast free permanent choice

Use an Oracle Cloud Always Free Arch Linux VM. Create an Ampere A1 VM if available, attach the default boot volume, and open ports 22, 80, and 443. Oracle's Always Free resources are free for the life of the account, but idle Always Free compute can be reclaimed, so keep backups of the repository and Postgres data.

## One-time Arch Linux VM setup

```bash
sudo pacman -Syu --needed --noconfirm git
git clone <YOUR_REPO_URL> FireTagger
cd FireTagger
chmod +x deploy/oracle-archlinux-setup.sh
./deploy/oracle-archlinux-setup.sh
```

Log out and SSH back in so your user is in the Docker group.

## Configure secrets

```bash
cd FireTagger
cp .env.example .env
nano .env
```

Set these before starting anything:

- `POSTGRES_PASSWORD`
- `ADMIN_API_KEY`
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `TESTER_ROLE_ID`
- all ten `TIER_ROLE_*` values

The bot is already configured for:

- `ADMIN_CHANNEL_ID=1510325369209753694` for `#tagger-panel`
- `LOG_CHANNEL_ID=1510325207103967475` for `#tagger-logs`

## Start API and database

```bash
docker compose up -d --build postgres api
```

The API container runs `alembic upgrade head` automatically before Uvicorn starts.

Check it:

```bash
curl http://127.0.0.1:8000/health
```

Test an admin write:

```bash
curl -X POST http://127.0.0.1:8000/admin/tiers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -d '{"minecraft_username":"Technoblade","discord_user_id":"123456789012345678","tier":"HT1","actor":"manual-test"}'
```

Test a public read:

```bash
curl http://127.0.0.1:8000/tiers/Technoblade
```

## Add HTTPS with Caddy

Point a DNS A record such as `api.yourdomain.com` to the VM public IP.

```bash
sudo pacman -S --needed --noconfirm caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
api.yourdomain.com {
    reverse_proxy 127.0.0.1:8000
}
CADDY
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Your public API URL is then:

```text
https://api.yourdomain.com
```

The Minecraft mod should use the HTTPS URL. The bot can keep using `BOT_API_URL=http://api:8000` inside Docker Compose.

## Start the bot

Make sure your Discord application is invited with the `bot` and `applications.commands` scopes and the bot has Manage Roles. The bot's highest role must be above every tier role.

```bash
docker compose --profile bot up -d --build bot
```

Check logs:

```bash
docker compose logs -f bot
```

## Updating after code changes

```bash
git pull
docker compose up -d --build postgres api
docker compose --profile bot up -d --build bot
```

## Backups

Run this regularly:

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-firetagger}" "${POSTGRES_DB:-firetagger}" > "backups/firetagger-$(date +%Y%m%d-%H%M%S).sql"
```

Restore with:

```bash
cat backups/YOUR_BACKUP.sql | docker compose exec -T postgres psql -U "${POSTGRES_USER:-firetagger}" "${POSTGRES_DB:-firetagger}"
```
