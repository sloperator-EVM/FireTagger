console.log("🔥 BOT STARTING (RAILWAY 24/7 READY)");

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActivityType,
  MessageFlags
} = require("discord.js");
const fs = require("fs");

// ================= PERSISTENCE =================
const QUEUES_FILE = "./queues.json";
const COOLDOWNS_FILE = "./cooldowns.json";

function saveQueues() {
  try {
    // Persist queue contents, mm queue contents, AND open/closed state per mode
    fs.writeFileSync(QUEUES_FILE, JSON.stringify({ queues, mmQueues, open }, null, 2));
  } catch (e) {
    console.log("❌ Failed to save queues:", e);
  }
}

function loadQueues() {
  try {
    if (!fs.existsSync(QUEUES_FILE)) return;
    const data = JSON.parse(fs.readFileSync(QUEUES_FILE, "utf8"));
    for (const m of MODES) {
      if (data.queues?.[m])   queues[m]   = data.queues[m];
      if (data.mmQueues?.[m]) mmQueues[m] = data.mmQueues[m];
      // Restore open/closed state — default to false (closed) if not saved
      if (typeof data.open?.[m] === "boolean") open[m] = data.open[m];
    }
    console.log("✅ Queues restored from", QUEUES_FILE);
  } catch (e) {
    console.log("❌ Failed to load queues:", e);
  }
}

// cooldowns[userId][kit] = ISO timestamp of when result was posted
let cooldowns = {};

function saveCooldowns() {
  try {
    fs.writeFileSync(COOLDOWNS_FILE, JSON.stringify(cooldowns, null, 2));
  } catch (e) {
    console.log("❌ Failed to save cooldowns:", e);
  }
}

function loadCooldowns() {
  try {
    if (!fs.existsSync(COOLDOWNS_FILE)) return;
    cooldowns = JSON.parse(fs.readFileSync(COOLDOWNS_FILE, "utf8"));
    console.log("✅ Cooldowns restored from", COOLDOWNS_FILE);
  } catch (e) {
    console.log("❌ Failed to load cooldowns:", e);
  }
}

const COOLDOWN_DAYS = 10;
const QUEUE_LIMIT   = 10;

function getCooldownRemaining(userId, kit) {
  const ts = cooldowns[userId]?.[kit];
  if (!ts) return 0;
  const elapsed = Date.now() - new Date(ts).getTime();
  const remaining = COOLDOWN_DAYS * 24 * 60 * 60 * 1000 - elapsed;
  return remaining > 0 ? remaining : 0;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days)    parts.push(`${days}d`);
  if (hours)   parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.length ? parts.join(" ") : "< 1m";
}

/**
 * Replies ephemerally and auto-deletes the reply after `delayMs` milliseconds.
 * Discord does not expose a native TTL for ephemeral messages, so we delete
 * the interaction reply programmatically after the timeout.
 *
 * @param {import("discord.js").Interaction} interaction
 * @param {object} replyOptions  - Options passed to interaction.reply() (must NOT include flags)
 * @param {number} [delayMs=4000] - How long to wait before deleting (default 4 s)
 */
async function replyEphemeralTimed(interaction, replyOptions, delayMs = 4000) {
  await interaction.reply({ ...replyOptions, flags: MessageFlags.Ephemeral });
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (_) {
      // Message may already be gone — silently ignore
    }
  }, delayMs);
}

// ================= CONFIG =================
const TOKEN = process.env.TOKEN;

const CLIENT_ID = "1488564910169522226";
const GUILD_ID = "1484848366029508610";

const PANEL_CHANNEL_ID = "1488885889504510043";
const MATCH_CHANNEL_ID = "1488908557305909339";
const RESULTS_CHANNEL_ID = "1488563059529224222";
const HIGH_RESULTS_CHANNEL_ID = "1488563522173534439";
const LOGS_CHANNEL_ID = "1490708282397036687";


const TESTER_ROLE_ID = "1488581744616804623";


const MODES = ["axe","mace","sword","diapot","nethpot","uhc","smp","cpvp"];
const TIERS = ["HT5","LT5","HT4","LT4","HT3","LT3","HT2","LT2","HT1","LT1"];

// Tiers that are HT1–HT3 and LT1–LT3 — results go to the high results channel
const HIGH_TIERS = new Set(["HT1","HT2","HT3","LT1","LT2","LT3"]);

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]
});

// ================= STATE =================
let queues = {};
let mmQueues = {};
let open = {};
let panelMsg = null;
let mmPanel = null;
let activeDuels = new Map();
let mmDuels = new Map();      // channelId → { p1, p2, mode }
let playerQueues = {};        // userId → mode they are in (tier queue)
let playerMmQueues = {};      // userId → mode they are in (mm queue)

for (const m of MODES) {
  queues[m] = [];
  mmQueues[m] = [];
  open[m] = false;
}

loadQueues();
loadCooldowns();

// ================= SAFETY (RAILWAY FIX) =================
process.on("unhandledRejection", (err) => {
  console.log("❌ UNHANDLED:", err);
});

process.on("uncaughtException", (err) => {
  console.log("❌ CRASH:", err);
});

// ================= STATUS =================
async function setStatus() {
  try {
    // Use the in-memory cache — no API call, no rate-limit impact.
    // guild.members.fetch() every 15 s would exhaust Discord's rate limit
    // and block commands like /take that also need to fetch members.
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    const testerCount = guild.members.cache.filter(m =>
      m.roles.cache.has(TESTER_ROLE_ID)
    ).size;

    client.user.setActivity(`Testers: ${testerCount}`, {
      type: ActivityType.Watching
    });
  } catch (e) {
    console.log("status error", e);
  }
}

// ================= PANEL =================
async function updatePanel() {
  console.log(`🔄 updatePanel: fetching panel channel ${PANEL_CHANNEL_ID}…`);
  let ch;
  try {
    ch = await client.channels.fetch(PANEL_CHANNEL_ID);
  } catch (e) {
    console.log(`❌ updatePanel: cannot fetch panel channel ${PANEL_CHANNEL_ID}:`, e.message);
    throw e;
  }
  console.log(`✅ updatePanel: panel channel fetched (${ch.name})`);

  const totalOpen    = MODES.filter(m => open[m]).length;
  const totalQueued  = MODES.reduce((s, m) => s + queues[m].length, 0);

  const embed = new EmbedBuilder()
    .setTitle("╔══════ 🎮  TIER TESTING QUEUE  🎮 ══════╗")
    .setDescription(
      "**Welcome to the Tier Testing Queue!**\n" +
      "Click a mode button below to join its queue and get tested by one of our testers.\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      `> 🟢 **Open Modes:** ${totalOpen}/${MODES.length}   ·   👥 **Total Queued:** ${totalQueued}`
    )
    .setColor(0x5865F2)
    .setFooter({ text: "╚══════════════════════════════════════╝  •  Last updated" })
    .setTimestamp();

  // Separator before mode list
  embed.addFields({
    name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    value: "**📋 Queue Status by Mode**",
    inline: false
  });

  for (const m of MODES) {
    const isOpen   = open[m];
    const count    = queues[m].length;
    const statusIcon = isOpen ? "🟢" : "🔴";
    const bar      = buildBar(count, QUEUE_LIMIT);
    const players  = count
      ? queues[m].map((u, idx) => `\`${String(idx + 1).padStart(2, "0")}.\` <@${u}>`).join("\n")
      : "*— empty —*";

    embed.addFields({
      name: `${statusIcon} **${m.toUpperCase()}**  ┃  ${count}/${QUEUE_LIMIT}  ${bar}`,
      value: players,
      inline: true
    });
  }

  // Footer separator field
  embed.addFields({
    name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    value: "🔴 = Closed  ·  🟢 = Open  ·  Use the buttons below to join or leave",
    inline: false
  });

  const rows = [];
  let row = new ActionRowBuilder();

  for (const m of MODES) {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`join_${m}`)
        .setLabel(`${m.toUpperCase()}`)
        .setStyle(open[m] ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!open[m])
    );
  }

  rows.push(row);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("leave")
        .setLabel("🚪 Leave Queue")
        .setStyle(ButtonStyle.Danger)
    )
  );

  // 1. If we already hold a reference, try to edit it directly.
  if (panelMsg) {
    try {
      await panelMsg.edit({ embeds: [embed], components: rows });
      return;
    } catch (e) {
      console.log("⚠️ panelMsg.edit() failed (message may have been deleted), falling back to fetch:", e.message);
      panelMsg = null;
    }
  }

  // 2. No valid in-memory reference — send a fresh panel message.
  // First, verify the bot actually has permission to send messages in this channel.
  try {
    const me = ch.guild?.members?.me ?? await ch.guild?.members?.fetch(client.user.id).catch(() => null);
    if (me) {
      const perms = ch.permissionsFor(me);
      const canView  = perms.has(PermissionsBitField.Flags.ViewChannel);
      const canSend  = perms.has(PermissionsBitField.Flags.SendMessages);
      const canEmbed = perms.has(PermissionsBitField.Flags.EmbedLinks);
      console.log(
        `🔍 updatePanel: bot permissions in #${ch.name} —` +
        ` ViewChannel=${canView}, SendMessages=${canSend}, EmbedLinks=${canEmbed}`
      );
      if (!canView || !canSend) {
        console.log(`❌ updatePanel: bot is missing required permissions in channel ${PANEL_CHANNEL_ID}. Cannot send panel.`);
        return;
      }
    }
  } catch (permErr) {
    console.log("⚠️ updatePanel: could not check permissions:", permErr);
  }

  try {
    console.log(`📤 updatePanel: attempting ch.send() to channel ${PANEL_CHANNEL_ID} (${ch.name})…`);
    panelMsg = await ch.send({ embeds: [embed], components: rows });
    console.log(`✅ updatePanel: sent new panel message (id=${panelMsg.id}).`);
  } catch (e) {
    console.log("❌ updatePanel: failed to send new panel message.");
    console.log("   Error name   :", e.name);
    console.log("   Error message:", e.message);
    console.log("   Error code   :", e.code);
    console.log("   HTTP status  :", e.status);
    console.log("   Full error   :", e);
  }
}

/** Renders a compact progress bar, e.g. ▰▰▰▱▱▱▱▱▱▱ */
function buildBar(current, max) {
  const filled = Math.round((current / max) * 8);
  return "▰".repeat(filled) + "▱".repeat(8 - filled);
}

// ================= MATCH PANEL =================
async function updateMM() {
  console.log(`🔄 updateMM: fetching match channel ${MATCH_CHANNEL_ID}…`);
  let ch;
  try {
    ch = await client.channels.fetch(MATCH_CHANNEL_ID);
  } catch (e) {
    console.log(`❌ updateMM: cannot fetch match channel ${MATCH_CHANNEL_ID}:`, e.message);
    throw e;
  }
  console.log(`✅ updateMM: match channel fetched (${ch.name})`);

  const totalWaiting = MODES.reduce((s, m) => s + mmQueues[m].length, 0);

  const embed = new EmbedBuilder()
    .setTitle("╔══════ ⚔️  MATCHMAKING QUEUE  ⚔️ ══════╗")
    .setDescription(
      "**Welcome to the Matchmaking Queue!**\n" +
      "Click a mode button below to be matched against another player of similar skill.\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      `> ⚔️ **Active Modes:** ${MODES.length}   ·   👥 **Total Waiting:** ${totalWaiting}`
    )
    .setColor(0xE74C3C)
    .setFooter({ text: "╚══════════════════════════════════════╝  •  Last updated" })
    .setTimestamp();

  // Separator before mode list
  embed.addFields({
    name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    value: "**📋 Queue Status by Mode**",
    inline: false
  });

  for (const m of MODES) {
    const count   = mmQueues[m].length;
    const bar     = buildBar(count, Math.max(count, 2));
    const players = count
      ? mmQueues[m].map((u, idx) => `\`${String(idx + 1).padStart(2, "0")}.\` <@${u}>`).join("\n")
      : "*— empty —*";

    embed.addFields({
      name: `⚔️ **${m.toUpperCase()}**  ┃  ${count} waiting  ${bar}`,
      value: players,
      inline: true
    });
  }

  // Footer separator field
  embed.addFields({
    name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    value: "⚔️ = Open for all  ·  Use the buttons below to join or leave",
    inline: false
  });

  const rows = [];
  let row = new ActionRowBuilder();

  for (const m of MODES) {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mm_join_${m}`)
        .setLabel(`${m.toUpperCase()}`)
        .setStyle(ButtonStyle.Primary)
    );
  }

  rows.push(row);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("mm_leave")
        .setLabel("🚪 Leave Matchmaking")
        .setStyle(ButtonStyle.Danger)
    )
  );

  if (!mmPanel) {
    try {
      mmPanel = await ch.send({ embeds: [embed], components: rows });
      console.log(`✅ updateMM: sent new MM panel message (id=${mmPanel.id}).`);
    } catch (e) {
      console.log("❌ updateMM: failed to send MM panel message.");
      console.log("   Error name   :", e.name);
      console.log("   Error message:", e.message);
      console.log("   Error code   :", e.code);
      console.log("   HTTP status  :", e.status);
      console.log("   Full error   :", e);
    }
  } else {
    try {
      await mmPanel.edit({ embeds: [embed], components: rows });
    } catch (e) {
      console.log("⚠️ updateMM: mmPanel.edit() failed:", e.message);
      mmPanel = null;
    }
  }
}

// ================= COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName("open")
    .setDescription("Open a queue for a specific mode (or all modes)")
    .addStringOption(o =>
      o.setName("mode").setDescription("Game mode to open, or \"all\" to open every mode").setRequired(true)
      .addChoices({ name: "all", value: "all" }, ...MODES.map(m=>({name:m,value:m})))),

  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close a queue for a specific mode (or all modes)")
    .addStringOption(o =>
      o.setName("mode").setDescription("Game mode to close, or \"all\" to close every mode").setRequired(true)
      .addChoices({ name: "all", value: "all" }, ...MODES.map(m=>({name:m,value:m})))),

  new SlashCommandBuilder()
    .setName("take")
    .setDescription("Take the next player from a queue for tier testing")
    .addStringOption(o =>
      o.setName("mode").setDescription("Game mode to take from").setRequired(true)
      .addChoices(...MODES.map(m=>({name:m,value:m})))),

  new SlashCommandBuilder()
    .setName("result")
    .setDescription("Post the tier test result for a player")
    .addUserOption(o =>
      o.setName("player").setDescription("The testee (Discord user)").setRequired(true))
    .addStringOption(o =>
      o.setName("ign").setDescription("Testee's in-game name").setRequired(true))
    .addStringOption(o =>
      o.setName("kit").setDescription("Kit that was tested").setRequired(true)
      .addChoices(...MODES.map(m=>({name:m,value:m}))))
    .addStringOption(o =>
      o.setName("score").setDescription("Test score(s) — comma-separated for multiple (e.g. 5-1, 3-2)").setRequired(true))
    .addStringOption(o =>
      o.setName("previous_tier").setDescription("Previous tier or \"N/R\" for no rating").setRequired(true))
    .addStringOption(o =>
      o.setName("current_tier").setDescription("New tier achieved").setRequired(true)
      .addChoices(...TIERS.map(t=>({name:t,value:t}))))
    .addStringOption(o =>
      o.setName("tester").setDescription("Tester(s) who conducted the test — comma-separated mentions or usernames").setRequired(true)),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Spawn or refresh the tier testing queue panel in the panel channel"),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear all messages in the tier test logs channel"),
].map(c=>c.toJSON());
/**
 * Returns true if the member has any of:
 *  - a role named "tester" (case-insensitive) or the known TESTER_ROLE_ID
 *  - the built-in Administrator permission
 *  - is the guild owner
 */
async function isTester(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (interaction.guild.ownerId === interaction.user.id) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (member.roles.cache.has(TESTER_ROLE_ID)) return true;
  if (member.roles.cache.some(r => r.name.toLowerCase() === "tester")) return true;
  return false;
}

// ================= READY =================
const rest = new REST({ version: "10" }).setToken(TOKEN);

// Holds the status interval reference so we can clear it if needed (prevents leaks)
let statusInterval = null;

client.once("ready", async () => {
  console.log("🟢 ONLINE");

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  await updatePanel().catch(e => console.log("❌ ready: updatePanel() threw:", e));
  await updateMM().catch(e => console.log("❌ ready: updateMM() threw:", e));

  // Clear any pre-existing interval before starting a new one (prevents memory
  // leaks if the ready event fires more than once during reconnects)
  if (statusInterval) clearInterval(statusInterval);
  setStatus();
  statusInterval = setInterval(setStatus, 15000);
});

// ================= INTERACTIONS =================

client.on("interactionCreate", async i => {

  if (i.isButton()) {

    // ── Tier queue: join ──────────────────────────────────────────────
    if (i.customId.startsWith("join_")) {
      const m = i.customId.split("_")[1];

      if (!open[m]) {
        return replyEphemeralTimed(i, {
          content: `❌ The **${m.toUpperCase()}** queue is currently closed.`
        });
      }

      // Block if player is currently in an active MM fight
      const inFight = [...mmDuels.values()].some(d => d.p1 === i.user.id || d.p2 === i.user.id);
      if (inFight) {
        return replyEphemeralTimed(i, {
          content: `⚔️ You are currently in an active matchmaking fight. Please finish your fight before joining a queue.`
        });
      }

      if (queues[m].includes(i.user.id)) {
        return replyEphemeralTimed(i, {
          content: `⚠️ You are already in the **${m.toUpperCase()}** queue.`
        });
      }

      if (queues[m].length >= QUEUE_LIMIT) {
        return replyEphemeralTimed(i, {
          content: `⛔ The **${m.toUpperCase()}** queue is full (${QUEUE_LIMIT}/${QUEUE_LIMIT}). Please try again later.`
        });
      }

      const remaining = getCooldownRemaining(i.user.id, m);
      if (remaining > 0) {
        return replyEphemeralTimed(i, {
          content: `⏳ You are on cooldown for **${m.toUpperCase()}**. You can rejoin in **${formatDuration(remaining)}**.`
        });
      }

      // Block if player is already in ANY tier queue
      const currentQueue = playerQueues[i.user.id];
      if (currentQueue) {
        return replyEphemeralTimed(i, {
          content: `⚠️ You are already in the **${currentQueue.toUpperCase()}** tier queue. Please leave that queue first before joining another.`
        });
      }

      queues[m].push(i.user.id);
      playerQueues[i.user.id] = m;
      saveQueues();
      updatePanel();
      return replyEphemeralTimed(i, {
        content: `✅ You joined the **${m.toUpperCase()}** queue! You are **#${queues[m].length}** in line.`
      });
    }

    // ── Tier queue: leave ─────────────────────────────────────────────
    if (i.customId === "leave") {
      const queueMode = playerQueues[i.user.id];
      if (!queueMode) {
        return replyEphemeralTimed(i, { content: "⚠️ You are not currently in any queue." });
      }
      queues[queueMode] = queues[queueMode].filter(x => x !== i.user.id);
      delete playerQueues[i.user.id];

      saveQueues();
      updatePanel();
      return replyEphemeralTimed(i, { content: `✅ You have left the **${queueMode.toUpperCase()}** queue.` });
    }

    // ── Matchmaking: join ─────────────────────────────────────────────
    if (i.customId.startsWith("mm_join_")) {
      const m = i.customId.split("_")[2];

      if (mmQueues[m].includes(i.user.id)) {
        return replyEphemeralTimed(i, {
          content: `⚠️ You are already in the **${m.toUpperCase()}** matchmaking queue.`
        });
      }

      // Block if player is currently in an active MM fight
      const inMmFight = [...mmDuels.values()].some(d => d.p1 === i.user.id || d.p2 === i.user.id);
      if (inMmFight) {
        return replyEphemeralTimed(i, {
          content: `⚔️ You are currently in an active matchmaking fight. Please finish your fight before joining a queue.`
        });
      }

      // Check if player is already in a DIFFERENT mm queue
      const currentMm = playerMmQueues[i.user.id];
      if (currentMm && currentMm !== m) {
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_mm_switch_${m}`)
            .setLabel("Yes, switch queue")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("cancel_mm_switch")
            .setLabel("No, stay")
            .setStyle(ButtonStyle.Secondary)
        );
        return i.reply({
          content: `⚠️ You are already in the **${currentMm.toUpperCase()}** matchmaking queue.\nAre you sure you want to join **${m.toUpperCase()}** instead?`,
          components: [confirmRow],
          flags: MessageFlags.Ephemeral
        });
      }

      mmQueues[m].push(i.user.id);
      playerMmQueues[i.user.id] = m;
      saveQueues();

      // Auto-match: if exactly 2 players are now waiting, create a private fight channel
      if (mmQueues[m].length >= 2) {
        const p1 = mmQueues[m].shift();
        const p2 = mmQueues[m].shift();
        delete playerMmQueues[p1];
        delete playerMmQueues[p2];

        // Kick both players from all tier queues and MM queues
        for (const mode of MODES) {
          queues[mode] = queues[mode].filter(x => x !== p1 && x !== p2);
          mmQueues[mode] = mmQueues[mode].filter(x => x !== p1 && x !== p2);
        }
        delete playerQueues[p1];
        delete playerQueues[p2];

        saveQueues();
        updateMM();
        updatePanel();

        const fightCh = await i.guild.channels.create({
          name: `「⚔️」friendly fight`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: i.guild.id,      deny:  [PermissionsBitField.Flags.ViewChannel] },
            { id: p1,              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: p2,              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: client.user.id,  allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
          ]
        });

        mmDuels.set(fightCh.id, { p1, p2, mode: m, startedAt: new Date().toISOString() });

        const fightRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`mm_end_${fightCh.id}`)
            .setLabel("⚔️ End Fight")
            .setStyle(ButtonStyle.Danger)
        );

        const matchEmbed = new EmbedBuilder()
          .setTitle("╔══════ ⚔️  MATCH FOUND  ⚔️ ══════╗")
          .setDescription(
            `A **${m.toUpperCase()}** matchmaking fight has been created!\n` +
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
          )
          .setColor(0xE74C3C)
          .addFields(
            { name: "🟦 Player 1",  value: `<@${p1}>`,       inline: true },
            { name: "🟥 Player 2",  value: `<@${p2}>`,       inline: true },
            { name: "🎮 Mode",      value: m.toUpperCase(),  inline: true },
            { name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", value: "Click **End Fight** when the match is over.", inline: false }
          )
          .setFooter({ text: "╚══════════════════════════════════════╝  •  Match started" })
          .setTimestamp();

        await fightCh.send({
          content: `<@${p1}> <@${p2}>`,
          embeds: [matchEmbed],
          components: [fightRow]
        });

        return replyEphemeralTimed(i, {
          content: `✅ Match found! Head to <#${fightCh.id}> for your **${m.toUpperCase()}** fight.`
        });
      }

      updateMM();
      return replyEphemeralTimed(i, {
        content: `✅ You joined the **${m.toUpperCase()}** matchmaking queue! Waiting for an opponent…`
      });
    }

    // ── Matchmaking: confirm switch ───────────────────────────────────
    if (i.customId.startsWith("confirm_mm_switch_")) {
      const newMode = i.customId.replace("confirm_mm_switch_", "");
      const oldMode = playerMmQueues[i.user.id];

      // Remove from old mm queue
      if (oldMode) mmQueues[oldMode] = mmQueues[oldMode].filter(x => x !== i.user.id);

      mmQueues[newMode].push(i.user.id);
      playerMmQueues[i.user.id] = newMode;
      saveQueues();

      // Auto-match check after switch
      if (mmQueues[newMode].length >= 2) {
        const p1 = mmQueues[newMode].shift();
        const p2 = mmQueues[newMode].shift();
        delete playerMmQueues[p1];
        delete playerMmQueues[p2];

        // Kick both players from all tier queues and MM queues
        for (const mode of MODES) {
          queues[mode] = queues[mode].filter(x => x !== p1 && x !== p2);
          mmQueues[mode] = mmQueues[mode].filter(x => x !== p1 && x !== p2);
        }
        delete playerQueues[p1];
        delete playerQueues[p2];

        saveQueues();
        updateMM();
        updatePanel();

        const fightCh = await i.guild.channels.create({
          name: `「⚔️」friendly fight`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: i.guild.id,      deny:  [PermissionsBitField.Flags.ViewChannel] },
            { id: p1,              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: p2,              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: client.user.id,  allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
          ]
        });

        mmDuels.set(fightCh.id, { p1, p2, mode: newMode, startedAt: new Date().toISOString() });

        const fightRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`mm_end_${fightCh.id}`)
            .setLabel("⚔️ End Fight")
            .setStyle(ButtonStyle.Danger)
        );

        const matchEmbed = new EmbedBuilder()
          .setTitle("╔══════ ⚔️  MATCH FOUND  ⚔️ ══════╗")
          .setDescription(
            `A **${newMode.toUpperCase()}** matchmaking fight has been created!\n` +
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
          )
          .setColor(0xE74C3C)
          .addFields(
            { name: "🟦 Player 1",  value: `<@${p1}>`,            inline: true },
            { name: "🟥 Player 2",  value: `<@${p2}>`,            inline: true },
            { name: "🎮 Mode",      value: newMode.toUpperCase(), inline: true },
            { name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", value: "Click **End Fight** when the match is over.", inline: false }
          )
          .setFooter({ text: "╚══════════════════════════════════════╝  •  Match started" })
          .setTimestamp();

        await fightCh.send({
          content: `<@${p1}> <@${p2}>`,
          embeds: [matchEmbed],
          components: [fightRow]
        });

        return i.update({
          content: `✅ Switched to **${newMode.toUpperCase()}** — match found! Head to <#${fightCh.id}>.`,
          components: []
        });
      }

      updateMM();
      return i.update({
        content: `✅ Switched from **${oldMode ? oldMode.toUpperCase() : "previous"}** to **${newMode.toUpperCase()}** matchmaking queue! Waiting for an opponent…`,
        components: []
      });
    }

    // ── Matchmaking: cancel switch ────────────────────────────────────
    if (i.customId === "cancel_mm_switch") {
      return i.update({
        content: `✅ Staying in your current matchmaking queue.`,
        components: []
      });
    }

    // ── Matchmaking: leave ────────────────────────────────────────────
    if (i.customId === "mm_leave") {
      for (const m of MODES)
        mmQueues[m] = mmQueues[m].filter(x => x !== i.user.id);
      delete playerMmQueues[i.user.id];

      saveQueues();
      updateMM();
      return replyEphemeralTimed(i, { content: "✅ You have left the matchmaking queue." });
    }

    // ── Matchmaking: end fight ────────────────────────────────────────
    if (i.customId.startsWith("mm_end_")) {
      const duel = mmDuels.get(i.channelId);
      if (!duel) {
        return replyEphemeralTimed(i, { content: "❌ No active fight found for this channel." });
      }

      // Only the two fighters can end the fight
      if (i.user.id !== duel.p1 && i.user.id !== duel.p2) {
        return replyEphemeralTimed(i, { content: "❌ Only the players in this fight can end it." });
      }

      mmDuels.delete(i.channelId);

      const logCh = await client.channels.fetch(LOGS_CHANNEL_ID);
      const startTime = new Date(duel.startedAt);
      const endTime   = new Date();
      const durationMs = endTime - startTime;

      const logEmbed = new EmbedBuilder()
        .setTitle("⚔️ Matchmaking Fight Ended")
        .setDescription(`A **${duel.mode.toUpperCase()}** matchmaking fight has concluded.`)
        .setColor(0xE67E22)
        .addFields(
          { name: "🟦 Player 1",   value: `<@${duel.p1}>`,          inline: true },
          { name: "🟥 Player 2",   value: `<@${duel.p2}>`,          inline: true },
          { name: "🎮 Mode",       value: duel.mode.toUpperCase(),   inline: true },
          { name: "🕐 Started",    value: `<t:${Math.floor(startTime.getTime() / 1000)}:T>`, inline: true },
          { name: "🕑 Ended",      value: `<t:${Math.floor(endTime.getTime() / 1000)}:T>`,  inline: true },
          { name: "⏱️ Duration",   value: formatDuration(durationMs), inline: true },
          { name: "🏁 Ended by",   value: `<@${i.user.id}>`,        inline: true }
        )
        .setFooter({ text: "Matchmaking Fight Log" })
        .setTimestamp();

      await logCh.send({ embeds: [logEmbed] });

      await replyEphemeralTimed(i, { content: "✅ Fight ended. Deleting channel…" }, 3000);

      await i.channel.delete().catch(() => {});

      return;
    }

    // ── Tier testing: end test ────────────────────────────────────────
    if (i.customId.startsWith("end_")) {
      const duel = activeDuels.get(i.channelId);

      // Only the tester (the one who ran /take) can end the test
      if (duel && i.user.id !== duel.tester) {
        return replyEphemeralTimed(i, { content: "❌ Only the tester can end this test." });
      }

      activeDuels.delete(i.channelId);

      await replyEphemeralTimed(i, { content: "✅ Ending test…" }, 3000);

      setTimeout(() => {
        i.channel.delete().catch(() => {});
      }, 1000);
    }
  }

  if (!i.isChatInputCommand()) return;

  // ── Permission guard for admin commands ──────────────────────────────
  const adminCommands = ["open", "close", "take", "result", "panel", "clear"];
  if (adminCommands.includes(i.commandName)) {
    const allowed = await isTester(i);
    if (!allowed) {
      return i.reply({
        content: "❌ You don't have permission to use this command. Only testers, administrators, and the server owner can use it.",
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (i.commandName === "open") {
    const m = i.options.getString("mode");
    console.log(`▶️ /open: invoked by ${i.user.tag} (${i.user.id}) for mode=${m}`);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const modesToOpen = m === "all" ? MODES : [m];
      for (const mode of modesToOpen) open[mode] = true;
      saveQueues();
      console.log(`✅ /open [${m}]: state updated — open flags set`);

      try { await updatePanel(); } catch (e) { console.log("❌ updatePanel error in /open:", e); }

      const label = m === "all" ? "All queues" : `**${m.toUpperCase()}** queue`;
      const openReply = await i.editReply({ content: `✅ ${label} ${m === "all" ? "are" : "is"} now **open**.` });
      setTimeout(() => { openReply.delete().catch(() => {}); }, 1000);

      try {
        const panelCh = await client.channels.fetch(PANEL_CHANNEL_ID);
        const msg = m === "all"
          ? `@here 🟢 All queues are now open! Head to the panel to join.`
          : `@here 🟢 The **${m.toUpperCase()}** queue is now open! Head to the panel to join.`;
        const announcement = await panelCh.send({ content: msg, allowedMentions: { parse: ["everyone"] } });
        setTimeout(() => { announcement.delete().catch(() => {}); }, 5000);
      } catch (e) {
        console.log("❌ Announcement error in /open:", e);
      }

      console.log(`✅ /open [${m}]: command complete`);
    } catch (e) {
      console.log(`❌ /open [${m}]: unexpected error:`, e.message ?? e, e);
      try { await i.editReply({ content: "❌ An unexpected error occurred while opening the queue. Please try again." }); } catch (_) {}
    }

    return;
  }

  if (i.commandName === "close") {
    const m = i.options.getString("mode");
    console.log(`▶️ /close: invoked by ${i.user.tag} (${i.user.id}) for mode=${m}`);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const modesToClose = m === "all" ? MODES : [m];

      // Close each mode and kick all queued players out of that queue
      for (const mode of modesToClose) {
        open[mode] = false;

        // Remove every player from the tier queue for this mode
        for (const userId of queues[mode]) {
          delete playerQueues[userId];
        }
        queues[mode] = [];
      }
      console.log(`✅ /close [${m}]: state updated — queues cleared`);

      saveQueues();
      try { await updatePanel(); } catch (e) { console.log("❌ updatePanel error in /close:", e); }

      const label = m === "all" ? "All queues" : `**${m.toUpperCase()}** queue`;
      const closeReply = await i.editReply({ content: `🔒 ${label} ${m === "all" ? "are" : "is"} now **closed**. All queued players have been removed.` });
      setTimeout(() => { closeReply.delete().catch(() => {}); }, 1000);

      console.log(`✅ /close [${m}]: command complete`);
    } catch (e) {
      console.log(`❌ /close [${m}]: unexpected error:`, e.message ?? e, e);
      try { await i.editReply({ content: "❌ An unexpected error occurred while closing the queue. Please try again." }); } catch (_) {}
    }

    return;
  }

  if (i.commandName === "take") {
    const mode = i.options.getString("mode");
    console.log(`▶️ /take: invoked by ${i.user.tag} (${i.user.id}) for mode=${mode}`);

    // Step 1: Defer reply immediately so the interaction doesn't time out
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    console.log(`✅ /take [${mode}]: reply deferred`);

    try {
      // Step 2: Check queue is not empty
      console.log(`🔍 /take [${mode}]: queue length = ${queues[mode].length}`);
      if (!queues[mode].length) {
        console.log(`❌ /take [${mode}]: queue is empty — aborting`);
        return i.editReply({ content: "❌ The queue is empty." });
      }

      // Step 3: Find first player who is NOT the tester themselves
      const validIndex = queues[mode].findIndex(id => id !== i.user.id);
      console.log(`🔍 /take [${mode}]: validIndex=${validIndex}`);
      if (validIndex === -1) {
        console.log(`❌ /take [${mode}]: no valid player found (only the tester is in queue) — aborting`);
        return i.editReply({ content: "❌ No other players available to test in this queue." });
      }

      const nextPlayer = queues[mode][validIndex];
      console.log(`👤 /take [${mode}]: next player to test = ${nextPlayer}`);

      // Step 4: Check bot permissions BEFORE mutating any state
      console.log(`🔑 /take [${mode}]: checking bot permissions…`);
      const botMember = i.guild.members.me ?? await i.guild.members.fetch(client.user.id).catch(() => null);
      if (!botMember) {
        console.log(`❌ /take [${mode}]: could not resolve bot guild member — aborting`);
        return i.editReply({ content: "❌ Could not resolve bot permissions. Please try again." });
      }
      const botPerms = botMember.permissions;
      const hasManageChannels = botPerms?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
      const hasViewChannel    = botPerms?.has(PermissionsBitField.Flags.ViewChannel)    ?? false;
      const hasSendMessages   = botPerms?.has(PermissionsBitField.Flags.SendMessages)   ?? false;
      console.log(`🔑 /take [${mode}]: ManageChannels=${hasManageChannels}, ViewChannel=${hasViewChannel}, SendMessages=${hasSendMessages}`);
      if (!hasManageChannels) {
        console.log(`❌ /take [${mode}]: bot is missing ManageChannels — cannot create tier test channel`);
        return i.editReply({
          content:
            "❌ **Missing Permissions:** The bot does not have the **Manage Channels** permission and cannot create a tier test channel.\n" +
            "Please ask a server administrator to grant the bot the **Manage Channels** permission, then try again."
        });
      }

      // Step 5: Remove player from queue and persist
      const player = queues[mode].splice(validIndex, 1)[0];
      delete playerQueues[player];
      saveQueues();
      console.log(`✅ /take [${mode}]: removed player ${player} from queue (queue now has ${queues[mode].length} entries)`);

      // Step 6: Determine channel name based on player's current tier role
      console.log(`🔍 /take [${mode}]: fetching player member to check tier role…`);
      const playerMember = await i.guild.members.fetch(player).catch(() => null);
      const playerCurrentTier = playerMember?.roles.cache.find(r => TIERS.includes(r.name))?.name ?? null;
      const isHighTier = playerCurrentTier && HIGH_TIERS.has(playerCurrentTier);
      const testChannelName = isHighTier
        ? `「💎」high-test (${mode})`
        : `「💎」tier test (${mode})`;
      console.log(`📛 /take [${mode}]: channel name = "${testChannelName}" (playerTier=${playerCurrentTier}, isHighTier=${isHighTier})`);

      // Step 7: Create the tier test channel
      console.log(`📁 /take [${mode}]: creating tier test channel…`);

      const permissionOverwrites = [
        { id: i.guild.id,     deny:  [PermissionsBitField.Flags.ViewChannel] },
        { id: player,         allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: i.user.id,      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ];
      console.log(`🔑 /take [${mode}]: permission overwrites IDs = [${permissionOverwrites.map(o => o.id).join(", ")}]`);

      // Step 7a: Find or create the tier test category
      const TIER_TEST_CATEGORY_NAME = "↼⇁ tier-testing ↽⇀";
      let tierTestCategory = i.guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildCategory && ch.name === TIER_TEST_CATEGORY_NAME
      );
      if (tierTestCategory) {
        console.log(`📂 /take [${mode}]: found existing tier test category "${TIER_TEST_CATEGORY_NAME}" (id=${tierTestCategory.id})`);
      } else {
        console.log(`📂 /take [${mode}]: category "${TIER_TEST_CATEGORY_NAME}" not found — creating it…`);
        tierTestCategory = await i.guild.channels.create({
          name: TIER_TEST_CATEGORY_NAME,
          type: ChannelType.GuildCategory,
        });
        console.log(`✅ /take [${mode}]: created tier test category "${TIER_TEST_CATEGORY_NAME}" (id=${tierTestCategory.id})`);
      }

      let testCh;
      try {
        testCh = await i.guild.channels.create({
          name: testChannelName,
          type: ChannelType.GuildText,
          parent: tierTestCategory.id,
          permissionOverwrites,
        });

      } catch (e) {

        console.error(`❌ /take [${mode}]: failed to create channel.`);
        console.error("Full error object:", e);
        console.error("Raw error:", e?.rawError);
        console.error("Request body:", e?.requestBody);
        console.error("Stack:", e?.stack);
        console.error("All error properties:", Object.getOwnPropertyNames(e).reduce((acc, key) => { acc[key] = e[key]; return acc; }, {}));
        // Re-add player to queue so they are not lost
        queues[mode].splice(validIndex, 0, player);
        playerQueues[player] = mode;
        saveQueues();
        console.error(`♻️ /take [${mode}]: re-inserted player ${player} back into queue at index ${validIndex}`);
        return i.editReply({ content: "❌ Failed to create channel. Check logs for details." });
      }
      console.log(`✅ /take [${mode}]: channel created — id=${testCh.id}, name=${testCh.name}`);

      // Step 8: Register active duel
      activeDuels.set(testCh.id, { player, tester: i.user.id, mode, startedAt: new Date().toISOString() });
      console.log(`✅ /take [${mode}]: activeDuels entry added for channel ${testCh.id}`);

      // Step 9: Build and send the embed with End Test button
      console.log(`📤 /take [${mode}]: sending embed to channel ${testCh.id}…`);
      const endRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`end_${testCh.id}`)
          .setLabel("🛑 End Test")
          .setStyle(ButtonStyle.Danger)
      );

      const testEmbed = new EmbedBuilder()
        .setTitle("🧪 Tier Test Started")
        .setDescription(`A **${mode.toUpperCase()}** tier test is now in progress.`)
        .setColor(0x5865F2)
        .addFields(
          { name: "👤 Player",    value: `<@${player}>`,    inline: true },
          { name: "🧑‍⚖️ Tester", value: `<@${i.user.id}>`, inline: true },
          { name: "🎮 Mode",      value: mode.toUpperCase(), inline: true }
        )
        .setFooter({ text: "Click \"End Test\" when the test is complete" })
        .setTimestamp();

      try {
        // @here notifies online members; player + tester mentions ensure they see it
        await testCh.send({
          content: `<@${player}> @here <@${i.user.id}>`,
          embeds: [testEmbed],
          components: [endRow],
          allowedMentions: { parse: ["everyone"], users: [player, i.user.id] }
        });

        console.log(`✅ /take [${mode}]: embed sent to channel ${testCh.id}`);
      } catch (e) {
        console.log(`❌ /take [${mode}]: failed to send embed to channel ${testCh.id}:`, e);
        // Channel exists and duel is registered — still continue so the tester gets the link
      }

      // Step 10: Update the queue panel
      console.log(`🔄 /take [${mode}]: updating panel…`);
      try {
        await updatePanel();
        console.log(`✅ /take [${mode}]: panel updated`);
      } catch (e) {
        console.log(`❌ /take [${mode}]: updatePanel error (non-fatal):`, e);
      }

      // Step 11: Reply with success and channel link
      console.log(`✅ /take [${mode}]: all steps complete — replying with channel link`);
      return i.editReply({ content: `✅ Tier test channel created: <#${testCh.id}>` });

    } catch (e) {
      console.log(`❌ /take [${mode}]: unexpected error:`, e.message ?? e);
      console.log(e);
      try {
        return i.editReply({ content: "❌ An unexpected error occurred. Please try again." });
      } catch (_) {}
    }
  }


  if (i.commandName === "result") {
    const player      = i.options.getUser("player");
    const ign         = i.options.getString("ign");
    const kit         = i.options.getString("kit");
    const scoreRaw    = i.options.getString("score");
    const prevTier    = i.options.getString("previous_tier");
    const currentTier = i.options.getString("current_tier");
    const testerRaw   = i.options.getString("tester");

    console.log(`▶️ /result: invoked by ${i.user.tag} (${i.user.id}) — player=${player?.id}, kit=${kit}, tier=${currentTier}`);

    // ── Input validation ──────────────────────────────────────────────

    // Validate IGN — must not be empty or whitespace-only
    if (!ign || !ign.trim()) {
      return i.reply({
        content: "❌ IGN cannot be empty. Please provide the testee's in-game name.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Validate tester — must not be empty or whitespace-only
    if (!testerRaw || !testerRaw.trim()) {
      return i.reply({
        content: "❌ Tester cannot be empty. Please provide at least one tester.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Validate currentTier — must be one of the known tiers (defence against
    // stale slash command caches sending an unexpected value)
    if (!TIERS.includes(currentTier)) {
      return i.reply({
        content: `❌ Invalid tier \`${currentTier}\`. Must be one of: ${TIERS.join(", ")}.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Validate previous_tier — must be a known tier or exactly "N/R"
    const prevTierTrimmed = prevTier?.trim() ?? "";
    if (!prevTierTrimmed || (!TIERS.includes(prevTierTrimmed) && prevTierTrimmed !== "N/R")) {
      return i.reply({
        content: `❌ Invalid previous tier \`${prevTier}\`. Must be one of: ${TIERS.join(", ")}, or \`N/R\` for no rating.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Parse multiple scores (comma-separated, e.g. "5-1, 3-2")
    const scores = scoreRaw.split(",").map(s => s.trim()).filter(Boolean);

    // Validate scores — must have at least one non-empty entry
    if (scores.length === 0) {
      return i.reply({
        content: "❌ Score cannot be empty. Please provide at least one score (e.g. `5-1`).",
        flags: MessageFlags.Ephemeral
      });
    }

    // Parse multiple testers — accept @mentions (<@id> or <@!id>), raw IDs, or plain text
    const testerParts = testerRaw.split(",").map(s => s.trim()).filter(Boolean);

    // For each tester part, resolve the user ID (if present) and fetch the
    // guild member so we can use their displayName (nickname > username) in
    // embed field names, which do NOT render raw Discord mentions.
    const resolvedTesters = await Promise.all(testerParts.map(async part => {
      const mentionMatch = part.match(/^<@!?(\d+)>$/);
      const rawIdMatch   = /^\d{17,20}$/.test(part);

      if (mentionMatch || rawIdMatch) {
        const userId = mentionMatch ? mentionMatch[1] : part;
        const guildMember = i.guild.members.cache.get(userId)
          ?? await i.guild.members.fetch(userId).catch(() => null);
        const displayName = guildMember?.displayName ?? `<@${userId}>`;
        return { mention: `<@${userId}>`, displayName };
      }

      // Plain text (username / nickname typed manually) — no mention to resolve
      return { mention: part, displayName: part };
    }));

    // testerDisplayParts keeps the mention strings (used in field values where
    // Discord DOES resolve mentions).  testerNameParts holds the human-readable
    // display names (used in field names where mentions are NOT resolved).
    const testerDisplayParts = resolvedTesters.map(t => t.mention);
    const testerNameParts    = resolvedTesters.map(t => t.displayName);

    // Build paired tester(s) & score(s) display lines — strict 1:1 only.
    // If the number of testers exactly equals the number of scores, pair each
    // tester with their corresponding score on a separate line.
    // If counts don't match, show testers and scores separately.
    let testerScoreLines;
    if (testerDisplayParts.length === scores.length) {
      // Exact match — pair each tester with their score
      testerScoreLines = testerDisplayParts.map((tester, idx) =>
        `> 🧑‍⚖️  **Tester:** ${tester} — **Score:** \`${scores[idx]}\``
      ).join("\n");
    } else {
      // Counts don't match — show separately
      const testerLine = `> 🧑‍⚖️  **Tester:** ${testerDisplayParts.join(", ")}`;
      const scoreLine  = `> 🏅  **Score:** ${scores.map(s => `\`${s}\``).join(", ")}`;
      testerScoreLines = `${testerLine}\n${scoreLine}`;
    }

    // Fetch testee member from cache or API
    const member = i.guild.members.cache.get(player.id)
      ?? await i.guild.members.fetch(player.id).catch(() => null);

    if (!member) {
      return i.reply({ content: `❌ Could not find member <@${player.id}> in this server.`, flags: MessageFlags.Ephemeral });
    }

    // ── Tier-test channel validation ──────────────────────────────────
    // Ensure the player was actually in a tier test channel before allowing
    // a result to be posted for them.
    console.log(`🔍 /result: checking if player ${member.user.tag} (${player.id}) has access to any tier test channel…`);
    try {
      await i.guild.channels.fetch(); // refresh channel cache
    } catch (e) {
      console.log("⚠️ /result: failed to refresh channel cache — proceeding with cached channels:", e);
    }

    const tierTestChannels = i.guild.channels.cache.filter(ch => {
      const name = ch.name?.toLowerCase() ?? "";
      const categoryName = ch.parent?.name?.toLowerCase() ?? "";
      return (
        name.includes("tier test") ||
        name.includes("high-test") ||
        name.includes("tier-test") ||
        categoryName.includes("tier-testing") ||
        categoryName.includes("tier test")
      );
    });

    console.log(`🔍 /result: found ${tierTestChannels.size} tier test channel(s): ${tierTestChannels.map(ch => `#${ch.name}`).join(", ") || "(none)"}`);

    const hasTestAccess = tierTestChannels.some(ch => {
      const perms = ch.permissionsFor(member);
      return perms?.has(PermissionsBitField.Flags.ViewChannel) ?? false;
    });

    console.log(`🔍 /result: player ${member.user.tag} has tier test channel access = ${hasTestAccess}`);

    if (!hasTestAccess) {
      console.log(`❌ /result: rejected — player ${member.user.tag} (${player.id}) has no access to any tier test channel`);
      return i.reply({
        content: `❌ This player was not in any tier test. You cannot post a result for them.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // ── Role assignment: check bot permissions ────────────────────────
    const botMember = i.guild.members.me ?? await i.guild.members.fetch(client.user.id).catch(() => null);
    const canManageRoles = botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles) ?? false;
    console.log(`🔑 /result: bot has ManageRoles permission = ${canManageRoles}`);
    if (!canManageRoles) {
      console.log("❌ /result: bot is missing ManageRoles — role assignment will fail. Grant the bot the Manage Roles permission.");
    }

    // Refresh the guild role cache so we have the latest roles
    await i.guild.roles.fetch();
    console.log(`📋 /result: guild roles in cache (${i.guild.roles.cache.size} total):`);
    i.guild.roles.cache.forEach(r => console.log(`   • "${r.name}" (id=${r.id})`));

    // Remove all existing tier roles, then assign the new tier role
    const tierRolesToRemove = member.roles.cache.filter(r => TIERS.includes(r.name));
    console.log(`🗑️  /result: removing ${tierRolesToRemove.size} existing tier role(s) from ${member.user.tag}`);
    for (const r of tierRolesToRemove.values()) {
      console.log(`   removing role "${r.name}" (id=${r.id})`);
      await member.roles.remove(r).catch(err => console.log(`❌ Failed to remove role ${r.name}:`, err));
    }

    const newTierRole = i.guild.roles.cache.find(r => r.name === currentTier);
    if (newTierRole) {
      console.log(`✅ /result: found tier role "${currentTier}" (id=${newTierRole.id}) — adding to ${member.user.tag}`);
      await member.roles.add(newTierRole)
        .then(() => console.log(`✅ /result: successfully added tier role "${currentTier}" to ${member.user.tag}`))
        .catch(err => console.log(`❌ /result: failed to add tier role "${currentTier}":`, err));
    } else {
      console.log(`⚠️ /result: role "${currentTier}" not found in guild — tier role NOT assigned. Create a role named exactly "${currentTier}" in the server.`);
    }

    // Assign kit+tier role (e.g. "sword HT3") — create it if it doesn't exist
    const kitTierRoleName = `${kit} ${currentTier}`;
    console.log(`🔍 /result: looking for kit+tier role "${kitTierRoleName}"…`);
    let kitTierRole = i.guild.roles.cache.find(r => r.name === kitTierRoleName);
    if (!kitTierRole) {
      console.log(`➕ /result: kit+tier role "${kitTierRoleName}" not found — creating it…`);
      kitTierRole = await i.guild.roles.create({ name: kitTierRoleName, reason: "Auto-created by tier test result" })
        .then(r => { console.log(`✅ /result: created kit+tier role "${kitTierRoleName}" (id=${r.id})`); return r; })
        .catch(err => { console.log(`❌ /result: failed to create kit+tier role "${kitTierRoleName}":`, err); return null; });
    } else {
      console.log(`✅ /result: found existing kit+tier role "${kitTierRoleName}" (id=${kitTierRole.id})`);
    }
    if (kitTierRole) {
      await member.roles.add(kitTierRole)
        .then(() => console.log(`✅ /result: successfully added kit+tier role "${kitTierRoleName}" to ${member.user.tag}`))
        .catch(err => console.log(`❌ /result: failed to add kit+tier role "${kitTierRoleName}":`, err));
    }

    // Record cooldown for the kit
    if (!cooldowns[player.id]) cooldowns[player.id] = {};
    cooldowns[player.id][kit] = new Date().toISOString();
    saveCooldowns();

    // Defer publicly so the result is visible to everyone in this channel
    await i.deferReply();

    // Build the result embed.
    // Head-only avatar (64 px, with overlay for hat layer) is placed as the
    // thumbnail so it appears in the top-left corner of the embed.
    const headUrl = `https://crafatar.com/avatars/${ign}?size=64&overlay`;

    const resultEmbed = new EmbedBuilder()
      .setTitle("🏆  Tier Test Result")
      .setDescription(
        `## <@${player.id}>\n` +
        `\n` +
        `> 🎮  **IGN:** \`${ign}\`\n` +
        `> ⚔️  **Kit:** \`${kit.toUpperCase()}\`\n` +
        `\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `\n` +
        `> 📉  **Previous Tier:** \`${prevTierTrimmed}\`\n` +
        `> 📈  **Current Tier:** \`${currentTier}\`\n`
      )
      .setColor(0xFF0000)
      // Player's Discord avatar as the embed thumbnail
      .setThumbnail(player.displayAvatarURL({ dynamic: true, size: 128 }))
      .setTimestamp();

    // Add each tester-score pair as its own embed field.
    // Field names do NOT resolve Discord mentions, so we use the human-readable
    // displayName there.  Field values DO resolve mentions, so we put the
    // <@id> mention in the value so Discord renders the tester's name as a
    // clickable mention rather than a raw ID string.
    if (testerDisplayParts.length === scores.length) {
      // Exact match — one field per tester/score pair
      for (let idx = 0; idx < testerDisplayParts.length; idx++) {
        resultEmbed.addFields({
          name:  `🧑‍⚖️ Tester: ${testerNameParts[idx]} — Score: \`${scores[idx]}\``,
          value: testerDisplayParts[idx],
          inline: false
        });
      }
    } else {
      // Counts don't match — one field listing all testers, one for all scores
      resultEmbed.addFields(
        { name: "🧑‍⚖️ Tester(s)", value: testerDisplayParts.join("\n"), inline: true },
        { name: "🏅 Score(s)",    value: scores.map(s => `\`${s}\``).join("\n"), inline: true }
      );
    }

    // Post result in the current channel
    const replyMsg = await i.editReply({ embeds: [resultEmbed] });

    // Post to the correct channel based on tier — high tiers go to
    // HIGH_RESULTS_CHANNEL, all others go to RESULTS_CHANNEL.
    if (HIGH_TIERS.has(currentTier)) {
      try {
        const highCh = await client.channels.fetch(HIGH_RESULTS_CHANNEL_ID);
        await highCh.send({ embeds: [resultEmbed] });
        console.log(`✅ /result: posted to high results channel for tier ${currentTier}`);
      } catch (e) {
        console.log(`❌ /result: failed to post to high results channel (${HIGH_RESULTS_CHANNEL_ID}):`, e);
      }
      // Delete the ephemeral reply from RESULTS_CHANNEL so it looks like
      // the command was never executed there — the result lives in HIGH_RESULTS_CHANNEL.
      try {
        await replyMsg.delete();
        console.log(`🗑️ /result: deleted ephemeral reply from results channel (tier=${currentTier})`);
      } catch (e) {
        console.log(`⚠️ /result: could not delete reply message:`, e);
      }
    } else {
      try {
        const resultsCh = await client.channels.fetch(RESULTS_CHANNEL_ID);
        await resultsCh.send({ embeds: [resultEmbed] });
        console.log(`✅ /result: posted to results channel for tier ${currentTier}`);
      } catch (e) {
        console.log(`❌ /result: failed to post to results channel (${RESULTS_CHANNEL_ID}):`, e);
      }
    }

    console.log(`✅ /result: command complete for player=${player.id}, tier=${currentTier}`);
    return;
  }

  if (i.commandName === "panel") {
    console.log(`▶️ /panel: invoked by ${i.user.tag} (${i.user.id})`);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await updatePanel();
      console.log(`✅ /panel: panel refreshed successfully`);
      return i.editReply({ content: `✅ Queue panel has been spawned/refreshed in <#${PANEL_CHANNEL_ID}>.` });
    } catch (e) {
      console.log("❌ updatePanel error in /panel:", e);
      return i.editReply({ content: "❌ Failed to update the panel. Check the console for details." });
    }
  }

  if (i.commandName === "clear") {
    console.log(`▶️ /clear: invoked by ${i.user.tag} (${i.user.id})`);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      // Find all tier test channels in the guild (both normal and high-tier variants)
      const guild = i.guild;
      await guild.channels.fetch(); // ensure cache is populated

      // Log every text channel so we can see exactly what names Discord reports
      console.log("🧹 /clear: all text channels in guild:");
      guild.channels.cache
        .filter(ch => ch.type === ChannelType.GuildText)
        .forEach(ch => console.log(`   • #${ch.name} (${ch.id})`));

      const tierTestChannels = guild.channels.cache.filter(ch =>
        ch.type === ChannelType.GuildText &&
        (
          ch.id === PANEL_CHANNEL_ID ||          // exact ID match for 「💎」tier-testing
          ch.name.includes("tier-testing") ||    // hyphenated variant (e.g. 「💎」tier-testing)
          ch.name.includes("high-tier-testing") || // hyphenated high-tier variant (e.g. 「💎」high-tier-testing)
          ch.name.includes("tier testing") ||    // space variant
          ch.name.includes("tier test") ||       // covers 「💎」tier test (mode) and high tier test (mode)
          ch.name.includes("high tier test") ||  // explicit high-tier variant (legacy)
          ch.name.includes("high-test")          // new high-tier variant: 「💎」high-test (mode)
        )
      );

      console.log(`🧹 /clear: found ${tierTestChannels.size} tier test channel(s) to scan.`);
      tierTestChannels.forEach(ch => console.log(`   ✅ matched: #${ch.name} (${ch.id})`));

      if (tierTestChannels.size === 0) {
        return i.editReply({ content: "ℹ️ No tier test channels found in this server." });
      }

      let totalDeleted = 0;
      const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

      for (const [, ch] of tierTestChannels) {
        console.log(`🧹 /clear: scanning #${ch.name} (${ch.id}) for bot messages…`);
        try {
          let fetched;
          do {
            fetched = await ch.messages.fetch({ limit: 100 });
            if (fetched.size === 0) break;

            // Only delete messages sent by the bot itself
            const botMsgs = fetched.filter(msg => msg.author.id === client.user.id);
            const bulk    = botMsgs.filter(msg => Date.now() - msg.createdTimestamp < TWO_WEEKS);
            const old     = botMsgs.filter(msg => Date.now() - msg.createdTimestamp >= TWO_WEEKS);

            if (bulk.size > 0) {
              await ch.bulkDelete(bulk, true).catch(err =>
                console.log(`❌ bulkDelete error in #${ch.name}:`, err)
              );
            }

            // Delete old messages one-by-one (bulkDelete rejects messages > 14 days)
            for (const msg of old.values()) {
              try {
                await msg.delete();
              } catch (delErr) {
                console.log(`⚠️ /clear: could not delete message ${msg.id} in #${ch.name}:`, delErr.message);
              }
            }

            totalDeleted += botMsgs.size;
            if (fetched.size < 100) break;
          } while (fetched.size === 100);
        } catch (chErr) {
          console.log(`❌ /clear: error scanning #${ch.name} (${ch.id}):`, chErr.message);
          // Continue to the next channel rather than aborting the whole operation
        }
      }

      const reply = await i.editReply({ content: `✅ Cleared **${totalDeleted}** bot message(s) from **${tierTestChannels.size}** tier test channel(s).` });
      setTimeout(() => { reply.delete().catch(() => {}); }, 1000);
    } catch (e) {
      console.log("❌ Error in /clear:", e);
      return i.editReply({ content: "❌ Failed to clear bot messages. Check the console for details." });
    }
  }
});

client.login(TOKEN);