import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
} from 'discord.js';
import { loadConfig } from './config.js';
import { createAgentRunner, getBackendDisplayName } from './agent-runner.js';
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
import { initSettings, loadSettings, formatSettings } from './settings.js';
import { DISCORD_SAFE_LENGTH } from './constants.js';
import { Scheduler } from './scheduler.js';
import { initSessions, getSession, setSession, deleteSession } from './sessions.js';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { initErrorNotify, notifyError } from './error-notify.js';

// Extracted modules
import { splitMessage, annotateChannelMentions } from './message-utils.js';
import {
  fetchDiscordLinkContent,
  fetchReplyContent,
  fetchChannelMessages,
} from './discord-fetchers.js';
import { handleDiscordCommand, handleDiscordCommandsInResponse } from './discord-commands.js';
import { handleAutocomplete, handleSkill, handleSkillCommand } from './command-handlers.js';
import {
  processPrompt,
  extractDiscordSendFromPrompt,
  stripCommandsFromDisplay,
  handleSettingsFromResponse,
} from './prompt-processor.js';
import {
  handleScheduleCommand,
  handleScheduleMessage,
  executeScheduleFromResponse,
} from './schedule-handler.js';

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
  // DISCORD_BOT_PASSTHROUGH分を除いた人間ユーザー数のみチェック
  const discordBotPassthrough =
    process.env.DISCORD_BOT_PASSTHROUGH?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) || [];
  const discordHumanUsers = discordAllowed.filter((id) => !discordBotPassthrough.includes(id));
  if (discordHumanUsers.length > 1 || slackAllowed.length > 1) {
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
  const scheduler = new Scheduler(dataDir, {
    timezone: config.timezone,
  });

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
      const guilds = c.guilds.cache;
      console.log(`[xangi] Found ${guilds.size} guilds`);

      for (const [guildId, guild] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands,
        });
        console.log(`[xangi] ${commands.length} slash commands registered for: ${guild.name}`);
      }

      await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
      console.log('[xangi] Cleared global commands');
    } catch (error) {
      console.error('[xangi] Failed to register slash commands:', error);
    }
  });

  // ─── スラッシュコマンド処理 ──────────────────────────────────────────

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skills);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

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

        const skipRunner = new ClaudeCodeRunner(config.agent.config);
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
        });

        setSession(channelId, runResult.sessionId);

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

        handleSettingsFromResponse(runResult.result);

        if (interaction.channel) {
          const fakeMessage = { channel: interaction.channel } as Message;
          await handleDiscordCommandsInResponse(
            client,
            config.timezone,
            runResult.result,
            fakeMessage
          );
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

  // Discord APIエラーでプロセスが落ちないようにハンドリング
  client.on('error', (error) => {
    console.error('[xangi] Discord client error:', error.message);
    notifyError('Discord clientエラー', error.message);
  });

  // ─── メッセージ処理 ──────────────────────────────────────────────────

  const channelQueues = new Map<string, Promise<void>>();
  const recentMessageIds = new Set<string>();

  client.on(Events.MessageCreate, async (message) => {
    if (recentMessageIds.has(message.id)) return;
    recentMessageIds.add(message.id);
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
      .replace(/<@[!&]?\d+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    let skipPermissions = config.agent.config.skipPermissions ?? false;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    }

    // !discord コマンドの処理
    if (prompt.startsWith('!discord')) {
      const result = await handleDiscordCommand(client, prompt, config.timezone, message);
      if (result.handled) {
        if (result.feedback && result.response) {
          prompt = `ユーザーが「${prompt}」を実行しました。以下がその結果です。この情報を踏まえてユーザーに返答してください。\n\n${result.response}`;
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
    prompt = await fetchDiscordLinkContent(client, prompt);

    // 返信元メッセージを取得してプロンプトに追加
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // チャンネルメンションにID注釈を追加（展開前に実行）
    prompt = annotateChannelMentions(prompt);

    // チャンネルメンションから最新メッセージを取得
    prompt = await fetchChannelMessages(client, prompt, config.timezone);

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

    if (!prompt && attachmentPaths.length === 0) return;

    prompt = buildPromptWithAttachments(
      prompt || '添付ファイルを確認してください',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // チャンネル単位のPromiseキューに追加
    const prev = channelQueues.get(channelId) ?? Promise.resolve();
    const task = prev.then(async () => {
      try {
        // チャンネルに紐づくスキルのSKILL.mdを前置注入
        const channelSkillName = config.discord.channelSkills?.[channelId];
        if (channelSkillName) {
          const skill = skills.find((s) => s.name === channelSkillName);
          if (skill && existsSync(skill.path)) {
            const skillContent = readFileSync(skill.path, 'utf-8');
            prompt = `以下のスキル定義に従って行動してください:\n\n${skillContent}\n\n---\n\n${prompt}`;
            console.log(`[xangi] Injecting skill "${channelSkillName}" for channel ${channelId}`);
          }
        }

        const result = await processPrompt(
          message,
          agentRunner,
          prompt,
          skipPermissions,
          channelId,
          config
        );

        if (result) {
          // チャンネルレポート自動転送
          const reportChannelId = config.discord.channelReports?.[channelId];
          if (reportChannelId) {
            const displayText = stripCommandsFromDisplay(stripFilePaths(result)).trim();
            if (displayText && !displayText.includes('[SILENT]')) {
              const reportChannel = await client.channels.fetch(reportChannelId).catch(() => null);
              if (reportChannel && 'send' in reportChannel) {
                const summary = displayText.slice(0, 300);
                await (reportChannel as { send: (content: string) => Promise<unknown> }).send(
                  `[カラクリワールド] ${summary}`
                );
                console.log(
                  `[xangi] Auto-forwarded response to report channel #${reportChannelId}`
                );
              }
            }
          }

          const schedulerConfig = { ...config.scheduler, timezone: config.timezone };
          // スレッドチャンネルの場合は !discord send を現在のスレッドに強制リダイレクト
          // AIが誤ったチャンネルIDを指定しても、スレッド内に届くようにする
          const isThread =
            message.channel.type === ChannelType.PublicThread ||
            message.channel.type === ChannelType.PrivateThread ||
            message.channel.type === ChannelType.AnnouncementThread;
          const threadEnforceChannelId = isThread ? channelId : undefined;
          const feedbackResults = await handleDiscordCommandsInResponse(
            client,
            config.timezone,
            result,
            message,
            undefined,
            undefined,
            (trimmed) => executeScheduleFromResponse(trimmed, message, scheduler, schedulerConfig),
            threadEnforceChannelId
          );

          // フィードバック結果があればエージェントに再注入
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

            if (feedbackResult?.trim()) {
              const filePaths = extractFilePaths(feedbackResult);
              const displayText =
                filePaths.length > 0 ? stripFilePaths(feedbackResult) : feedbackResult;
              const cleanedDisplay = stripCommandsFromDisplay(displayText).trim();
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
              await handleDiscordCommandsInResponse(
                client,
                config.timezone,
                feedbackResult,
                message,
                undefined,
                undefined,
                undefined,
                threadEnforceChannelId
              );
            }
          }
        }
        // メッセージ処理完了後のセッションリセット
        if (config.discord.resetAfterMessageChannels?.includes(channelId)) {
          deleteSession(channelId);
          agentRunner.destroy?.(channelId);
          console.log(`[xangi] Session reset after message in channel ${channelId}`);
        }
      } catch (err) {
        console.error(`[xangi] Error processing queued message in ${channelId}:`, err);
        notifyError('メッセージ処理エラー', err instanceof Error ? err.message : String(err), {
          チャンネル: channelId,
        });
      }
    });
    channelQueues.set(channelId, task);
  });

  // ─── ボット起動 ──────────────────────────────────────────────────────

  if (config.discord.enabled) {
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

    const discordSend = async (channelId: string, msg: string) => {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(msg);
      }
    };

    scheduler.registerSender('discord', discordSend);
    initErrorNotify(discordSend);

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

        let channel = parentChannel;
        let threadId: string | undefined;
        if (options?.thread && 'threads' in parentChannel) {
          const threadName = options.scheduleLabel || 'スケジュール実行';
          const now = new Date();
          const timestamp = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          const thread = await (parentChannel as import('discord.js').TextChannel).threads.create({
            name: `${threadName} (${timestamp})`,
            autoArchiveDuration: 1440,
          });
          channel = thread;
          threadId = thread.id;
          console.log(`[scheduler] Created thread: ${thread.name} (${thread.id})`);
        }

        const redirectToThread = (text: string) => {
          if (!threadId) return text;
          return text.replace(new RegExp(`<#${channelId}>`, 'g'), `<#${threadId}>`);
        };

        // プロンプト内の !discord send コマンドを先に直接実行
        const promptCommands = extractDiscordSendFromPrompt(prompt);
        for (const cmd of promptCommands.commands) {
          const redirectedCmd = redirectToThread(cmd);
          console.log(
            `[scheduler] Executing discord command from prompt: ${redirectedCmd.slice(0, 80)}...`
          );
          await handleDiscordCommand(
            client,
            redirectedCmd,
            config.timezone,
            undefined,
            threadId || channelId,
            { enforceChannelId: threadId || channelId }
          );
        }

        const remainingPrompt = promptCommands.remaining.trim();
        if (!remainingPrompt) {
          console.log('[scheduler] Prompt contained only discord commands, skipping agent');
          return promptCommands.commands.map((c) => `✅ ${c.slice(0, 50)}`).join('\n');
        }

        const runnerChannelId = options?.isolated
          ? `${channelId}_isolated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          : channelId;

        // スケジューラ実行時にチャンネルコンテキストを注入する
        // AIが !discord send でどのチャンネルIDを使うべきか知るために必要
        const channelContext = threadId
          ? `[実行チャンネル: <#${channelId}> / スレッド: <#${threadId}> — !discord send は <#${channelId}> 宛てに書くこと（スレッドへ自動リダイレクトされます）]`
          : `[実行チャンネル: <#${channelId}> — !discord send は <#${channelId}> 宛てに書くこと]`;
        const contextualPrompt = `${channelContext}\n${remainingPrompt}`;

        try {
          const sessionId = options?.isolated ? undefined : getSession(channelId);
          const { result, sessionId: newSessionId } = await agentRunner.run(contextualPrompt, {
            skipPermissions: config.agent.config.skipPermissions ?? false,
            sessionId,
            channelId: runnerChannelId,
          });

          if (!options?.isolated) {
            setSession(channelId, newSessionId);
          } else if (threadId) {
            setSession(threadId, newSessionId);
          }

          const redirectedResult = redirectToThread(result);

          const effectiveChannelId = threadId || channelId;

          const schedulerConfig = { ...config.scheduler, timezone: config.timezone };
          const feedbackResults = await handleDiscordCommandsInResponse(
            client,
            config.timezone,
            redirectedResult,
            undefined,
            effectiveChannelId,
            undefined,
            (trimmed) => {
              const fakeMessage = { channel } as Message;
              return executeScheduleFromResponse(trimmed, fakeMessage, scheduler, schedulerConfig);
            },
            effectiveChannelId
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
            await handleDiscordCommandsInResponse(
              client,
              config.timezone,
              redirectToThread(feedbackRun.result),
              undefined,
              effectiveChannelId,
              undefined,
              undefined,
              effectiveChannelId
            );
          }

          // 結果を送信
          const filePaths = extractFilePaths(result);
          const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;
          const cleanedDisplay = stripCommandsFromDisplay(displayText).trim();

          const isSilent =
            !cleanedDisplay ||
            cleanedDisplay.includes('[SILENT]') ||
            (cleanedDisplay.length < 80 &&
              /(?:quiet\s*hours|NO_SPEAK|スキップ|終了|セッション継続)/i.test(cleanedDisplay));
          if (isSilent && filePaths.length === 0) {
            if (threadId) {
              const ch = channel as { send: (content: string) => Promise<unknown> };
              await ch.send('スキップしました');
            }
            return result;
          }

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

main().catch(console.error);
