const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActivityType,
  InteractionContextType
} = require("discord.js");

const tiers = ["LT5", "HT5", "LT4", "HT4", "LT3", "HT3", "LT2", "HT2", "LT1", "HT1"];
const tierChoices = tiers.map((tier) => ({ name: tier, value: tier }));

const config = {
  token: requiredEnv("DISCORD_TOKEN", process.env.TOKEN),
  clientId: requiredEnv("DISCORD_CLIENT_ID", process.env.CLIENT_ID),
  guildId: requiredEnv("DISCORD_GUILD_ID", process.env.GUILD_ID),
  panelChannelId: process.env.ADMIN_CHANNEL_ID || process.env.PANEL_CHANNEL_ID || "1510325369209753694",
  logChannelId: process.env.LOG_CHANNEL_ID || process.env.LOGS_CHANNEL_ID || "1510325207103967475",
  testerRoleId: requiredEnv("TESTER_ROLE_ID"),
  apiUrl: trimTrailingSlash(process.env.API_URL || "https://CHANGE-ME.example.com"),
  apiKey: process.env.API_KEY || process.env.ADMIN_API_KEY || "CHANGE_ME_AFTER_API_DEPLOY",
  requestTimeoutMs: numberEnv("API_TIMEOUT_MS", 12000),
  tierRoleIds: Object.fromEntries(tiers.map((tier) => [tier, process.env[`TIER_ROLE_${tier}`] || `CHANGE_ME_${tier}_ROLE_ID`]))
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

function requiredEnv(name, fallback) {
  const value = fallback || process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function isPlaceholder(value) {
  return !value || value.startsWith("CHANGE_ME") || value.includes("CHANGE-ME");
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": config.apiKey
  };
}


async function apiRequest(method, path, body) {
  if (isPlaceholder(config.apiUrl) || isPlaceholder(config.apiKey)) {
    throw new Error("API_URL and API_KEY must be configured after the API is hosted.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: apiHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const error = new Error(data?.message || `API request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function logToChannel(payload) {
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (channel?.isTextBased()) await channel.send(payload);
  } catch (error) {
    console.error("log channel error", error);
  }
}

function buildErrorEmbed(title, error, context = {}) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xff5555)
    .addFields(
      { name: "Error", value: truncate(error?.message || String(error), 1000) },
      { name: "Context", value: truncate(JSON.stringify(context, null, 2), 1000) }
    )
    .setTimestamp();
}

function truncate(value, limit) {
  const text = String(value || "None");
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function tierRoleId(tier) {
  const roleId = config.tierRoleIds[tier];
  if (isPlaceholder(roleId)) throw new Error(`Missing Discord role ID for ${tier}. Set TIER_ROLE_${tier}.`);
  return roleId;
}

function tierRoleIds() {
  return Object.values(config.tierRoleIds).filter((id) => !isPlaceholder(id));
}

async function removeTierRoles(member) {
  const ids = tierRoleIds().filter((id) => member.roles.cache.has(id));
  if (ids.length) await member.roles.remove(ids, "FireTagger tier role cleanup");
  return ids.length;
}

async function setTierRole(member, tier) {
  await removeTierRoles(member);
  await member.roles.add(tierRoleId(tier), `FireTagger tier assignment ${tier}`);
}

function hasTesterRole(interaction) {
  return interaction.member?.roles?.cache?.has(config.testerRoleId);
}

async function guard(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "This command only works in the server.", flags: MessageFlags.Ephemeral });
    return false;
  }

  if (interaction.channelId !== config.panelChannelId) {
    await interaction.reply({ content: `Use this command in <#${config.panelChannelId}>.`, flags: MessageFlags.Ephemeral });
    return false;
  }

  if (!hasTesterRole(interaction)) {
    await interaction.reply({ content: "You do not have the Tester role required to use this command.", flags: MessageFlags.Ephemeral });
    return false;
  }

  return true;
}

function commands() {
  return [
    new SlashCommandBuilder()
      .setName("tier")
      .setDescription("Manage Minecraft tier assignments")
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((command) => command
        .setName("assign")
        .setDescription("Assign a tier to a Minecraft username and Discord member")
        .addStringOption((option) => option.setName("username").setDescription("Minecraft username").setRequired(true).setMinLength(1).setMaxLength(16))
        .addUserOption((option) => option.setName("member").setDescription("Discord member").setRequired(true))
        .addStringOption((option) => option.setName("tier").setDescription("Tier").setRequired(true).addChoices(...tierChoices)))
      .addSubcommand((command) => command
        .setName("remove")
        .setDescription("Remove a tier assignment")
        .addStringOption((option) => option.setName("username").setDescription("Minecraft username").setRequired(true).setMinLength(1).setMaxLength(16)))
      .addSubcommand((command) => command
        .setName("list")
        .setDescription("List all tier assignments")
        .addIntegerOption((option) => option.setName("page").setDescription("Page number").setRequired(false).setMinValue(1)))
      .addSubcommand((command) => command
        .setName("lookup")
        .setDescription("Look up one Minecraft username")
        .addStringOption((option) => option.setName("username").setDescription("Minecraft username").setRequired(true).setMinLength(1).setMaxLength(16)))
      .addSubcommand((command) => command
        .setName("sync")
        .setDescription("Sync Discord tier roles from the API database"))
      .addSubcommand((command) => command
        .setName("bulk-assign")
        .setDescription("Assign tiers from a JSON attachment")
        .addAttachmentOption((option) => option.setName("file").setDescription("JSON array of assignments").setRequired(true)))
      .toJSON()
  ];
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands() });
}

function assignmentEmbed(assignment) {
  const metadata = assignment.tier_metadata || assignment.tierMetadata || {};
  return new EmbedBuilder()
    .setTitle(`${assignment.minecraft_username} — ${assignment.tier}`)
    .setColor(colorToInt(metadata.color_code || metadata.colorCode || "§7"))
    .addFields(
      { name: "Minecraft", value: assignment.minecraft_username, inline: true },
      { name: "Discord", value: `<@${assignment.discord_user_id}>`, inline: true },
      { name: "Tier", value: assignment.tier, inline: true },
      { name: "Updated", value: assignment.updated_at ? `<t:${Math.floor(new Date(assignment.updated_at).getTime() / 1000)}:R>` : "Unknown", inline: true }
    )
    .setTimestamp();
}

function colorToInt(code) {
  const colors = {
    "§8": 0x555555,
    "§7": 0xaaaaaa,
    "§2": 0x00aa00,
    "§a": 0x55ff55,
    "§3": 0x00aaaa,
    "§b": 0x55ffff,
    "§6": 0xffaa00,
    "§e": 0xffff55,
    "§c": 0xff5555,
    "§4": 0xaa0000
  };
  return colors[code] || 0x5865f2;
}

async function handleAssign(interaction) {
  await interaction.deferReply();

  const username = interaction.options.getString("username", true).trim();
  const user = interaction.options.getUser("member", true);
  const tier = interaction.options.getString("tier", true);
  const member = await interaction.guild.members.fetch(user.id);

  await setTierRole(member, tier);

  let assignment;
  try {
    assignment = await apiRequest("POST", "/admin/tiers", {
      minecraft_username: username,
      discord_user_id: user.id,
      tier,
      actor: interaction.user.id
    });
  } catch (error) {
    if (error.status === 409) {
      assignment = await apiRequest("PATCH", `/admin/tiers/${encodeURIComponent(username)}`, {
        discord_user_id: user.id,
        tier,
        actor: interaction.user.id
      });
    } else {
      throw error;
    }
  }

  await logToChannel({ embeds: [new EmbedBuilder().setTitle("Tier assigned").setColor(0x57f287).setDescription(`<@${interaction.user.id}> assigned **${username}** / <@${user.id}> to **${tier}**.`).setTimestamp()] });
  await interaction.editReply({ content: `Assigned **${username}** / <@${user.id}> to **${tier}**.`, embeds: [assignmentEmbed(assignment)] });
}

async function handleRemove(interaction) {
  await interaction.deferReply();

  const username = interaction.options.getString("username", true).trim();
  const assignment = await apiRequest("GET", `/admin/tiers/${encodeURIComponent(username)}`);
  const member = await interaction.guild.members.fetch(assignment.discord_user_id).catch(() => null);

  let rolesRemoved = 0;
  if (member) rolesRemoved = await removeTierRoles(member);

  await apiRequest("DELETE", `/admin/tiers/${encodeURIComponent(username)}?actor=${encodeURIComponent(interaction.user.id)}`);
  await logToChannel({ embeds: [new EmbedBuilder().setTitle("Tier removed").setColor(0xfee75c).setDescription(`<@${interaction.user.id}> removed **${username}** / <@${assignment.discord_user_id}>. Removed ${rolesRemoved} Discord tier role(s).`).setTimestamp()] });
  await interaction.editReply(`Removed **${username}** / <@${assignment.discord_user_id}>.`);
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const page = interaction.options.getInteger("page") || 1;
  const data = await apiRequest("GET", "/admin/tiers");
  const players = data.players || [];
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(players.length / pageSize));
  const safePage = Math.min(page, pages);
  const slice = players.slice((safePage - 1) * pageSize, safePage * pageSize);

  const embed = new EmbedBuilder()
    .setTitle("Tier assignments")
    .setColor(0x5865f2)
    .setFooter({ text: `Page ${safePage}/${pages} · ${players.length} total` })
    .setTimestamp();

  if (!slice.length) {
    embed.setDescription("No tier assignments yet.");
  } else {
    embed.setDescription(slice.map((player, index) => `**${(safePage - 1) * pageSize + index + 1}.** ${player.minecraft_username} · **${player.tier}** · <@${player.discord_user_id}>`).join("\n"));
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleLookup(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const username = interaction.options.getString("username", true).trim();
  const assignment = await apiRequest("GET", `/admin/tiers/${encodeURIComponent(username)}`);
  await interaction.editReply({ embeds: [assignmentEmbed(assignment)] });
}

async function handleSync(interaction) {
  await interaction.deferReply();

  const data = await apiRequest("GET", "/admin/tiers");
  const players = data.players || [];
  let changed = 0;
  let skipped = 0;
  const failures = [];

  for (const assignment of players) {
    try {
      const member = await interaction.guild.members.fetch(assignment.discord_user_id).catch(() => null);
      if (!member) {
        skipped += 1;
        failures.push(`${assignment.minecraft_username}: member not found`);
        continue;
      }

      const before = tierRoleIds().filter((id) => member.roles.cache.has(id)).sort().join(",");
      await setTierRole(member, assignment.tier);
      const after = tierRoleIds().filter((id) => member.roles.cache.has(id)).sort().join(",");
      if (before !== after) changed += 1;
    } catch (error) {
      skipped += 1;
      failures.push(`${assignment.minecraft_username}: ${error.message}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("Tier role sync complete")
    .setColor(failures.length ? 0xfee75c : 0x57f287)
    .addFields(
      { name: "Assignments checked", value: String(players.length), inline: true },
      { name: "Members changed", value: String(changed), inline: true },
      { name: "Skipped/errors", value: String(skipped), inline: true }
    )
    .setTimestamp();

  if (failures.length) embed.addFields({ name: "Details", value: truncate(failures.slice(0, 12).join("\n"), 1000) });

  await logToChannel({ embeds: [embed] });
  await interaction.editReply({ embeds: [embed] });
}

async function handleBulkAssign(interaction) {
  await interaction.deferReply();

  const file = interaction.options.getAttachment("file", true);
  if (!file.contentType?.includes("json") && !file.name.toLowerCase().endsWith(".json")) {
    await interaction.editReply("Upload a JSON file.");
    return;
  }

  const response = await fetch(file.url);
  const assignments = await response.json();
  if (!Array.isArray(assignments)) throw new Error("Bulk file must be a JSON array.");

  const successes = [];
  const failures = [];

  for (const item of assignments) {
    const username = String(item.minecraft_username || item.username || "").trim();
    const discordUserId = String(item.discord_user_id || item.discordUserId || "").trim();
    const tier = String(item.tier || "").trim().toUpperCase();

    if (!username || !discordUserId || !tiers.includes(tier)) {
      failures.push(`${username || "unknown"}: invalid item`);
      continue;
    }

    try {
      const member = await interaction.guild.members.fetch(discordUserId);
      await setTierRole(member, tier);
      try {
        await apiRequest("POST", "/admin/tiers", { minecraft_username: username, discord_user_id: discordUserId, tier, actor: interaction.user.id });
      } catch (error) {
        if (error.status === 409) {
          await apiRequest("PATCH", `/admin/tiers/${encodeURIComponent(username)}`, { discord_user_id: discordUserId, tier, actor: interaction.user.id });
        } else {
          throw error;
        }
      }
      successes.push(username);
    } catch (error) {
      failures.push(`${username}: ${error.message}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("Bulk assign complete")
    .setColor(failures.length ? 0xfee75c : 0x57f287)
    .addFields(
      { name: "Successes", value: String(successes.length), inline: true },
      { name: "Failures", value: String(failures.length), inline: true }
    )
    .setTimestamp();

  if (successes.length) embed.addFields({ name: "Assigned", value: truncate(successes.slice(0, 20).join(", "), 1000) });
  if (failures.length) embed.addFields({ name: "Failed", value: truncate(failures.slice(0, 12).join("\n"), 1000) });

  await logToChannel({ embeds: [embed] });
  await interaction.editReply({ embeds: [embed] });
}

client.once("ready", async () => {
  console.log(`FireTagger bot logged in as ${client.user.tag}`);
  client.user.setActivity("/tier", { type: ActivityType.Watching });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "tier") return;
  if (!(await guard(interaction))) return;

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === "assign") await handleAssign(interaction);
    if (subcommand === "remove") await handleRemove(interaction);
    if (subcommand === "list") await handleList(interaction);
    if (subcommand === "lookup") await handleLookup(interaction);
    if (subcommand === "sync") await handleSync(interaction);
    if (subcommand === "bulk-assign") await handleBulkAssign(interaction);
  } catch (error) {
    await logToChannel({ embeds: [buildErrorEmbed("Tier command error", error, { subcommand, user: interaction.user.id, channel: interaction.channelId, data: error.data || null })] });
    const message = error.status === 404 ? "That Minecraft username was not found." : "The command could not be completed. Details were sent to the log channel.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

process.on("unhandledRejection", (error) => {
  console.error("unhandledRejection", error);
  logToChannel({ embeds: [buildErrorEmbed("Unhandled rejection", error)] });
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException", error);
  logToChannel({ embeds: [buildErrorEmbed("Uncaught exception", error)] }).finally(() => process.exit(1));
});

(async () => {
  await registerCommands();
  await client.login(config.token);
})();
