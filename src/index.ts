import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  AutocompleteInteraction,
} from 'discord.js';
import { loadConfig } from './config.js';
import { createAgentRunner, getBackendDisplayName, type AgentRunner } from './agent-runner.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { processManager } from './process-manager.js';
import { loadSkills, formatSkillList, type Skill } from './skills.js';
import { startSlackBot } from './slack.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { initSettings, loadSettings, saveSettings, formatSettings } from './settings.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH } from './constants.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from './scheduler.js';
import { initSessions, getSession, setSession, deleteSession } from './sessions.js';
import { join } from 'path';

/** メッセージを指定文字数で分割（カスタムセパレータ対応、デフォルトは行単位） */
function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > maxLength) {
      if (current) chunks.push(current.trim());
      // 単一ブロックがmaxLengthを超える場合は行単位でフォールバック
      if (block.length > maxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (current.length + line.length + 1 > maxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/** スケジュール一覧をDiscord向けに分割する */
function splitScheduleContent(content: string, maxLength: number): string[] {
  const sep = '\n' + SCHEDULE_SEPARATOR + '\n';
  const chunks = splitMessage(content, maxLength, sep);
  return chunks.map((c) => c.replaceAll(SCHEDULE_SEPARATOR, ''));
}

/** スケジュールタイプに応じたラベルを生成 */
function getTypeLabel(
  type: ScheduleType,
  options: {
    expression?: string;
    runAt?: string;
    intervalMs?: number;
    isolated?: boolean;
    channelInfo?: string;
    timezone?: string;
  }
): string {
  const channelInfo = options.channelInfo || '';
  const tz = options.timezone || 'Asia/Tokyo';
  switch (type) {
    case 'cron': {
      const isolatedMark = options.isolated ? ' 🔒独立' : '';
      return `🔄 繰り返し: \`${options.expression}\`${isolatedMark}${channelInfo}`;
    }
    case 'heartbeat': {
      const ms = options.intervalMs ?? 0;
      const minutes = Math.round(ms / 60000);
      const humanInterval = minutes >= 60 ? `${Math.round(minutes / 60)}時間` : `${minutes}分`;
      return `💓 ${humanInterval}毎に巡回${channelInfo}`;
    }
    case 'startup':
      return `🚀 起動時に実行${channelInfo}`;
    case 'once':
    default:
      return `⏰ 実行時刻: ${new Date(options.runAt!).toLocaleString('ja-JP', { timeZone: tz })}${channelInfo}`;
  }
}

async function main() {
  const config = loadConfig();

  // 許可リストの必須チェック（各プラットフォームで1人のみ許可）
  const discordAllowed = config.discord.allowedUsers || [];
  const slackAllowed = config.slack.allowedUsers || [];

  if (config.discord.enabled && discordAllowed.length === 0) {
    console.error('[xangi] Error: ALLOWED_USER must be set for Discord');
    process.exit(1);
  }
  if (config.slack.enabled && slackAllowed.length === 0) {
    console.error('[xangi] Error: SLACK_ALLOWED_USER or ALLOWED_USER must be set for Slack');
    process.exit(1);
  }
  if (discordAllowed.length > 1 || slackAllowed.length > 1) {
    console.error('[xangi] Error: Only one user per platform is allowed');
    console.error('[xangi] 利用規約遵守のため、複数ユーザーの設定は禁止です');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // エージェントランナーを作成
  const agentRunner = createAgentRunner(config.agent.backend, config.agent.config, {
    onAutoCompact: (channelId) => {
      deleteSession(channelId);
      console.log(`[xangi] Auto-compact: session reset for channel ${channelId}`);
    },
  });
  const backendName = getBackendDisplayName(config.agent.backend);
  console.log(`[xangi] Using ${backendName} as agent backend`);

  // スキルを読み込み
  const workdir = config.agent.config.workdir || process.cwd();
  let skills: Skill[] = loadSkills(workdir);
  console.log(`[xangi] Loaded ${skills.length} skills from ${workdir}`);

  // 設定を初期化
  initSettings(workdir);
  const initialSettings = loadSettings();
  console.log(`[xangi] Settings loaded: autoRestart=${initialSettings.autoRestart}`);

  // スケジューラを初期化（ワークスペースの .xangi を使用）
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  const scheduler = new Scheduler(dataDir, { timezone: config.timezone });

  // セッション永続化を初期化
  initSessions(dataDir);

  // スラッシュコマンド定義
  const commands: ReturnType<SlashCommandBuilder['toJSON']>[] = [
    new SlashCommandBuilder().setName('new').setDescription('新しいセッションを開始する').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('実行中のタスクを停止する').toJSON(),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription('利用可能なスキル一覧を表示')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('スキルを実行する')
      .addStringOption((option) =>
        option.setName('name').setDescription('スキル名').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) => option.setName('args').setDescription('引数').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('compact')
      .setDescription('セッションのコンテキストを圧縮する')
      .toJSON(),
    new SlashCommandBuilder().setName('settings').setDescription('現在の設定を表示する').toJSON(),
    new SlashCommandBuilder().setName('restart').setDescription('ボットを再起動する').toJSON(),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('許可確認をスキップしてメッセージを実行')
      .addStringOption((option) =>
        option.setName('message').setDescription('実行するメッセージ').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('スケジュール管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('スケジュールを追加')
          .addStringOption((opt) =>
            opt
              .setName('input')
              .setDescription('例: "30分後 ミーティング" / "毎日 9:00 おはよう"')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('スケジュール一覧を表示'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('スケジュールを削除')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('スケジュールの有効/無効を切り替え')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .toJSON(),
  ];

  // 各スキルを個別のスラッシュコマンドとして追加
  for (const skill of skills) {
    // Discordコマンド名は小文字英数字とハイフンのみ（最大32文字）
    const cmdName = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);

    if (cmdName) {
      commands.push(
        new SlashCommandBuilder()
          .setName(cmdName)
          .setDescription(skill.description.slice(0, 100) || `${skill.name}スキルを実行`)
          .addStringOption((option) =>
            option.setName('args').setDescription('引数（任意）').setRequired(false)
          )
          .toJSON()
      );
    }
  }

  // スラッシュコマンド登録
  client.once(Events.ClientReady, async (c) => {
    console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    try {
      // ギルドコマンドとして登録（即時反映）
      const guilds = c.guilds.cache;
      console.log(`[xangi] Found ${guilds.size} guilds`);

      for (const [guildId, guild] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands,
        });
        console.log(`[xangi] ${commands.length} slash commands registered for: ${guild.name}`);
      }

      // グローバルコマンドをクリア（重複防止）
      await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
      console.log('[xangi] Cleared global commands');
    } catch (error) {
      console.error('[xangi] Failed to register slash commands:', error);
    }
  });

  // スラッシュコマンド処理
  client.on(Events.InteractionCreate, async (interaction) => {
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skills);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // 許可リストチェック
    if (!config.discord.allowedUsers?.includes(interaction.user.id)) {
      await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
      return;
    }

    const channelId = interaction.channelId;

    if (interaction.commandName === 'new') {
      deleteSession(channelId);
      agentRunner.destroy?.(channelId);
      await interaction.reply('🆕 新しいセッションを開始しました');
      return;
    }

    if (interaction.commandName === 'compact') {
      await interaction.deferReply();
      try {
        const sessionId = getSession(channelId);
        const { sessionId: newSessionId } = await agentRunner.run('/compact', {
          skipPermissions: true,
          sessionId,
          channelId,
        });
        if (newSessionId) setSession(channelId, newSessionId);
        await interaction.editReply('📦 コンテキストを圧縮しました');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await interaction
          .editReply(`❌ 圧縮に失敗しました: ${errorMsg.slice(0, 200)}`)
          .catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'stop') {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      if (stopped) {
        await interaction.reply('🛑 タスクを停止しました');
      } else {
        await interaction.reply({ content: '実行中のタスクはありません', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'settings') {
      const settings = loadSettings();
      await interaction.reply(formatSettings(settings));
      return;
    }

    if (interaction.commandName === 'skip') {
      const skipMessage = interaction.options.getString('message', true);
      await interaction.deferReply();

      try {
        const sessionId = getSession(channelId);

        // ワンショットのClaudeCodeRunnerを使用（skipPermissionsを確実に反映するため）
        const skipRunner = new ClaudeCodeRunner(config.agent.config);
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
        });

        setSession(channelId, runResult.sessionId);

        // ファイルパスを抽出して添付送信
        const filePaths = extractFilePaths(runResult.result);
        const displayText =
          filePaths.length > 0 ? stripFilePaths(runResult.result) : runResult.result;
        const cleanText = stripCommandsFromDisplay(displayText);

        const chunks = splitMessage(cleanText, DISCORD_SAFE_LENGTH);
        await interaction.editReply(chunks[0] || '✅');
        if (chunks.length > 1 && 'send' in interaction.channel!) {
          const channel = interaction.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        // ファイル添付送信
        if (filePaths.length > 0 && interaction.channel && 'send' in interaction.channel) {
          try {
            await (
              interaction.channel as unknown as {
                send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
              }
            ).send({
              files: filePaths.map((fp) => ({ attachment: fp })),
            });
            console.log(`[xangi] Sent ${filePaths.length} file(s) via /skip`);
          } catch (err) {
            console.error('[xangi] Failed to send files via /skip:', err);
          }
        }

        // SYSTEM_COMMAND処理
        handleSettingsFromResponse(runResult.result);

        // !discord コマンド処理
        if (interaction.channel) {
          const fakeMessage = { channel: interaction.channel } as Message;
          await handleDiscordCommandsInResponse(runResult.result, fakeMessage);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        let errorDetail: string;
        if (errorMsg.includes('timed out')) {
          errorDetail = `⏱️ タイムアウトしました`;
        } else if (errorMsg.includes('Process exited unexpectedly')) {
          errorDetail = `💥 AIプロセスが予期せず終了しました`;
        } else if (errorMsg.includes('Circuit breaker')) {
          errorDetail = '🔌 AIプロセスが一時停止中です';
        } else {
          errorDetail = `❌ エラー: ${errorMsg.slice(0, 200)}`;
        }
        // メタ情報を付加（デバッグ用）
        const sid = getSession(channelId);
        if (sid) errorDetail += `\n\`[session: ${sid.slice(0, 8)}]\``;
        await interaction.editReply(errorDetail).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        await interaction.reply('⚠️ 自動再起動が無効です。先に有効にしてください。');
        return;
      }
      await interaction.reply('🔄 再起動します...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, {
        ...config.scheduler,
        timezone: config.timezone,
      });
      return;
    }

    if (interaction.commandName === 'skills') {
      // スキルを再読み込み
      skills = loadSkills(workdir);
      await interaction.reply(formatSkillList(skills));
      return;
    }

    if (interaction.commandName === 'skill') {
      await handleSkill(interaction, agentRunner, config, channelId);
      return;
    }

    // 個別スキルコマンドの処理
    const matchedSkill = skills.find((s) => {
      const cmdName = s.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
      return cmdName === interaction.commandName;
    });

    if (matchedSkill) {
      await handleSkillCommand(interaction, agentRunner, config, channelId, matchedSkill.name);
      return;
    }
  });

  // Discordリンクからメッセージ内容を取得する関数
  async function fetchDiscordLinkContent(text: string): Promise<string> {
    const linkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
    const matches = [...text.matchAll(linkRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullUrl, , channelId, messageId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const fetchedMessage = await channel.messages.fetch(messageId);
          const author = fetchedMessage.author.tag;
          const content = fetchedMessage.content || '(添付ファイルのみ)';
          const attachmentInfo =
            fetchedMessage.attachments.size > 0
              ? `\n[添付: ${fetchedMessage.attachments.map((a) => a.name).join(', ')}]`
              : '';

          const quotedContent = `\n---\n📎 引用メッセージ (${author}):\n${content}${attachmentInfo}\n---\n`;
          result = result.replace(fullUrl, quotedContent);
          console.log(`[xangi] Fetched linked message from channel ${channelId}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch linked message: ${fullUrl}`, err);
        // 取得失敗時はリンクをそのまま残す
      }
    }

    return result;
  }

  // 返信元メッセージを取得してプロンプトに追加する関数
  async function fetchReplyContent(message: Message): Promise<string | null> {
    if (!message.reference?.messageId) return null;

    try {
      const channel = message.channel;
      if (!('messages' in channel)) return null;

      const repliedMessage = await channel.messages.fetch(message.reference.messageId);
      const author = repliedMessage.author.tag;
      const content = repliedMessage.content || '(添付ファイルのみ)';
      const attachmentInfo =
        repliedMessage.attachments.size > 0
          ? `\n[添付: ${repliedMessage.attachments.map((a) => a.name).join(', ')}]`
          : '';

      console.log(`[xangi] Fetched reply-to message from ${author}`);
      return `\n---\n💬 返信元 (${author}):\n${content}${attachmentInfo}\n---\n`;
    } catch (err) {
      console.error(`[xangi] Failed to fetch reply-to message:`, err);
      return null;
    }
  }

  /**
   * メッセージコンテンツ内のチャンネルメンション <#ID> を無害化する
   * fetchChannelMessages() による意図しない二重展開を防ぐ
   */
  function sanitizeChannelMentions(content: string): string {
    return content.replace(/<#(\d+)>/g, '#$1');
  }

  // チャンネルメンションから最新メッセージを取得する関数
  async function fetchChannelMessages(text: string): Promise<string> {
    const channelMentionRegex = /<#(\d+)>/g;
    const matches = [...text.matchAll(channelMentionRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullMention, channelId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 10 });
          const channelName = 'name' in channel ? channel.name : 'unknown';

          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: config.timezone });
              const content = sanitizeChannelMentions(m.content || '(添付ファイルのみ)');
              return `[${time}] ${m.author.tag}: ${content}`;
            })
            .join('\n');

          const expandedContent = `\n---\n📺 #${channelName} の最新メッセージ:\n${messageList}\n---\n`;
          result = result.replace(fullMention, expandedContent);
          console.log(`[xangi] Fetched messages from channel #${channelName}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch channel messages: ${channelId}`, err);
      }
    }

    return result;
  }

  /**
   * チャンネルメンション <#ID> にチャンネルID注釈を追加
   * 例: <#123456> → <#123456> [チャンネルID: 123456]
   */
  function annotateChannelMentions(text: string): string {
    return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
  }

  /**
   * Discord の 2000 文字制限に合わせてメッセージを分割する
   */
  function chunkDiscordMessage(message: string, limit = DISCORD_MAX_LENGTH): string[] {
    if (message.length <= limit) return [message];

    const chunks: string[] = [];
    let buf = '';

    for (const line of message.split('\n')) {
      if (line.length > limit) {
        // 1行が limit 超え → バッファをフラッシュしてハードスプリット
        if (buf) {
          chunks.push(buf);
          buf = '';
        }
        for (let j = 0; j < line.length; j += limit) {
          chunks.push(line.slice(j, j + limit));
        }
        continue;
      }
      const candidate = buf ? `${buf}\n${line}` : line;
      if (candidate.length > limit) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = candidate;
      }
    }
    if (buf) chunks.push(buf);
    return chunks;
  }

  // Discordコマンドを処理する関数
  // feedback: true の場合、response をDiscordに送信せずエージェントに再注入する
  async function handleDiscordCommand(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<{ handled: boolean; response?: string; feedback?: boolean }> {
    // !discord send <#channelId> message (複数行対応)
    const sendMatch = text.match(/^!discord\s+send\s+<#(\d+)>\s+(.+)$/s);
    if (sendMatch) {
      const [, channelId, content] = sendMatch;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          const typedChannel = channel as {
            send: (options: {
              content: string;
              allowedMentions: { parse: never[] };
            }) => Promise<unknown>;
          };
          // 2000文字制限に合わせて分割送信
          const chunks = chunkDiscordMessage(content);
          for (const chunk of chunks) {
            await typedChannel.send({
              content: chunk,
              allowedMentions: { parse: [] },
            });
          }
          const channelName = 'name' in channel ? channel.name : 'unknown';
          console.log(`[xangi] Sent message to #${channelName} (${chunks.length} chunk(s))`);
          return { handled: true, response: `✅ #${channelName} にメッセージを送信しました` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to send message to channel: ${channelId}`, err);
        return { handled: true, response: `❌ チャンネルへの送信に失敗しました` };
      }
    }

    // !discord channels
    if (text.match(/^!discord\s+channels$/)) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ channels コマンドはスケジューラーからは使用できません',
        };
      }
      try {
        const guild = sourceMessage.guild;
        if (guild) {
          const channels = guild.channels.cache
            .filter((c) => c.type === 0) // テキストチャンネルのみ
            .map((c) => `- #${c.name} (<#${c.id}>)`)
            .join('\n');
          return { handled: true, response: `📺 チャンネル一覧:\n${channels}` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to list channels`, err);
        return { handled: true, response: `❌ チャンネル一覧の取得に失敗しました` };
      }
    }

    // !discord history [件数] [offset:N] [チャンネルID]
    const historyMatch = text.match(
      /^!discord\s+history(?:\s+(\d+))?(?:\s+offset:(\d+))?(?:\s+<#(\d+)>)?$/
    );
    if (historyMatch) {
      const count = Math.min(parseInt(historyMatch[1] || '10', 10), 100);
      const offset = parseInt(historyMatch[2] || '0', 10);
      const targetChannelId = historyMatch[3];
      try {
        let targetChannel;
        if (targetChannelId) {
          targetChannel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          targetChannel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          targetChannel = await client.channels.fetch(fallbackChannelId);
        }

        if (targetChannel && 'messages' in targetChannel) {
          let beforeId: string | undefined;

          // offset指定時: まずoffset分のメッセージを取得してスキップ
          if (offset > 0) {
            const skipMessages = await targetChannel.messages.fetch({ limit: offset });
            if (skipMessages.size > 0) {
              beforeId = skipMessages.lastKey();
            }
          }

          const fetchOptions: { limit: number; before?: string } = { limit: count };
          if (beforeId) {
            fetchOptions.before = beforeId;
          }
          const messages = await targetChannel.messages.fetch(fetchOptions);
          const channelName = 'name' in targetChannel ? targetChannel.name : 'unknown';

          const rangeStart = offset;
          const rangeEnd = offset + messages.size;
          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: config.timezone });
              const content = sanitizeChannelMentions(
                (m.content || '(添付ファイルのみ)').slice(0, 200)
              );
              const attachments =
                m.attachments.size > 0
                  ? '\n' + m.attachments.map((a) => `  📎 ${a.name} ${a.url}`).join('\n')
                  : '';
              return `[${time}] ${m.author.tag}: ${content}${attachments}`;
            })
            .join('\n');

          const offsetLabel =
            offset > 0 ? `${rangeStart}〜${rangeEnd}件目` : `最新${messages.size}件`;
          console.log(
            `[xangi] Fetched ${messages.size} history messages from #${channelName} (offset: ${offset})`
          );
          return {
            handled: true,
            feedback: true,
            response: `📺 #${channelName} のチャンネル履歴（${offsetLabel}）:\n${messageList}`,
          };
        }

        if (!sourceMessage && !targetChannelId && !fallbackChannelId) {
          return {
            handled: true,
            feedback: true,
            response:
              '⚠️ history コマンドはチャンネルIDを指定してください（例: !discord history 20 <#123>）',
          };
        }
        return { handled: true, feedback: true, response: '❌ チャンネルが見つかりません' };
      } catch (err) {
        console.error(`[xangi] Failed to fetch history`, err);
        return { handled: true, feedback: true, response: '❌ 履歴の取得に失敗しました' };
      }
    }

    // !discord search <keyword>
    const searchMatch = text.match(/^!discord\s+search\s+(.+)$/);
    if (searchMatch) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ search コマンドはスケジューラーからは使用できません',
        };
      }
      const [, keyword] = searchMatch;
      try {
        // 現在のチャンネルで検索
        const channel = sourceMessage.channel;
        if ('messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 100 });
          const matched = messages.filter((m) =>
            m.content.toLowerCase().includes(keyword.toLowerCase())
          );
          if (matched.size > 0) {
            const results = matched
              .first(10)
              ?.map((m) => {
                const time = m.createdAt.toLocaleString('ja-JP', { timeZone: config.timezone });
                return `[${time}] ${m.author.tag}: ${sanitizeChannelMentions(m.content.slice(0, 200))}`;
              })
              .join('\n');
            return {
              handled: true,
              feedback: true,
              response: `🔍 「${keyword}」の検索結果 (${matched.size}件):\n${results}`,
            };
          }
        }
        return {
          handled: true,
          feedback: true,
          response: `🔍 「${keyword}」に一致するメッセージが見つかりませんでした`,
        };
      } catch (err) {
        console.error(`[xangi] Failed to search messages`, err);
        return { handled: true, response: `❌ 検索に失敗しました` };
      }
    }

    // !discord delete <messageId or link>
    const deleteMatch = text.match(/^!discord\s+delete\s+(.+)$/);
    if (deleteMatch) {
      const arg = deleteMatch[1].trim();

      try {
        let messageId: string;
        let targetChannelId: string | undefined;

        // メッセージリンクからチャンネルIDとメッセージIDを抽出
        const linkMatch = arg.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
        if (linkMatch) {
          targetChannelId = linkMatch[1];
          messageId = linkMatch[2];
        } else if (/^\d+$/.test(arg)) {
          messageId = arg;
        } else {
          return {
            handled: true,
            feedback: true,
            response: '❌ 無効な形式です。メッセージIDまたはリンクを指定してください',
          };
        }

        // リンクからチャンネルIDが取れた場合はそのチャンネルを使う、なければ現在のチャンネル
        let channel;
        if (targetChannelId) {
          channel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          channel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          channel = await client.channels.fetch(fallbackChannelId);
        }

        if (channel && 'messages' in channel) {
          const msg = await channel.messages.fetch(messageId);
          // 自分のメッセージのみ削除可能
          if (msg.author.id !== client.user?.id) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 自分のメッセージのみ削除できます',
            };
          }
          await msg.delete();
          const deletedChannelId =
            targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
          console.log(`[xangi] Deleted message ${messageId} in channel ${deletedChannelId}`);
          return { handled: true, feedback: true, response: '🗑️ メッセージを削除しました' };
        }
        return {
          handled: true,
          feedback: true,
          response: '❌ このチャンネルではメッセージを削除できません',
        };
      } catch (err) {
        console.error(`[xangi] Failed to delete message:`, err);
        return { handled: true, feedback: true, response: '❌ メッセージの削除に失敗しました' };
      }
    }

    return { handled: false };
  }

  /**
   * AIの応答から !discord コマンドを検知して実行
   * コードブロック内のコマンドは無視する
   * !discord send は複数行メッセージに対応（次の !discord / !schedule コマンド行まで吸収）
   * feedback: true のコマンド結果はDiscordに送信せずフィードバック配列に収集して返す
   */
  async function handleDiscordCommandsInResponse(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string,
    skipChannelId?: string
  ): Promise<string[]> {
    const lines = text.split('\n');
    let inCodeBlock = false;
    let i = 0;
    const feedbackResults: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      // コードブロックの開始/終了を追跡
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        i++;
        continue;
      }

      // コードブロック内はスキップ
      if (inCodeBlock) {
        i++;
        continue;
      }

      const trimmed = line.trim();

      // !discord send の複数行対応
      const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
      if (sendMatch) {
        // 同チャンネルへの送信はスキップ（processPromptのストリーミングで既に送信済み → 二重送信防止）
        if (skipChannelId && sendMatch[1] === skipChannelId) {
          console.log(
            `[xangi] Skipping !discord send to same channel <#${skipChannelId}> (already sent via streaming)`
          );
          // コマンドの本文行をスキップ（次のコマンド行まで読み飛ばす）
          i++;
          let inSkipCodeBlock = false;
          while (i < lines.length) {
            const skipLine = lines[i];
            if (skipLine.trim().startsWith('```')) {
              inSkipCodeBlock = !inSkipCodeBlock;
            }
            if (
              !inSkipCodeBlock &&
              (skipLine.trim().startsWith('!discord ') || skipLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            i++;
          }
          continue;
        }
        const firstLineContent = sendMatch[2] ?? '';

        if (firstLineContent.trim() === '') {
          // 本文が空 → 次の !discord / !schedule コマンド行まで吸収（暗黙マルチライン）
          const bodyLines: string[] = [];
          let inBodyCodeBlock = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock = !inBodyCodeBlock;
            }
            // コードブロック外で次のコマンド行が来たら吸収終了
            if (
              !inBodyCodeBlock &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trim();
          if (fullMessage) {
            const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
            console.log(
              `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
            );
            const result = await handleDiscordCommand(
              commandText,
              sourceMessage,
              fallbackChannelId
            );
            if (result.handled && result.response) {
              if (result.feedback) {
                feedbackResults.push(result.response);
              } else if (sourceMessage) {
                const channel = sourceMessage.channel;
                if (
                  'send' in channel &&
                  typeof (channel as { send?: unknown }).send === 'function'
                ) {
                  await (channel as { send: (content: string) => Promise<unknown> }).send(
                    result.response
                  );
                }
              }
            }
          }
          continue; // i は既に次のコマンド行を指している
        } else {
          // 1行目にテキストあり → 続く行も吸収（次のコマンド行まで）
          const bodyLines: string[] = [firstLineContent];
          let inBodyCodeBlock2 = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock2 = !inBodyCodeBlock2;
            }
            if (
              !inBodyCodeBlock2 &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trimEnd();
          const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
          console.log(
            `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage, fallbackChannelId);
          if (result.handled && result.response) {
            if (result.feedback) {
              feedbackResults.push(result.response);
            } else if (sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
          continue;
        }
      }

      // その他の !discord コマンド（channels, search, history）
      if (trimmed.startsWith('!discord ')) {
        console.log(`[xangi] Processing discord command from response: ${trimmed.slice(0, 50)}...`);
        const result = await handleDiscordCommand(trimmed, sourceMessage, fallbackChannelId);
        if (result.handled && result.response) {
          if (result.feedback) {
            feedbackResults.push(result.response);
          } else if (sourceMessage) {
            const channel = sourceMessage.channel;
            if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
              await (channel as { send: (content: string) => Promise<unknown> }).send(
                result.response
              );
            }
          }
        }
      }

      // !schedule コマンド（引数なしでもlist表示、sourceMessage必須）
      if (sourceMessage && (trimmed === '!schedule' || trimmed.startsWith('!schedule '))) {
        console.log(
          `[xangi] Processing schedule command from response: ${trimmed.slice(0, 50)}...`
        );
        await executeScheduleFromResponse(trimmed, sourceMessage, scheduler, {
          ...config.scheduler,
          timezone: config.timezone,
        });
      }

      i++;
    }

    return feedbackResults;
  }

  // Discord APIエラーでプロセスが落ちないようにハンドリング
  client.on('error', (error) => {
    console.error('[xangi] Discord client error:', error.message);
  });

  // チャンネル単位のPromiseキュー（メッセージを順次処理）
  const channelQueues = new Map<string, Promise<void>>();
  // メッセージID重複排除（Discord返信時の二重発火対策）
  const recentMessageIds = new Set<string>();

  // メッセージ処理
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // 同一メッセージの二重処理を防止
    if (recentMessageIds.has(message.id)) return;
    recentMessageIds.add(message.id);
    // メモリリーク防止: 60秒後に削除
    setTimeout(() => recentMessageIds.delete(message.id), 60000);

    const isMentioned = message.mentions.has(client.user!);
    const isDM = !message.guild;
    const parentId = 'parentId' in message.channel ? message.channel.parentId : null;
    const isAutoReplyChannel =
      (config.discord.autoReplyChannels?.includes(message.channel.id) ||
        (parentId && config.discord.autoReplyChannels?.includes(parentId))) ??
      false;

    console.log(
      `[xangi:debug] MessageCreate: msgId=${message.id}, channelId=${message.channel.id}, channelType=${message.channel.type}, parentId=${'parentId' in message.channel ? message.channel.parentId : 'N/A'}, content="${message.content.slice(0, 50)}", isMentioned=${isMentioned}, isAutoReply=${isAutoReplyChannel}`
    );

    if (!isMentioned && !isDM && !isAutoReplyChannel) return;

    if (!config.discord.allowedUsers?.includes(message.author.id)) {
      console.log(`[xangi] Unauthorized user: ${message.author.id} (${message.author.tag})`);
      return;
    }

    let prompt = message.content
      .replace(/<@[!&]?\d+>/g, '') // ユーザーメンションのみ削除（チャンネルメンションは残す）
      .replace(/\s+/g, ' ')
      .trim();

    // スキップ設定（返信元追加やリンク展開の前に判定する）
    // !skip プレフィックスで一時的にスキップモードにできる
    let skipPermissions = config.agent.config.skipPermissions ?? false;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    }

    // !discord コマンドの処理
    if (prompt.startsWith('!discord')) {
      const result = await handleDiscordCommand(prompt, message);
      if (result.handled) {
        if (result.feedback && result.response) {
          // feedback結果はエージェントのコンテキストに注入
          // → 元のコマンドと結果を合わせてプロンプトに流す
          prompt = `ユーザーが「${prompt}」を実行しました。以下がその結果です。この情報を踏まえてユーザーに返答してください。\n\n${result.response}`;
          // processPromptに流す（下に続く）
        } else {
          if (result.response && 'send' in message.channel) {
            await message.channel.send(result.response);
          }
          return;
        }
      }
    }

    // !schedule コマンドの処理
    if (prompt.startsWith('!schedule')) {
      await handleScheduleMessage(message, prompt, scheduler, {
        ...config.scheduler,
        timezone: config.timezone,
      });
      return;
    }

    // Discordリンクからメッセージ内容を取得
    prompt = await fetchDiscordLinkContent(prompt);

    // 返信元メッセージを取得してプロンプトに追加
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // チャンネルメンションにID注釈を追加（展開前に実行）
    prompt = annotateChannelMentions(prompt);

    // チャンネルメンションから最新メッセージを取得
    prompt = await fetchChannelMessages(prompt);

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          const filePath = await downloadFile(attachment.url, attachment.name || 'file');
          attachmentPaths.push(filePath);
        } catch (err) {
          console.error(`[xangi] Failed to download attachment: ${attachment.name}`, err);
        }
      }
    }

    // テキストも添付もない場合はスキップ
    if (!prompt && attachmentPaths.length === 0) return;

    // 添付ファイル情報をプロンプトに追加
    prompt = buildPromptWithAttachments(
      prompt || '添付ファイルを確認してください',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // チャンネル単位のPromiseキューに追加（前のメッセージの処理完了を待ってから実行）
    const prev = channelQueues.get(channelId) ?? Promise.resolve();
    const task = prev.then(async () => {
      try {
        const result = await processPrompt(
          message,
          agentRunner,
          prompt,
          skipPermissions,
          channelId,
          config
        );

        // AIの応答から !discord コマンドを検知して実行
        if (result) {
          const feedbackResults = await handleDiscordCommandsInResponse(
            result,
            message,
            undefined,
            channelId
          );

          // フィードバック結果があればエージェントに再注入（新しいreplyは作らない）
          if (feedbackResults.length > 0) {
            const feedbackPrompt = `あなたが実行したコマンドの結果が返ってきました。この情報を踏まえて、元の会話の文脈に沿ってユーザーに返答してください。\n\n${feedbackResults.join('\n\n')}`;
            console.log(
              `[xangi] Re-injecting ${feedbackResults.length} feedback result(s) to agent`
            );
            const sessionId = getSession(channelId);
            const { result: feedbackResult, sessionId: newSid } = await agentRunner.run(
              feedbackPrompt,
              {
                skipPermissions: skipPermissions || (config.agent.config.skipPermissions ?? false),
                sessionId,
                channelId,
              }
            );
            setSession(channelId, newSid);

            // 再注入結果をチャンネルに送信（既存の会話に追加メッセージとして）
            if (feedbackResult?.trim()) {
              const filePaths = extractFilePaths(feedbackResult);
              const displayText =
                filePaths.length > 0 ? stripFilePaths(feedbackResult) : feedbackResult;
              const cleanedDisplay = displayText.trim();
              if (cleanedDisplay && 'send' in message.channel) {
                const textChunks = splitMessage(cleanedDisplay, DISCORD_SAFE_LENGTH);
                for (const chunk of textChunks) {
                  await (message.channel as { send: (content: string) => Promise<unknown> }).send(
                    chunk
                  );
                }
              }
              if (filePaths.length > 0 && 'send' in message.channel) {
                await (
                  message.channel as {
                    send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
                  }
                ).send({
                  files: filePaths.map((fp) => ({ attachment: fp })),
                });
              }
              // 再注入後の応答にもコマンドがあれば処理（ただし再帰は1回のみ）
              await handleDiscordCommandsInResponse(feedbackResult, message);
            }
          }
        }
      } catch (err) {
        console.error(`[xangi] Error processing queued message in ${channelId}:`, err);
      }
    });
    channelQueues.set(channelId, task);
  });

  // Discordボットを起動
  if (config.discord.enabled) {
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

    // スケジューラにDiscord送信関数を登録
    scheduler.registerSender('discord', async (channelId, msg) => {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(msg);
      }
    });

    // スケジューラにエージェント実行関数を登録
    scheduler.registerAgentRunner(
      'discord',
      async (
        prompt,
        channelId,
        options?: {
          isolated?: boolean;
          thread?: boolean;
          scheduleId?: string;
          scheduleLabel?: string;
        }
      ) => {
        const parentChannel = await client.channels.fetch(channelId);
        if (!parentChannel || !('send' in parentChannel)) {
          throw new Error(`Channel not found: ${channelId}`);
        }

        // thread: true の場合、新規スレッドを作成して送信先を切り替え
        let channel = parentChannel;
        let threadId: string | undefined;
        if (options?.thread && 'threads' in parentChannel) {
          const threadName = options.scheduleLabel || 'スケジュール実行';
          const now = new Date();
          const timestamp = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          const thread = await (parentChannel as import('discord.js').TextChannel).threads.create({
            name: `${threadName} (${timestamp})`,
            autoArchiveDuration: 1440, // 24時間で自動アーカイブ
          });
          channel = thread;
          threadId = thread.id;
          console.log(`[scheduler] Created thread: ${thread.name} (${thread.id})`);
        }

        // プロンプト内の !discord send コマンドを先に直接実行
        // （AIに渡すとコマンドが応答に含まれず実行されないため）
        const promptCommands = extractDiscordSendFromPrompt(prompt);
        for (const cmd of promptCommands.commands) {
          console.log(`[scheduler] Executing discord command from prompt: ${cmd.slice(0, 80)}...`);
          await handleDiscordCommand(cmd, undefined, channelId);
        }

        // !discord send 以外のテキストが残っていればAIに渡す
        const remainingPrompt = promptCommands.remaining.trim();
        if (!remainingPrompt) {
          // コマンドのみのプロンプトだった場合、AIは不要
          console.log('[scheduler] Prompt contained only discord commands, skipping agent');
          return promptCommands.commands.map((c) => `✅ ${c.slice(0, 50)}`).join('\n');
        }

        // isolated=trueの場合、ユニークなchannelIdで独立したrunnerを使う
        // 同じchannelIdのrunnerを共有するとセッションがつながってしまうため
        const runnerChannelId = options?.isolated
          ? `${channelId}_isolated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          : channelId;

        try {
          // isolated=trueならセッションIDを渡さない → 毎回新規セッション
          const sessionId = options?.isolated ? undefined : getSession(channelId);
          const { result, sessionId: newSessionId } = await agentRunner.run(remainingPrompt, {
            skipPermissions: config.agent.config.skipPermissions ?? false,
            sessionId,
            channelId: runnerChannelId,
          });

          // isolatedの場合は親チャンネルのセッションを保存しない
          // ただしスレッドがある場合はスレッドIDにセッションを保存（スレッド内で会話継続可能に）
          if (!options?.isolated) {
            setSession(channelId, newSessionId);
          } else if (threadId) {
            setSession(threadId, newSessionId);
          }

          // AI応答内に !discord send でこのチャンネルへの送信があるか事前チェック
          const hasSendToSameChannel = new RegExp(`^!discord\\s+send\\s+<#${channelId}>`, 'm').test(
            result
          );

          // AI応答内の !discord コマンドを処理（sourceMessage なし、channelIdをフォールバック）
          const feedbackResults = await handleDiscordCommandsInResponse(
            result,
            undefined,
            channelId
          );

          // フィードバック結果があればエージェントに再注入
          if (feedbackResults.length > 0) {
            const feedbackPrompt = `あなたが実行したコマンドの結果が返ってきました。この情報を踏まえて、元の会話の文脈に沿ってユーザーに返答してください。\n\n${feedbackResults.join('\n\n')}`;
            console.log(
              `[scheduler] Re-injecting ${feedbackResults.length} feedback result(s) to agent`
            );
            const feedbackSession = options?.isolated ? newSessionId : getSession(channelId);
            const feedbackRun = await agentRunner.run(feedbackPrompt, {
              skipPermissions: config.agent.config.skipPermissions ?? false,
              sessionId: feedbackSession,
              channelId: runnerChannelId,
            });
            if (!options?.isolated) {
              setSession(channelId, feedbackRun.sessionId);
            } else if (threadId) {
              setSession(threadId, feedbackRun.sessionId);
            }
            // 再注入後の応答にもコマンドがあれば処理
            await handleDiscordCommandsInResponse(feedbackRun.result, undefined, channelId);
          }

          // 結果を送信
          const filePaths = extractFilePaths(result);
          const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;
          const cleanedDisplay = stripCommandsFromDisplay(displayText).trim();

          // 空応答、[SILENT] マーカー、またはスキップ応答パターンの場合はスキップ
          const isSilent =
            !cleanedDisplay ||
            cleanedDisplay.includes('[SILENT]') ||
            (cleanedDisplay.length < 80 &&
              /(?:quiet\s*hours|NO_SPEAK|スキップ|終了|セッション継続)/i.test(cleanedDisplay));
          if (isSilent && filePaths.length === 0) {
            // スレッドが作成済みの場合はスキップ理由を送信（空スレッド防止）
            if (threadId) {
              const ch = channel as { send: (content: string) => Promise<unknown> };
              await ch.send('スキップしました');
            }
            return result;
          }

          // !discord send で同じチャンネルに既に送信済みなら、後段のテキスト送信をスキップ（二重送信防止）
          if (hasSendToSameChannel && filePaths.length === 0) {
            console.log(
              `[scheduler] Skipping duplicate text send for ${options?.scheduleId ?? 'unknown'}: already sent via !discord send`
            );
            return result;
          }

          // 2000文字超の応答は分割送信
          const textChunks = splitMessage(cleanedDisplay, DISCORD_SAFE_LENGTH);
          const ch = channel as { send: (content: string) => Promise<unknown> };
          for (const chunk of textChunks) {
            await ch.send(chunk || '✅');
          }

          if (filePaths.length > 0) {
            await (
              channel as {
                send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
              }
            ).send({
              files: filePaths.map((fp) => ({ attachment: fp })),
            });
          }

          return result;
        } catch (error) {
          const ch = channel as { send: (content: string) => Promise<unknown> };
          if (error instanceof Error && error.message === 'Request cancelled by user') {
            await ch.send('🛑 タスクを停止しました');
          } else {
            const errorMsg = error instanceof Error ? error.message : String(error);
            let errorDetail: string;
            if (errorMsg.includes('timed out')) {
              errorDetail = `⏱️ タイムアウトしました`;
            } else if (errorMsg.includes('Process exited unexpectedly')) {
              errorDetail = `💥 AIプロセスが予期せず終了しました`;
            } else if (errorMsg.includes('Circuit breaker')) {
              errorDetail = '🔌 AIプロセスが一時停止中です';
            } else {
              errorDetail = `❌ エラー: ${errorMsg.slice(0, 200)}`;
            }
            // メタ情報を付加（デバッグ用）
            const meta: string[] = [];
            if (options?.scheduleId)
              meta.push(`schedule: ${options.scheduleLabel || options.scheduleId}`);
            const sid = getSession(channelId);
            if (sid) meta.push(`session: ${sid.slice(0, 8)}`);
            if (meta.length > 0) errorDetail += `\n\`[${meta.join(' | ')}]\``;
            await ch.send(errorDetail);
          }
          throw error;
        } finally {
          // isolated用の一時runnerを破棄してリソースを解放
          if (options?.isolated && runnerChannelId !== channelId) {
            agentRunner.destroy?.(runnerChannelId);
          }
        }
      }
    );
  }

  // Slackボットを起動
  if (config.slack.enabled) {
    await startSlackBot({
      config,
      agentRunner,
      skills,
      reloadSkills: () => {
        skills = loadSkills(workdir);
        return skills;
      },
      scheduler,
    });
    console.log('[xangi] Slack bot started');
  }

  if (!config.discord.enabled && !config.slack.enabled) {
    console.error(
      '[xangi] No chat platform enabled. Set DISCORD_TOKEN or SLACK_BOT_TOKEN/SLACK_APP_TOKEN'
    );
    process.exit(1);
  }

  // スケジューラの全ジョブを開始
  scheduler.startAll(config.scheduler);

  // シャットダウン時にスケジューラを停止
  const shutdown = () => {
    console.log('[xangi] Shutting down scheduler...');
    scheduler.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  skills: Skill[]
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();

  const filtered = skills
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(focusedValue) ||
        skill.description.toLowerCase().includes(focusedValue)
    )
    .slice(0, 25) // Discord制限: 最大25件
    .map((skill) => ({
      name: `${skill.name} - ${skill.description.slice(0, 50)}`,
      value: skill.name,
    }));

  await interaction.respond(filtered);
}

async function handleSkill(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string
) {
  const skillName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string,
  skillName: string
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

/**
 * テキストから !discord send コマンドを抽出し、残りのテキストを返す
 * スケジューラプロンプトからコマンドを分離するために使用
 * コードブロック内のコマンドは無視する
 */
function extractDiscordSendFromPrompt(text: string): {
  commands: string[];
  remaining: string;
} {
  const lines = text.split('\n');
  const commands: string[] = [];
  const remainingLines: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      remainingLines.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      remainingLines.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const firstLineContent = sendMatch[2] ?? '';
      if (firstLineContent.trim() === '') {
        // 暗黙マルチライン: 次のコマンド行まで吸収
        const bodyLines: string[] = [];
        let inBodyCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock = !inBodyCodeBlock;
          }
          if (
            !inBodyCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullMessage = bodyLines.join('\n').trim();
        if (fullMessage) {
          commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage}`);
        }
        continue;
      } else {
        // 1行目にテキストあり → 続く行も吸収
        const bodyLines2: string[] = [firstLineContent];
        let inBodyCodeBlock2 = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock2 = !inBodyCodeBlock2;
          }
          if (
            !inBodyCodeBlock2 &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines2.push(bodyLine);
          i++;
        }
        const fullMessage2 = bodyLines2.join('\n').trimEnd();
        commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage2}`);
        continue;
      }
    }

    remainingLines.push(line);
    i++;
  }

  return { commands, remaining: remainingLines.join('\n') };
}

/**
 * 表示用テキストからコマンド行を除去する（コードブロック内は残す）
 * SYSTEM_COMMAND:, !discord, !schedule で始まる行を除去
 * !discord send の複数行メッセージ（続く行）も除去
 */
function stripCommandsFromDisplay(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();

    // SYSTEM_COMMAND: 行を除去
    if (trimmed.startsWith('SYSTEM_COMMAND:')) {
      i++;
      continue;
    }

    // !discord send の複数行対応: コマンド行と続く行を除去
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#\d+>\s*(.*)/);
    if (sendMatch) {
      // 続く行も除去（次のコマンド行まで）
      i++;
      let inBodyCodeBlock = false;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim().startsWith('```')) {
          inBodyCodeBlock = !inBodyCodeBlock;
        }
        if (
          !inBodyCodeBlock &&
          (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
        ) {
          break;
        }
        i++;
      }
      continue;
    }

    // その他の !discord コマンド行を除去
    if (trimmed.startsWith('!discord ')) {
      i++;
      continue;
    }

    // !schedule コマンド行を除去
    if (trimmed === '!schedule' || trimmed.startsWith('!schedule ')) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n').trim();
}

async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: ReturnType<typeof loadConfig>
): Promise<string | null> {
  try {
    // チャンネル情報をプロンプトに付与
    const channelName =
      'name' in message.channel ? (message.channel as { name: string }).name : null;
    if (channelName) {
      prompt = `[チャンネル: #${channelName} (ID: ${channelId})]\n${prompt}`;
    }

    console.log(`[xangi] Processing message in channel ${channelId}`);

    const sessionId = getSession(channelId);
    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;

    // !skip プレフィックスの場合、ワンショットランナーを使用
    // （persistent-runner はプロセス起動時の権限設定を変えられないため）
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    const needsSkipRunner = skipPermissions && !defaultSkip;
    const runner: AgentRunner = needsSkipRunner
      ? new ClaudeCodeRunner(config.agent.config)
      : agentRunner;

    if (needsSkipRunner) {
      console.log(`[xangi] Using one-shot skip runner for channel ${channelId}`);
    }

    // ベース絵文字（処理中ずっと表示、完了時に外す）
    await message.react('👀').catch(() => {});

    // フェーズに応じたリアクション絵文字（ベース絵文字の横に表示）
    const phaseEmojis = { thinking: '🧠', tool_use: '🔧', text: '✍️' } as const;
    let currentPhaseEmoji: string | null = null;

    const updatePhaseReaction = async (emoji: string) => {
      if (emoji === currentPhaseEmoji) return;
      const botUserId = message.client.user?.id;
      // 前のフェーズ絵文字を削除
      if (currentPhaseEmoji) {
        await message.reactions.cache
          .find((r) => r.emoji.name === currentPhaseEmoji)
          ?.users.remove(botUserId)
          .catch(() => {});
      }
      // 新しいフェーズ絵文字を追加
      currentPhaseEmoji = emoji;
      await message.react(emoji).catch(() => {});
    };

    // 初期フェーズ（thinking）
    await updatePhaseReaction(phaseEmojis.thinking);

    let result: string;
    let newSessionId: string;
    // ストリーミング中に途中送信済みのテキスト（完了後の送信で重複を防ぐ）
    let sentLength = 0;

    if (useStreaming && showThinking && !needsSkipRunner) {
      // ストリーミング + 思考表示モード（persistent-runner のみ）
      // 一定時間テキストが来なかったら途中送信するタイマー
      const PARTIAL_SEND_DELAY_MS = 5000;
      let partialTimer: ReturnType<typeof setTimeout> | null = null;
      let isFirstReply = true;
      // sendPartialText の実行中 Promise を追跡（レースコンディション防止）
      let pendingSend: Promise<void> | null = null;

      const sendPartialText = async (text: string) => {
        // 未送信分を抽出して送信
        const unsent = text.slice(sentLength);
        if (!unsent.trim()) return;

        const cleaned = stripCommandsFromDisplay(stripFilePaths(unsent));
        if (!cleaned.trim()) return;

        // sentLength・isFirstReply を Discord送信前に同期的に更新
        // （result イベントが先に到着して Phase 2 が走るレースコンディション防止）
        const wasFirstReply = isFirstReply;
        sentLength = text.length;
        isFirstReply = false;

        const chunks = splitMessage(cleaned, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          if (wasFirstReply && chunk === chunks[0]) {
            await message.reply(chunk).catch(() => {});
          } else if ('send' in message.channel) {
            await (message.channel as unknown as { send: (c: string) => Promise<unknown> })
              .send(chunk)
              .catch(() => {});
          }
        }
      };

      const streamResult = await agentRunner.runStream(
        prompt,
        {
          onPhaseChange: (phase) => {
            updatePhaseReaction(phaseEmojis[phase]);
          },
          onText: (_chunk, fullText) => {
            // テキスト受信のたびにタイマーリセット
            if (partialTimer) clearTimeout(partialTimer);
            partialTimer = setTimeout(() => {
              pendingSend = sendPartialText(fullText);
            }, PARTIAL_SEND_DELAY_MS);
          },
          onCompact: () => {
            if ('send' in message.channel) {
              (message.channel as unknown as { send: (c: string) => Promise<unknown> })
                .send('🗜️ コンテキスト圧縮中…')
                .catch(() => {});
            }
          },
        },
        { skipPermissions, sessionId, channelId }
      );
      // タイマーが残っていればクリア
      if (partialTimer) clearTimeout(partialTimer);
      // 送信中のPartial送信を待ってからsentLengthを確定させる（二重送信防止）
      if (pendingSend) await pendingSend;

      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非ストリーミング or ワンショットskipランナー
      const runResult = await runner.run(prompt, { skipPermissions, sessionId, channelId });
      result = runResult.result;
      newSessionId = runResult.sessionId;
    }

    setSession(channelId, newSessionId);
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // [SILENT] チェック: Claudeが応答不要と判断した場合はDiscordへの送信をスキップ
    const strippedResult = stripCommandsFromDisplay(stripFilePaths(result)).trim();
    if (strippedResult.includes('[SILENT]')) {
      console.log(`[xangi] [SILENT] detected, skipping Discord reply`);
      // 👀リアクションとフェーズ絵文字を除去
      const botUserId = message.client.user?.id;
      await message.reactions.cache
        .find((r) => r.emoji.name === '👀')
        ?.users.remove(botUserId)
        .catch(() => {});
      if (currentPhaseEmoji) {
        await message.reactions.cache
          .find((r) => r.emoji.name === currentPhaseEmoji)
          ?.users.remove(botUserId)
          .catch(() => {});
      }
      handleSettingsFromResponse(result);
      return result;
    }

    // ファイルパスを抽出して添付送信
    const filePaths = extractFilePaths(result);

    // 未送信の残りテキストを送信
    const remainingRaw = result.slice(sentLength);
    const remainingClean = remainingRaw
      ? stripCommandsFromDisplay(stripFilePaths(remainingRaw))
      : '';

    if (remainingClean.trim()) {
      const chunks = splitMessage(remainingClean, DISCORD_SAFE_LENGTH);
      if (sentLength === 0) {
        // 途中送信なし → 最初のチャンクはreplyで
        await message.reply(chunks[0]);
        if (chunks.length > 1 && 'send' in message.channel) {
          const channel = message.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }
      } else if ('send' in message.channel) {
        // 途中送信あり → 続きはsendで
        const channel = message.channel as unknown as {
          send: (content: string) => Promise<unknown>;
        };
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    } else if (sentLength === 0) {
      // テキストが空でも途中送信もなかった場合
      await message.reply('✅');
    }

    // AIの応答から SYSTEM_COMMAND: を検知して実行
    handleSettingsFromResponse(result);

    if (filePaths.length > 0 && 'send' in message.channel) {
      try {
        await (
          message.channel as unknown as {
            send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
          }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
        console.log(`[xangi] Sent ${filePaths.length} file(s) to Discord`);
      } catch (err) {
        console.error('[xangi] Failed to send files:', err);
      }
    }

    // AIの応答を返す（!discord コマンド処理用）
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      await message.reply('🛑 停止しました').catch(() => {});
      return null;
    }
    console.error('[xangi] Error:', error);

    // エラーの種類を判別して詳細メッセージを生成
    const errorMsg = error instanceof Error ? error.message : String(error);
    let errorDetail: string;
    if (errorMsg.includes('timed out')) {
      errorDetail = `⏱️ タイムアウトしました（${Math.round((config.agent.config.timeoutMs ?? 300000) / 1000)}秒）`;
    } else if (errorMsg.includes('Process exited unexpectedly')) {
      errorDetail = `💥 AIプロセスが予期せず終了しました: ${errorMsg}`;
    } else if (errorMsg.includes('Circuit breaker')) {
      errorDetail =
        '🔌 AIプロセスが連続でクラッシュしたため一時停止中です。しばらくしてから再試行してください';
    } else {
      errorDetail = `❌ エラーが発生しました: ${errorMsg.slice(0, 200)}`;
    }
    // メタ情報を付加（デバッグ用）
    const sid = getSession(channelId);
    if (sid) errorDetail += `\n\`[session: ${sid.slice(0, 8)}]\``;

    // エラー詳細を表示
    await message.reply(errorDetail).catch(() => {});

    // エラー後にエージェントへ自動フォローアップ（サーキットブレーカー時は除く）
    if (!errorMsg.includes('Circuit breaker')) {
      try {
        console.log('[xangi] Sending error follow-up to agent');
        const sessionId = getSession(channelId);
        if (sessionId) {
          const followUpPrompt =
            '先ほどの処理がエラー（タイムアウト等）で中断されました。途中まで行った作業内容と現在の状況を簡潔に報告してください。';
          const followUpResult = await agentRunner.run(followUpPrompt, {
            skipPermissions,
            sessionId,
            channelId,
          });
          if (followUpResult.result) {
            setSession(channelId, followUpResult.sessionId);
            const followUpText = followUpResult.result.slice(0, DISCORD_SAFE_LENGTH);
            if ('send' in message.channel) {
              await (
                message.channel as unknown as {
                  send: (content: string) => Promise<unknown>;
                }
              ).send(`📋 **エラー前の作業報告:**\n${followUpText}`);
            }
          }
        }
      } catch (followUpError) {
        console.error('[xangi] Error follow-up failed:', followUpError);
      }
    }

    return null;
  } finally {
    // ベース絵文字・フェーズ絵文字をすべて削除
    for (const emoji of ['👀', '🧠', '🔧', '✍️']) {
      await message.reactions.cache
        .find((r) => r.emoji.name === emoji)
        ?.users.remove(message.client.user?.id)
        .catch((err) => {
          console.error(`[xangi] Failed to remove ${emoji} reaction:`, err.message || err);
        });
    }
  }
}

/**
 * AIの応答から SYSTEM_COMMAND: を検知して実行
 * 形式: SYSTEM_COMMAND:restart / SYSTEM_COMMAND:set key=value
 */
function handleSettingsFromResponse(text: string): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[xangi] Restart requested but autoRestart is disabled');
        continue;
      }
      console.log('[xangi] Restart requested by agent, restarting in 1s...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[xangi] autoRestart ${enabled ? 'enabled' : 'disabled'} by agent`);
      }
    }
  }
}

// ─── Schedule Handlers ──────────────────────────────────────────────

async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean; timezone?: string }
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'add': {
      const input = interaction.options.getString('input', true);
      const parsed = parseScheduleInput(input);
      if (!parsed) {
        await interaction.reply({
          content:
            '❌ 入力を解析できませんでした\n\n' +
            '**対応フォーマット:**\n' +
            '• `30分後 メッセージ` — 相対時間\n' +
            '• `15:00 メッセージ` — 時刻指定\n' +
            '• `毎日 9:00 メッセージ` — 毎日定時\n' +
            '• `毎週月曜 10:00 メッセージ` — 週次\n' +
            '• `cron 0 9 * * * メッセージ` — cron式',
          ephemeral: true,
        });
        return;
      }

      try {
        const targetChannel = parsed.targetChannelId || channelId;
        const schedule = scheduler.add({
          ...parsed,
          channelId: targetChannel,
          platform: 'discord' as Platform,
        });

        const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
        const typeLabel = getTypeLabel(schedule.type, {
          expression: schedule.expression,
          runAt: schedule.runAt,
          intervalMs: schedule.intervalMs,
          isolated: schedule.isolated,
          channelInfo,
          timezone: schedulerConfig?.timezone,
        });

        await interaction.reply(
          `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`,
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      // 全スケジュールを表示（チャンネルでフィルタしない）
      const schedules = scheduler.list();
      const content = formatScheduleList(schedules, schedulerConfig);
      if (content.length <= DISCORD_MAX_LENGTH) {
        await interaction.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        await interaction.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
      return;
    }

    case 'remove': {
      const id = interaction.options.getString('id', true);
      const removed = scheduler.remove(id);
      await interaction.reply(
        removed ? `🗑️ スケジュール \`${id}\` を削除しました` : `❌ ID \`${id}\` が見つかりません`
      );
      return;
    }

    case 'toggle': {
      const id = interaction.options.getString('id', true);
      const schedule = scheduler.toggle(id);
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効' : '⏸️ 無効';
        await interaction.reply(`${status} に切り替えました: \`${id}\``);
      } else {
        await interaction.reply(`❌ ID \`${id}\` が見つかりません`);
      }
      return;
    }
  }
}

async function handleScheduleMessage(
  message: Message,
  prompt: string,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean; timezone?: string }
): Promise<void> {
  const args = prompt.replace(/^!schedule\s*/, '').trim();
  const channelId = message.channel.id;

  // !schedule (引数なし) or !schedule list → 一覧（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if (content.length <= DISCORD_MAX_LENGTH) {
      await message.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule remove <id|番号> [番号2] [番号3] ...
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) {
      await message.reply('使い方: `!schedule remove <ID または 番号> [番号2] ...`');
      return;
    }

    const schedules = scheduler.list();
    const deletedIds: string[] = [];
    const errors: string[] = [];

    // 番号を大きい順にソート（削除時のずれを防ぐ）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) {
            errors.push(`番号 ${num} は範囲外`);
            return null;
          }
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index); // 大きい番号から削除

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      } else {
        errors.push(`ID ${target.id} が見つからない`);
      }
    }

    const remaining = scheduler.list();
    let response = '';
    if (deletedIds.length > 0) {
      response += `✅ ${deletedIds.length}件削除しました\n\n`;
    }
    if (errors.length > 0) {
      response += `⚠️ エラー: ${errors.join(', ')}\n\n`;
    }
    response += formatScheduleList(remaining, schedulerConfig);
    // 2000文字制限対応
    if (response.length <= DISCORD_MAX_LENGTH) {
      await message.reply(response.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(response, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule toggle <id|番号>
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) {
      await message.reply('使い方: `!schedule toggle <ID または 番号>`');
      return;
    }

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        await message.reply(`❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`);
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if (schedule) {
      const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
      const all = scheduler.list(channelId);
      const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
        SCHEDULE_SEPARATOR,
        ''
      );
      await message.reply(`${status}しました: ${targetId}\n\n${listContent}`);
    } else {
      await message.reply(`❌ ID \`${targetId}\` が見つかりません`);
    }
    return;
  }

  // !schedule add <input> or !schedule <input> (addなしでも追加)
  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    await message.reply(
      '❌ 入力を解析できませんでした\n\n' +
        '**対応フォーマット:**\n' +
        '• `!schedule 30分後 メッセージ`\n' +
        '• `!schedule 15:00 メッセージ`\n' +
        '• `!schedule 毎日 9:00 メッセージ`\n' +
        '• `!schedule 毎週月曜 10:00 メッセージ`\n' +
        '• `!schedule cron 0 9 * * * メッセージ`\n' +
        '• `!schedule list` / `!schedule remove <ID>`'
    );
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      isolated: schedule.isolated,
      channelInfo,
      timezone: schedulerConfig?.timezone,
    });

    await message.reply(
      `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
    );
  } catch (error) {
    await message.reply(`❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`);
  }
}

/**
 * AI応答内の !schedule コマンドを実行
 */
async function executeScheduleFromResponse(
  text: string,
  sourceMessage: Message,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean; timezone?: string }
): Promise<void> {
  const args = text.replace(/^!schedule\s*/, '').trim();
  const channelId = sourceMessage.channel.id;
  const channel = sourceMessage.channel;

  // list コマンド（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if ('send' in channel) {
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      // 2000文字制限対応: 分割送信
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // remove コマンド（複数対応）
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) return;

    const schedules = scheduler.list();
    const deletedIds: string[] = [];

    // 番号を大きい順にソート（削除時のずれを防ぐ）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) return null;
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index);

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      }
    }

    if ('send' in channel && deletedIds.length > 0) {
      const remaining = scheduler.list();
      const content = `✅ ${deletedIds.length}件削除しました\n\n${formatScheduleList(remaining, schedulerConfig)}`;
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // toggle コマンド
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) return;

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        if ('send' in channel) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(
            `❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`
          );
        }
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if ('send' in channel) {
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
        const all = scheduler.list(channelId);
        const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
          SCHEDULE_SEPARATOR,
          ''
        );
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `${status}しました: ${targetId}\n\n${listContent}`
        );
      } else {
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `❌ ID \`${targetId}\` が見つかりません`
        );
      }
    }
    return;
  }

  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    console.log(`[xangi] Failed to parse schedule input: ${input}`);
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      isolated: schedule.isolated,
      channelInfo,
      timezone: schedulerConfig?.timezone,
    });

    if ('send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(
        `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
      );
    }
  } catch (error) {
    console.error('[xangi] Failed to add schedule from response:', error);
  }
}

main().catch(console.error);
