/**
 * Discordチャンネルへのエラー通知ユーティリティ
 *
 * 環境変数 ERROR_NOTIFY_CHANNEL_ID にチャンネルIDを設定すると、
 * エラー発生時にそのチャンネルへ通知を送信する。未設定の場合は通知しない。
 */

export interface SendFn {
  (channelId: string, message: string): Promise<void>;
}

let sender: SendFn | null = null;
let channelId: string | null = null;
const DISCORD_MESSAGE_LIMIT = 1900;
const ERROR_MESSAGE_LIMIT = 700;
const DETAIL_VALUE_LIMIT = 300;

/**
 * 初期化。アプリ起動時に1回呼ぶ。
 */
export function initErrorNotify(sendFn: SendFn): void {
  const envId = process.env.ERROR_NOTIFY_CHANNEL_ID;
  if (!envId) {
    console.log('[error-notify] ERROR_NOTIFY_CHANNEL_ID not set, notifications disabled');
    return;
  }
  sender = sendFn;
  channelId = envId;
  console.log(`[error-notify] Enabled → #${channelId}`);
}

/**
 * エラーを通知する。初期化されていないか、送信に失敗しても例外は投げない。
 */
export function notifyError(
  source: string,
  errorMsg: string,
  details?: Record<string, string | number | undefined>
): void {
  if (!sender || !channelId) return;

  const truncate = (value: string, maxLength: number): string =>
    value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

  const lines = [
    `⚠️ **${source}**`,
    `**エラー:** ${truncate(errorMsg || '(不明)', ERROR_MESSAGE_LIMIT)}`,
  ];

  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) {
        lines.push(`**${key}:** ${truncate(String(value), DETAIL_VALUE_LIMIT)}`);
      }
    }
  }

  sender(channelId, truncate(lines.join('\n'), DISCORD_MESSAGE_LIMIT)).catch((err) =>
    console.error('[error-notify] Failed to send notification:', err)
  );
}

/**
 * 実行時間を見やすい文字列にする
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}
