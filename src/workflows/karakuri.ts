import {
  getEmotion,
  formatEmotion,
  recordEmotionShift,
  getMemoryEntries,
  addMemoryEntry,
  formatMemory,
  addKarakuriEpisode,
  addConversationEpisode,
  ensureKarakuriUser,
  updateUserMemo,
  touchUser,
} from '../lib/db-helpers.js';
import { askKarakuriLLM } from '../lib/llm.js';
import { runKarakuriCommand } from '../lib/karakuri-api.js';

// エージェント情報: "名前 (16-20桁の数字)" 形式
const AGENT_ID_RE = /([^\s(]+)\s*\((\d{15,20})\)/g;
// 選択肢あり判定
const HAS_CHOICES_RE = /選択肢[：:]/;
// conversation_id抽出
const CONVERSATION_ID_RE = /conversation[-_][\w-]+/i;

const RECORDABLE_COMMANDS = new Set(['move', 'action', 'use-item']);

export interface KarakuriWorkflowOptions {
  /** Discordレポートチャンネルへの送信関数 */
  sendReport: (text: string) => Promise<void>;
  /** 通知元のDiscordメッセージID（1通知1アクション制限のロックキーに使用） */
  messageId?: string;
}

export async function runKarakuriWorkflow(
  notification: string,
  opts: KarakuriWorkflowOptions
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const now = currentJstTime();

  // ─── Step 1: 前処理（機械的）────────────────────────────────────────
  const [emotion, memoryEntries] = await Promise.all([getEmotion(), getMemoryEntries(3)]);

  const emotionText = formatEmotion(emotion);
  const memoryText = formatMemory(memoryEntries);

  // エージェント情報をusersテーブルに登録
  for (const match of notification.matchAll(AGENT_ID_RE)) {
    const agentName = match[1].trim();
    const agentId = match[2];
    try {
      const { needsMemoInit } = await ensureKarakuriUser(agentId, agentName);
      if (needsMemoInit) {
        await updateUserMemo(agentId, 'AIキャラ（からくりワールドエージェント）');
      }
    } catch (err) {
      console.error(`[karakuri] user-ensure failed for ${agentId} (${agentName}):`, err);
    }
  }

  // ─── Step 2: 選択肢チェック（機械的）────────────────────────────────
  if (!HAS_CHOICES_RE.test(notification)) {
    // 選択肢なし → 通知内容を記憶に残して終了
    await addMemoryEntry({
      event_date: today,
      event_time: now,
      action: firstLine(notification),
    }).catch((e) => console.error('[karakuri] addMemoryEntry failed:', e));
    return;
  }

  // ─── Step 3: LLM判断（1回のみ）──────────────────────────────────────
  // 直近の記憶から最後のコマンドを取得（情報収集コマンドの連続実行を防ぐため）
  const lastCommand =
    memoryEntries.length > 0
      ? (memoryEntries[memoryEntries.length - 1].action?.split(' ')[0] ?? '')
      : '';

  const decision = await askKarakuriLLM(notification, emotionText, memoryText, lastCommand);
  console.log(
    `[karakuri] LLM decision: ${decision.command} ${decision.args} | ${decision.thought}`
  );

  // ─── Step 4: アクション実行（機械的）────────────────────────────────
  let apiResult = '';
  let apiSuccess = false;
  try {
    apiResult = await runKarakuriCommand(
      decision.command,
      decision.args,
      decision.message,
      opts.messageId
    );
    console.log(`[karakuri] API result: ${apiResult.slice(0, 100)}`);
    // busyレスポンスは実行失敗扱い
    apiSuccess = !apiResult.startsWith('busy:');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[karakuri] API call failed:', err);
    await opts.sendReport(`⚠️ [からくりワールド] API失敗: ${errMsg.slice(0, 200)}`).catch(() => {});
  }

  // API失敗時は後処理をスキップ
  if (!apiSuccess) return;

  // ─── Step 5: 後処理（機械的）────────────────────────────────────────

  // 感情変動を記録（LLMが文脈から判断した値を使用）
  if (decision.dP !== 0 || decision.dA !== 0 || decision.dD !== 0) {
    await recordEmotionShift(
      decision.dP,
      decision.dA,
      decision.dD,
      'karakuri-world',
      `${decision.command} ${decision.args}`.trim(),
      decision.thought
    ).catch((e) => console.error('[karakuri] emotion-shift failed:', e));
  }

  // エピソード記録（コマンド種別で排他）
  const isConvEnd = ['conversation-end', 'conversation-leave'].includes(decision.command);
  if (isConvEnd) {
    const conversationId = notification.match(CONVERSATION_ID_RE)?.[0] ?? '';
    const firstAgentId = notification.match(AGENT_ID_RE)?.[0]?.match(/\((\d{15,20})\)/)?.[1] ?? '';
    if (firstAgentId && conversationId) {
      await addConversationEpisode(
        firstAgentId,
        `${now} ${decision.thought || decision.command}`,
        conversationId
      ).catch((e) => console.error('[karakuri] ce-add-ref failed:', e));
      await touchUser(firstAgentId).catch(() => {});
    }
  } else if (RECORDABLE_COMMANDS.has(decision.command)) {
    const content = `${now} ${decision.command} ${decision.args}. ${decision.thought}`.trim();
    await addKarakuriEpisode(today, content).catch((e) =>
      console.error('[karakuri] ep-add failed:', e)
    );
  }

  // 記憶に今回のエントリを追加 + 古いエントリを削除
  await addMemoryEntry({
    event_date: today,
    event_time: now,
    action: `${decision.command} ${decision.args}`.trim(),
    thought: decision.thought || undefined,
  }).catch((e) => console.error('[karakuri] addMemoryEntry failed:', e));

  // Discordレポート（アクションした場合のみ）
  const reportText = buildReportText(decision.command, decision.args, decision.message);
  await opts.sendReport(reportText);
}

// ─── ユーティリティ ──────────────────────────────────────────────────

function currentJstTime(): string {
  return new Date().toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo',
  });
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 100);
}

function buildReportText(command: string, args: string, message?: string | null): string {
  const argStr = args.trim() ? ` ${args.trim()}` : '';
  const msgStr = message ? ` 「${message}」` : '';
  return `[からくりワールド] ${command}${argStr}${msgStr}`;
}
