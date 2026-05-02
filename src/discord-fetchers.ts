import { ChannelType, type Client, type Message } from 'discord.js';
import { sanitizeChannelMentions } from './message-utils.js';

/** Discordリンクからメッセージ内容を取得する */
export async function fetchDiscordLinkContent(client: Client, text: string): Promise<string> {
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
    }
  }

  return result;
}

/** 返信元メッセージを取得してプロンプトに追加する */
export async function fetchReplyContent(message: Message): Promise<string | null> {
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

/** チャンネルメンションから最新メッセージを取得する */
export async function fetchChannelMessages(
  client: Client,
  text: string,
  timezone: string
): Promise<string> {
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
            const time = m.createdAt.toLocaleString('ja-JP', { timeZone: timezone });
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

/** スレッド内会話の直近文脈を取得する */
export async function fetchThreadContext(
  message: Message,
  timezone: string
): Promise<string | null> {
  const isThread =
    message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread;
  if (!isThread || !('messages' in message.channel)) return null;

  try {
    const messages = await message.channel.messages.fetch({ limit: 12 });
    const list = messages
      .reverse()
      .map((m) => {
        const time = m.createdAt.toLocaleString('ja-JP', { timeZone: timezone });
        const content = sanitizeChannelMentions(m.content || '(添付ファイルのみ)');
        const marker = m.id === message.id ? '最新' : '';
        return `[${time}]${marker ? ` ${marker}` : ''} ${m.author.tag}: ${content}`;
      })
      .join('\n');
    const threadChannel = message.channel as { id: string; name?: string };
    const threadName = threadChannel.name || threadChannel.id;
    return [
      '---',
      `Discordスレッド #${threadName} の直近文脈です。`,
      'このスレッド内の人間の発言は、基本的にあなたへの返信として扱ってください。',
      '単なる感謝や確認にも、文脈に沿って短く自然に返答してください。',
      list,
      '---',
    ].join('\n');
  } catch (err) {
    console.error('[xangi] Failed to fetch thread context:', err);
    return null;
  }
}
