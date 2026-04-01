import { SCHEDULE_SEPARATOR, type ScheduleType } from './scheduler.js';

/** メッセージを指定文字数で分割（カスタムセパレータ対応、デフォルトは行単位） */
export function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
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
export function splitScheduleContent(content: string, maxLength: number): string[] {
  const sep = '\n' + SCHEDULE_SEPARATOR + '\n';
  const chunks = splitMessage(content, maxLength, sep);
  return chunks.map((c) => c.replaceAll(SCHEDULE_SEPARATOR, ''));
}

/** スケジュールタイプに応じたラベルを生成 */
export function getTypeLabel(
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

/** Discord の 2000 文字制限に合わせてメッセージを分割する */
export function chunkDiscordMessage(message: string, limit: number): string[] {
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

/** メッセージコンテンツ内のチャンネルメンション <#ID> を無害化する */
export function sanitizeChannelMentions(content: string): string {
  return content.replace(/<#(\d+)>/g, '#$1');
}

/** チャンネルメンション <#ID> にチャンネルID注釈を追加 */
export function annotateChannelMentions(text: string): string {
  return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
}
