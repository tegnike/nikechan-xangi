import type { Message } from 'discord.js';
import type { AgentRunner } from './agent-runner.js';
import type { loadConfig } from './config.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { splitMessage } from './message-utils.js';
import { DISCORD_SAFE_LENGTH } from './constants.js';
import { extractFilePaths, stripFilePaths } from './file-utils.js';
import { getSession, setSession } from './sessions.js';
import { loadSettings, saveSettings } from './settings.js';

/**
 * テキストから !discord send コマンドを抽出し、残りのテキストを返す
 * スケジューラプロンプトからコマンドを分離するために使用
 * コードブロック内のコマンドは無視する
 */
export function extractDiscordSendFromPrompt(text: string): {
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
export function stripCommandsFromDisplay(text: string): string {
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

    // !discord send の複数行対応: コマンド行（!discord send <#id>）のみ除去し、本文は残す
    // これにより !discord send が失敗してもフォールバックの display text に本文が残る
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#\d+>\s*(.*)/);
    if (sendMatch) {
      // 同一行に本文がある場合は残す
      if (sendMatch[1]) {
        result.push(sendMatch[1]);
      }
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
        result.push(bodyLine); // 本文行は除去しない
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

/**
 * AIの応答から SYSTEM_COMMAND: を検知して実行
 * 形式: SYSTEM_COMMAND:restart / SYSTEM_COMMAND:set key=value
 */
export function handleSettingsFromResponse(text: string): void {
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

export async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: ReturnType<typeof loadConfig>,
  disallowedTools?: string[]
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

    // !skip または disallowedTools がある場合、ワンショットランナーを使用
    // （PersistentRunner はプロセス起動時にフラグを設定するため、リクエスト単位での変更不可）
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    const needsSkipRunner = skipPermissions && !defaultSkip;
    const needsDisallowRunner = (disallowedTools?.length ?? 0) > 0;
    const runner: AgentRunner =
      needsSkipRunner || needsDisallowRunner
        ? new ClaudeCodeRunner(config.agent.config)
        : agentRunner;

    if (needsSkipRunner) {
      console.log(`[xangi] Using one-shot skip runner for channel ${channelId}`);
    }
    if (needsDisallowRunner) {
      console.log(
        `[xangi] Using one-shot disallow runner for channel ${channelId} (${disallowedTools?.join(', ')})`
      );
    }

    // ベース絵文字（処理中ずっと表示、完了時に外す）
    await message.react('👀').catch(() => {});

    // フェーズに応じたリアクション絵文字
    const phaseEmojis = { thinking: '🧠', tool_use: '🔧', text: '✍️' } as const;
    let currentPhaseEmoji: string | null = null;

    const updatePhaseReaction = async (emoji: string) => {
      if (emoji === currentPhaseEmoji) return;
      const botUserId = message.client.user?.id;
      if (currentPhaseEmoji) {
        await message.reactions.cache
          .find((r) => r.emoji.name === currentPhaseEmoji)
          ?.users.remove(botUserId)
          .catch(() => {});
      }
      currentPhaseEmoji = emoji;
      await message.react(emoji).catch(() => {});
    };

    await updatePhaseReaction(phaseEmojis.thinking);

    let result: string;
    let newSessionId: string;
    let sentLength = 0;

    if (useStreaming && showThinking && !needsSkipRunner && !needsDisallowRunner) {
      const PARTIAL_SEND_DELAY_MS = 5000;
      let partialTimer: ReturnType<typeof setTimeout> | null = null;
      let isFirstReply = true;
      let pendingSend: Promise<void> | null = null;

      const sendPartialText = async (text: string) => {
        const unsent = text.slice(sentLength);
        if (!unsent.trim()) return;

        const cleaned = stripCommandsFromDisplay(stripFilePaths(unsent));
        if (!cleaned.trim()) return;

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
        { skipPermissions, sessionId, channelId, disallowedTools }
      );
      if (partialTimer) clearTimeout(partialTimer);
      if (pendingSend) await pendingSend;

      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      const runResult = await runner.run(prompt, {
        skipPermissions,
        sessionId,
        channelId,
        disallowedTools,
      });
      result = runResult.result;
      newSessionId = runResult.sessionId;
    }

    setSession(channelId, newSessionId);
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // [SILENT] チェック
    const strippedResult = stripCommandsFromDisplay(stripFilePaths(result)).trim();
    if (strippedResult.includes('[SILENT]')) {
      console.log(`[xangi] [SILENT] detected, skipping Discord reply`);
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
        const channel = message.channel as unknown as {
          send: (content: string) => Promise<unknown>;
        };
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    } else if (sentLength === 0) {
      const hasDiscordCommands = /^!discord\s+send\s+/m.test(result);
      if (!hasDiscordCommands) {
        await message.reply('✅');
      }
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

    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      await message.reply('🛑 停止しました').catch(() => {});
      return null;
    }
    console.error('[xangi] Error:', error);

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
    const sid = getSession(channelId);
    if (sid) errorDetail += `\n\`[session: ${sid.slice(0, 8)}]\``;

    await message.reply(errorDetail).catch(() => {});

    // エラー後にエージェントへ自動フォローアップ
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
