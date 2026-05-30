# Minecraft Tier Tagger System – Complete Architecture

## Project Overview

A Discord-based admin system for managing player tiers. All administration happens via slash commands in a privileged Discord channel. The system automatically syncs tiers to two places: Discord roles (for server permissions and identity) and a Minecraft client-side mod (for in-game nameplate display). No website or web admin panel is required.

## Tier System

Tiers are ordered from lowest to highest skill level:

- LT5 – Low Tier 5 (Beginner)
- HT5 – High Tier 5 (Novice)
- LT4 – Low Tier 4 (Intermediate Low)
- HT4 – High Tier 4 (Intermediate High)
- LT3 – Low Tier 3 (Advanced Low)
- HT3 – High Tier 3 (Advanced High)
- LT2 – Low Tier 2 (Expert Low)
- HT2 – High Tier 2 (Expert High)
- LT1 – Low Tier 1 (Master Low)
- HT1 – High Tier 1 (Master – Best)

Each tier has an associated display color and a corresponding Discord role that must exist in the server.

---

## Component 1 – Database

The system needs a single database to store the mapping between Minecraft usernames, Discord user IDs, and their assigned tier.

### Required Data

- Minecraft username (unique)
- Discord user ID (unique)
- Assigned tier (must be one of the ten valid values)
- Timestamps for when the record was created and last updated

### Optional Data

- An audit log table that records every assignment, update, and removal. This log should store who performed the action, what action was taken, what the old and new values were, and when it happened.

### No other data storage is needed.

---

## Component 2 – REST API

A lightweight API sits between the database, the Discord bot, and the Minecraft mod. The API has two categories of endpoints.

### Public Endpoints (no authentication)

These are called by the Minecraft mod:

- Get a single player's tier by Minecraft username. Returns the tier, a display name, and a color code. Returns a not-found response if the player does not exist.
- Get all player tiers at once. Returns a complete mapping of usernames to tier data, plus a timestamp of when the data was last updated.

### Admin Endpoints (require an API key)

These are called by the Discord bot:

- Assign a tier to a player. Creates a new record linking a Minecraft username, a Discord user ID, and a tier. Returns a conflict error if the player already exists.
- Update an existing player's tier. Changes the tier for a given Minecraft username.
- Remove a player entirely. Deletes the record for that Minecraft username.

### Rate Limiting

Public endpoints should be rate-limited to prevent abuse. Admin endpoints should have stricter limits since they are only used by the bot.

---

## Component 3 – Discord Bot

The Discord bot is the admin interface. It listens for slash commands in a specific channel and only responds to users who have a designated Tester role.

### Bot Permissions Required

- Manage Roles (to assign and remove tier roles)
- Send Messages and Read Message History (to respond in the admin channel)
- View Channel and Use Slash Commands

### Configuration the Bot Needs

- Which channel is the admin channel (commands only work here)
- Which role ID represents the Tester role (only these users can run commands)
- Which channel is the log channel (where system messages and errors go)
- A mapping of each tier (LT5 through HT1) to its corresponding Discord role ID
- The URL of the API and the API key for authentication

### Slash Commands

/tier assign

Takes a Minecraft username, a Discord user mention, and a tier. The bot validates the tier, checks that the Discord user is in the server, removes any existing tier role from that user, adds the new tier role, then tells the API to store or update the mapping. It sends a confirmation message back to the admin channel.

/tier remove

Takes a Minecraft username. The bot looks up that player in the API, retrieves their Discord user ID, removes the tier role from that Discord user, then tells the API to delete the mapping. It sends a confirmation message back to the admin channel.

/tier list

Shows all current tier assignments as a paginated list in an embed. No arguments required.

/tier lookup

Takes a Minecraft username and shows that player's tier, their linked Discord user, and when the assignment was last updated.

/tier sync

Fetches the entire player list from the API and ensures every Discord user has exactly the role that matches their stored tier. Removes incorrect roles and adds missing ones. Reports a summary of changes to the admin channel.

/tier bulk-assign

Accepts a JSON file attachment containing an array of assignments. Each item includes a Minecraft username, a Discord user ID, and a tier. The bot processes the entire file, applying all assignments and reporting successes and failures.

### Behavior Rules

- All commands must be ignored if the user does not have the Tester role.
- All commands must be ignored if they are not used in the designated admin channel.
- The bot should never allow a user to have more than one tier role at a time.
- Every admin action should be logged to the log channel, including who did what, when, and to whom.
- Any errors or warnings from the API or Discord API must be sent to the log channel, not to the admin channel where the command was issued (unless the error directly prevents completing the command, in which case a user-friendly message goes to the admin channel and the detailed error goes to the log channel).

---

## Component 4 – Minecraft Mod (Client-Side)

A Fabric-based client-side mod that displays tier tags in the game. The mod does not require installation on the server and works on any server the player joins.

### Core Behavior

When the game launches, the mod makes an HTTP request to the API's "get all" endpoint and downloads the complete tier mapping. It stores this data in memory. The mod automatically refreshes this cache at a regular interval (for example, every 5 minutes). The player can manually force a refresh at any time.

### Display Features

The mod hooks into two places in the Minecraft renderer:

- Nametags: When a player's nametag is rendered above their head, the mod inserts a colored tier suffix to the right of the nickname. The format is [ TIER ] with a space before the opening bracket and a space after the closing bracket. For example, a player named Technoblade with HT1 tier would display as "Technoblade [ HT1 ]". The brackets and the tier text use the tier's assigned color. The nickname remains its normal color.
- Tab list (player list): The mod adds the same [ TIER ] suffix to the right of each player's name in the tab list.

The suffix is only shown for players who have a tier in the cache.

### Player Commands

/tier lookup

Takes a player's name and displays their tier if found. This is useful for checking players who are not currently online.

/tier reload

Forces the mod to immediately re-fetch the entire tier mapping from the API, bypassing the normal refresh interval.

/tier toggle nametag

Turns the nametag suffix display on or off without needing to restart the game.

/tier toggle tablist

Turns the tab list suffix display on or off.

/tier status

Shows the current API URL, when the cache was last updated, how many players are in the cache, and whether the API is reachable.

### Configuration Options (via Mod Menu)

The player can change the following settings through a config screen:

- The API URL (default points to localhost or a configurable address)
- The refresh interval in minutes
- Whether nametag suffixes are enabled
- Whether tab list suffixes are enabled
- Whether to show the player's own tier suffix on their own nametag
- Custom colors for each tier (using Minecraft's formatting codes)

### Offline and Error Handling

If the API is unreachable at launch, the mod starts with an empty cache. No message is shown to the player in chat. Instead, the mod writes a warning to the game log (console) and optionally to a dedicated mod log file.

If the API becomes unreachable after launch, the mod continues using the last cached data and writes a warning to the game log. The player can see the staleness by using /tier status, but the mod never spams the player with "DB IS DOWN" or similar messages in chat.

If a refresh attempt fails, the mod silently keeps the existing cache. The failure is recorded only in the logs. The next refresh attempt happens at the next scheduled interval.

The mod must never crash the game due to network errors or malformed API responses.

### Logging Channel Integration Note

The mod itself does not send messages to Discord. That is the bot's responsibility. However, when designing the bot, all API connectivity issues (timeouts, HTTP errors, rate limiting from the API) must be logged to the designated log channel so administrators know when the API is having problems, without those errors appearing in the admin command channel.

---

## Component 5 – Deployment Architecture

All components can run on a single server or virtual private server.

### Deployment Options

Option A – Docker Compose

A docker-compose file spins up the database container and the API container. The Discord bot runs separately, either on the same server or on a different machine, since it needs persistent access to Discord's gateway.

Option B – Bare Metal or VM

The database and API run as system services on the same machine. The Discord bot runs as another service or as a background process.

### Environment Variables Needed

The API needs:

- A database connection string
- An API key for admin authentication

The Discord bot needs:

- Discord bot token
- Discord client ID
- Guild (server) ID
- Admin channel ID
- Tester role ID
- Log channel ID
- All ten tier role IDs
- API URL
- API key

### No External Cloud Dependencies

The system is designed to run entirely on infrastructure you control. No third-party services except Discord itself are required.

---

## Data Flow – Complete Example

An admin with the Tester role types in the admin channel:

/tier assign Technoblade @Techno HT1

The Discord bot receives the command, validates the admin's role and the channel, then:

1. Checks that @Techno is in the server.
2. Removes any existing tier role from @Techno.
3. Adds the HT1 role to @Techno.
4. Calls the API's assign or update endpoint with Technoblade, Techno's Discord ID, and HT1.
5. The API stores the mapping in the database.
6. The bot replies with a confirmation embed in the admin channel.
7. The bot sends a log entry to the log channel: "Admin X assigned HT1 to Technoblade (@Techno)".

Later, the player Technoblade launches Minecraft with the tier tagger mod installed. The mod:

1. Calls GET /api/v1/tiers/Technoblade or fetches the full list.
2. Receives back HT1 with its display name and color code.
3. Renders "Technoblade [ HT1 ]" above his character's head, with HT1 in dark red inside the brackets.
4. Shows the same suffix next to his name in the tab list.

If the API becomes unreachable for any reason:

- The Discord bot logs "API unreachable at 2025-01-15T10:30:00Z" to the log channel, but the admin channel sees no interruption.
- The Minecraft mod writes a warning to its log file and continues using cached data. The player sees no chat message.

If another admin runs /tier sync later, the bot ensures every Discord user's roles perfectly match the database and logs the results to the log channel.

---

## Security Principles

- The API key must be kept secret and only shared between the API and the Discord bot.
- The Discord bot must have exactly the permissions it needs and no more.
- The bot role must be positioned above all tier roles in Discord's role hierarchy; otherwise it cannot assign or remove them.
- All database queries must be parameterized to prevent injection attacks.
- Public API endpoints should have rate limits to prevent scraping or denial of service.
- Admin API endpoints should authenticate every request using the API key, typically via a header.

---

## Error Handling Philosophy

- Fail gracefully: If the API is down, the mod still runs using cached data. The bot logs the issue but continues operating.
- Fail silently to players, loudly to operators: Players never see "DB IS DOWN" messages. All infrastructure errors go to the Discord log channel and the server console logs.
- Log everything of relevance: The API logs all requests and errors. The Discord bot logs all admin actions and all API failures. The mod logs to the game console but never to player chat unless the player explicitly requests status.
- Validate early: The bot validates all inputs before touching Discord roles or the API. The API validates all inputs before touching the database.

---

## Deliverables

A complete implementation includes:

1. Database schema definition
2. REST API server with all documented endpoints
3. Discord bot with all slash commands, role management logic, and dual-channel output (admin channel for responses, log channel for system messages)
4. Minecraft Fabric mod with rendering hooks (suffix to the right of nickname in format [ TIER ]), caching, commands, and configuration screen
5. Deployment configuration (docker-compose or system service examples)
6. Setup documentation covering Discord role setup, bot invitation, configuration, and installation steps for players

All components must function together as a unified system where adding a tier in Discord immediately updates both Discord roles and in-game displays. The mod must never spam the player with database error messages. All such errors must go only to logs and the Discord log channel.
