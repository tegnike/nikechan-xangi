import type { Client, Message } from 'discord.js';
import { chunkDiscordMessage, sanitizeChannelMentions } from './message-utils.js';

export interface DiscordCommandResult {
  handled: boolean;
  response?: string;
  feedback?: boolean;
}

/**
 * !discord コマンドを処理する関数
 * feedback: true の場合、response をDiscordに送信せずエージェントに再注入する
 */
export async function handleDiscordCommand(
  client: Client,
  text: string,
  timezone: string,
  sourceMessage?: Message,
  fallbackChannelId?: string,
  options?: { enforceChannelId?: string }
): Promise<DiscordCommandResult> {
  // !discord send <#channelId> message (複数行対応)
  const sendMatch = text.match(/^!discord\s+send\s+<#(\d+)>\s+(.+)$/s);
  if (sendMatch) {
    let channelId = sendMatch[1];
    // スケジュール実行時: 指定チャンネル以外への送信を強制リダイレクト
    if (options?.enforceChannelId && channelId !== options.enforceChannelId) {
      console.log(
        `[xangi] Enforcing channelId for send: <#${channelId}> -> <#${options.enforceChannelId}>`
      );
      channelId = options.enforceChannelId;
    }
    const content = sendMatch[2];
    try {
      let channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel && fallbackChannelId && channelId !== fallbackChannelId) {
        console.warn(
          `[xangi] Channel ${channelId} not found, falling back to ${fallbackChannelId}`
        );
        channel = await client.channels.fetch(fallbackChannelId);
      }
      if (channel && 'send' in channel) {
        const typedChannel = channel as {
          send: (options: {
            content: string;
            allowedMentions: { parse: never[] };
          }) => Promise<unknown>;
        };
        const chunks = chunkDiscordMessage(content, 2000);
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

  // !discord send-image <#channelId> /path/to/image.png メッセージ（任意）
  const sendImageMatch = text.match(/^!discord\s+send-image\s+<#(\d+)>\s+(\/\S+)(?:\s+(.+))?$/s);
  if (sendImageMatch) {
    let imgChannelId = sendImageMatch[1];
    // スケジュール実行時: 指定チャンネル以外への送信を強制リダイレクト
    if (options?.enforceChannelId && imgChannelId !== options.enforceChannelId) {
      console.log(
        `[xangi] Enforcing channelId for send-image: <#${imgChannelId}> -> <#${options.enforceChannelId}>`
      );
      imgChannelId = options.enforceChannelId;
    }
    const filePath = sendImageMatch[2];
    const message = sendImageMatch[3];
    try {
      const { existsSync } = await import('node:fs');
      if (!existsSync(filePath)) {
        console.error(`[xangi] File not found: ${filePath}`);
        return { handled: true, response: `❌ ファイルが見つかりません: ${filePath}` };
      }
      let channel = await client.channels.fetch(imgChannelId).catch(() => null);
      if (!channel && fallbackChannelId && imgChannelId !== fallbackChannelId) {
        console.warn(
          `[xangi] Channel ${imgChannelId} not found, falling back to ${fallbackChannelId}`
        );
        channel = await client.channels.fetch(fallbackChannelId);
      }
      if (channel && 'send' in channel) {
        const typedChannel = channel as {
          send: (options: {
            content?: string;
            files: { attachment: string }[];
            allowedMentions: { parse: never[] };
          }) => Promise<unknown>;
        };
        await typedChannel.send({
          ...(message ? { content: message } : {}),
          files: [{ attachment: filePath }],
          allowedMentions: { parse: [] },
        });
        const channelName = 'name' in channel ? channel.name : 'unknown';
        console.log(`[xangi] Sent image to #${channelName}: ${filePath}`);
        return {
          handled: true,
          response: `✅ #${channelName} に画像を送信しました`,
        };
      }
    } catch (err) {
      console.error(`[xangi] Failed to send image to channel: ${imgChannelId}`, err);
      return { handled: true, response: `❌ 画像の送信に失敗しました` };
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
          .filter((c) => c.type === 0)
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
            const time = m.createdAt.toLocaleString('ja-JP', { timeZone: timezone });
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
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: timezone });
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
        if (msg.author.id !== client.user?.id) {
          return {
            handled: true,
            feedback: true,
            response: '❌ 自分のメッセージのみ削除できます',
          };
        }
        await msg.delete();
        const deletedChannelId = targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
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
export async function handleDiscordCommandsInResponse(
  client: Client,
  timezone: string,
  text: string,
  sourceMessage?: Message,
  fallbackChannelId?: string,
  skipChannelId?: string,
  onScheduleCommand?: (trimmed: string) => Promise<void>,
  enforceChannelId?: string
): Promise<string[]> {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let i = 0;
  const feedbackResults: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      i++;
      continue;
    }

    if (inCodeBlock) {
      i++;
      continue;
    }

    const trimmed = line.trim();

    // !discord send の複数行対応
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      if (skipChannelId && sendMatch[1] === skipChannelId) {
        console.log(
          `[xangi] Skipping !discord send to same channel <#${skipChannelId}> (already sent via streaming)`
        );
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
          const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
          console.log(
            `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(
            client,
            commandText,
            timezone,
            sourceMessage,
            fallbackChannelId,
            enforceChannelId ? { enforceChannelId } : undefined
          );
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
        continue;
      } else {
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
        const result = await handleDiscordCommand(
          client,
          commandText,
          timezone,
          sourceMessage,
          fallbackChannelId
        );
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

    // その他の !discord コマンド（channels, search, history, send-image）
    if (trimmed.startsWith('!discord ')) {
      console.log(`[xangi] Processing discord command from response: ${trimmed.slice(0, 50)}...`);
      const result = await handleDiscordCommand(
        client,
        trimmed,
        timezone,
        sourceMessage,
        fallbackChannelId,
        enforceChannelId ? { enforceChannelId } : undefined
      );
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
    if (
      onScheduleCommand &&
      sourceMessage &&
      (trimmed === '!schedule' || trimmed.startsWith('!schedule '))
    ) {
      console.log(`[xangi] Processing schedule command from response: ${trimmed.slice(0, 50)}...`);
      await onScheduleCommand(trimmed);
    }

    i++;
  }

  return feedbackResults;
}
