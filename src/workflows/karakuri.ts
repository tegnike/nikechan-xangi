import {
  getEmotion,
  formatEmotion,
  recordEmotionShift,
  getMemoryEntries,
  addMemoryEntry,
  addKarakuriActivityLog,
  buildKarakuriMemoryContext,
  formatKarakuriPersonContext,
  getRecentContactEpisodes,
  addKarakuriEpisode,
  addConversationEpisode,
  addKarakuriObservationEpisode,
  ensureKarakuriUser,
  getKarakuriPersonByDisplayName,
  invalidateUserContextCache,
  type KarakuriPersonContext,
  updateKarakuriPlatformDisplayName,
  updateUserMemo,
  updateUserNickname,
  touchUser,
} from '../lib/db-helpers.js';
import { askKarakuriLLM, decideKarakuriNickname, type KarakuriDecision } from '../lib/llm.js';
import { runKarakuriCommand } from '../lib/karakuri-api.js';

// エージェント情報: "名前 (id: 16-20桁の数字)" または "名前 (16-20桁の数字)" 形式
const AGENT_ID_RE = /([^、\s(]+)\s*\((?:id:\s*)?(\d{15,20})\)/g;
// 選択肢あり判定
const HAS_CHOICES_RE = /選択肢[：:]/;
// conversation_id抽出
const CONVERSATION_ID_RE = /conversation[-_][\w-]+/i;

const RECORDABLE_COMMANDS = new Set(['move', 'action', 'use-item']);

export interface KarakuriSentReport {
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: string;
}

export interface KarakuriWorkflowOptions {
  /** Discordレポートチャンネルへの送信関数 */
  sendReport: (text: string) => Promise<KarakuriSentReport | void>;
  /** 通知元のDiscordメッセージID（1通知1アクション制限のロックキーに使用） */
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  messageCreatedAt?: string;
}

export async function runKarakuriWorkflow(
  notification: string,
  opts: KarakuriWorkflowOptions
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const now = currentJstTime();
  const hasChoices = HAS_CHOICES_RE.test(notification);
  const turnKey = opts.messageId ? `karakuri:${opts.messageId}` : `karakuri:${Date.now()}`;
  const parsedNotification = parseKarakuriNotification(notification, hasChoices);

  const requestLog = await addKarakuriActivityLog({
    discord_message_id: opts.messageId,
    channel_id: opts.channelId,
    author_id: opts.authorId,
    author_name: opts.authorName,
    message_created_at: opts.messageCreatedAt,
    message_type: hasChoices ? 'bot_request' : 'bot_notification',
    turn_key: turnKey,
    raw_content: notification,
    parsed: parsedNotification,
  }).catch((e) => {
    console.error('[karakuri] activity log request insert failed:', e);
    return null;
  });

  // ─── Step 1: 前処理（機械的）────────────────────────────────────────
  const [emotion, memoryEntries] = await Promise.all([getEmotion(), getMemoryEntries(3)]);

  const emotionText = formatEmotion(emotion);
  const memoryText = await buildKarakuriMemoryContext(notification, memoryEntries);

  // エージェント情報をusersテーブルに登録
  const people: KarakuriPersonContext[] = [];
  const peopleByAgentId = new Map<string, KarakuriPersonContext>();
  for (const match of notification.matchAll(AGENT_ID_RE)) {
    const agentName = match[1].trim();
    const agentId = match[2];
    try {
      const { person, needsMemoInit, needsNicknameInit } = await ensureKarakuriUser(
        agentId,
        agentName
      );
      await updateKarakuriPlatformDisplayName(agentId, agentName).catch(() => {});
      if (needsNicknameInit) {
        const episodes = await getRecentContactEpisodes(person.userId, 5);
        const nickname = await decideKarakuriNickname({
          name: person.name || agentName,
          displayName: agentName,
          bio: person.bio,
          relationship: person.relationship,
          episodes,
        }).catch((e) => {
          console.error(`[karakuri] nickname generation failed for ${agentId}:`, e);
          return '';
        });
        if (nickname) {
          person.nickname = nickname;
          await updateUserNickname(person.userId, nickname).catch(() => {});
        }
      }
      if (needsMemoInit) {
        await updateUserMemo(person.userId, 'AIキャラ（からくりワールドエージェント）');
      }
      people.push(person);
      peopleByAgentId.set(agentId, person);
    } catch (err) {
      console.error(`[karakuri] user-ensure failed for ${agentId} (${agentName}):`, err);
    }
  }

  for (const message of parsedNotification.conversation_messages) {
    if (isSelfSpeaker(message.speaker) || people.some((p) => p.displayName === message.speaker)) {
      continue;
    }
    try {
      const person = await getKarakuriPersonByDisplayName(message.speaker);
      if (person && !peopleByAgentId.has(person.agentId)) {
        people.push(person);
        peopleByAgentId.set(person.agentId, person);
      }
    } catch (err) {
      console.error(`[karakuri] user lookup failed for ${message.speaker}:`, err);
    }
  }

  const personText = formatKarakuriPersonContext(people);

  await addObservedSpeechEpisodes(
    now,
    requestLog?.id,
    parsedNotification.conversation_messages,
    people
  );

  // ─── Step 2: 選択肢チェック（機械的）────────────────────────────────
  if (!hasChoices) {
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

  let decision = await askKarakuriLLM(
    notification,
    emotionText,
    memoryText,
    personText,
    lastCommand
  );
  decision = enforceNicknameGuardrail(decision, people);
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
    const reportText = `⚠️ [からくりワールド] API失敗: ${errMsg.slice(0, 200)}`;
    const sent = await opts.sendReport(reportText).catch(() => undefined);
    await addKarakuriActivityLog({
      discord_message_id: sent?.messageId,
      channel_id: sent?.channelId ?? opts.channelId,
      author_id: sent?.authorId,
      author_name: sent?.authorName ?? 'AIニケちゃん',
      message_created_at: sent?.createdAt,
      message_type: 'ai_action',
      turn_key: turnKey,
      raw_content: reportText,
      parsed: {
        request_message_id: opts.messageId,
        command: decision.command,
        args: decision.args,
        message: decision.message ?? null,
        thought: decision.thought,
        api_success: false,
        error: errMsg,
      },
    }).catch((e) => console.error('[karakuri] activity log error report insert failed:', e));
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
    const firstAgentId = [...notification.matchAll(AGENT_ID_RE)][0]?.[2] ?? '';
    const firstUserId = firstAgentId ? peopleByAgentId.get(firstAgentId)?.userId : undefined;
    if (firstUserId && conversationId) {
      await addConversationEpisode(
        firstUserId,
        buildConversationEpisodeContent(now, notification, decision, people),
        conversationId
      ).catch((e) => console.error('[karakuri] ce-add-ref failed:', e));
      await touchUser(firstUserId).catch(() => {});
      await invalidateUserContextCache(firstUserId).catch(() => {});
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
  const sent = await opts.sendReport(reportText);
  await addKarakuriActivityLog({
    discord_message_id: sent?.messageId,
    channel_id: sent?.channelId ?? opts.channelId,
    author_id: sent?.authorId,
    author_name: sent?.authorName ?? 'AIニケちゃん',
    message_created_at: sent?.createdAt,
    message_type: 'ai_action',
    turn_key: turnKey,
    raw_content: reportText,
    parsed: {
      request_message_id: opts.messageId,
      command: decision.command,
      args: decision.args,
      message: decision.message ?? null,
      thought: decision.thought,
      dP: decision.dP,
      dA: decision.dA,
      dD: decision.dD,
      api_success: true,
      api_result: apiResult,
    },
  }).catch((e) => console.error('[karakuri] activity log action insert failed:', e));
}

// ─── ユーティリティ ──────────────────────────────────────────────────

function parseKarakuriNotification(notification: string, hasChoices: boolean) {
  return {
    has_choices: hasChoices,
    conversation_id: notification.match(CONVERSATION_ID_RE)?.[0] ?? null,
    participants: parseParticipants(notification),
    conversation_messages: parseConversationMessages(notification),
    next_speakers: [...notification.matchAll(/次は\s+(.+?)\s+の番です。/g)].map((m) => m[1]),
    choices: parseChoices(notification),
  };
}

function parseParticipants(notification: string) {
  const participantLine = notification.match(/^参加者:\s*(.+)$/m)?.[1];
  if (!participantLine) return [];

  return participantLine
    .split('、')
    .map((part) => {
      const match = part.trim().match(/^(.+?)\s*\(id:\s*(\d+)\)$/);
      if (!match) return null;
      return { name: match[1], id: match[2] };
    })
    .filter((p): p is { name: string; id: string } => p !== null);
}

function parseConversationMessages(notification: string) {
  return [...notification.matchAll(/^([^:\n]+):\s*「([^」]*)」/gm)].map((m) => ({
    speaker: m[1].trim(),
    message: m[2],
  }));
}

function parseChoices(notification: string) {
  const choicesBlock = notification.match(/選択肢[：:]\n([\s\S]*?)(?:\n\n|$)/)?.[1];
  if (!choicesBlock) return [];

  return choicesBlock
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (!match) return { raw: line };
      const detail = match[2];
      const argsMatch = detail.match(/^(.*?)\s*\((.+)\)$/);
      return {
        command: match[1],
        description: (argsMatch?.[1] ?? detail).trim(),
        args_hint: argsMatch?.[2] ?? null,
        raw: line,
      };
    });
}

async function addObservedSpeechEpisodes(
  now: string,
  activityLogId: string | undefined,
  messages: ReturnType<typeof parseConversationMessages>,
  people: KarakuriPersonContext[]
): Promise<void> {
  if (!activityLogId || messages.length === 0 || people.length === 0) return;

  const savedCountsByUser = new Map<string, number>();
  const observedMessages = messages.filter((m) => !isSelfSpeaker(m.speaker)).slice(-3);

  for (const [index, message] of observedMessages.entries()) {
    const person = findPersonBySpeaker(message.speaker, people);
    if (!person) continue;

    const savedCount = savedCountsByUser.get(person.userId) ?? 0;
    if (savedCount >= 2) continue;
    savedCountsByUser.set(person.userId, savedCount + 1);

    const label = person.nickname || person.displayName;
    const content = `${now} ${label}の発言を観測。「${message.message}」`.slice(0, 150);
    const sourceRecordId = `${activityLogId}:speech:${person.agentId}:${index}`;

    try {
      await addKarakuriObservationEpisode(person.userId, content, sourceRecordId);
      await touchUser(person.userId).catch(() => {});
      await invalidateUserContextCache(person.userId).catch(() => {});
    } catch (e) {
      console.error('[karakuri] observation ce-add-ref failed:', e);
    }
  }
}

function isSelfSpeaker(speaker: string): boolean {
  return ['AIニケちゃん', 'ニケ', 'あなた'].includes(speaker.trim());
}

function findPersonBySpeaker(
  speaker: string,
  people: KarakuriPersonContext[]
): KarakuriPersonContext | undefined {
  const normalizedSpeaker = speaker.trim();
  return people.find((person) =>
    [person.displayName, person.name, person.nickname]
      .filter((name): name is string => Boolean(name))
      .includes(normalizedSpeaker)
  );
}

function enforceNicknameGuardrail(decision: KarakuriDecision, people: KarakuriPersonContext[]) {
  if (!decision.message || people.length === 0) return decision;

  let message = decision.message;
  for (const person of people) {
    const canonical = person.nickname;
    const aliases = [...new Set([person.displayName, person.name, person.agentId].filter(Boolean))]
      .filter((alias): alias is string => alias !== canonical)
      .sort((a, b) => b.length - a.length);

    for (const alias of aliases) {
      message = message.replace(new RegExp(escapeRegExp(alias), 'g'), canonical || 'あなた');
    }

    if (canonical) {
      message = message.replace(
        new RegExp(`${escapeRegExp(canonical)}(さん|ちゃん|くん|様|さま)`, 'g'),
        canonical
      );
    }
  }

  if (message !== decision.message) {
    return { ...decision, message };
  }
  return decision;
}

function buildConversationEpisodeContent(
  now: string,
  notification: string,
  decision: KarakuriDecision,
  people: KarakuriPersonContext[]
): string {
  const targetId = decision.args.split(/\s+/)[0] || [...notification.matchAll(AGENT_ID_RE)][0]?.[2];
  const target = targetId ? people.find((p) => p.agentId === targetId) : people[0];
  const targetName = target?.nickname || target?.displayName || '相手';
  const messages = parseConversationMessages(notification)
    .slice(-2)
    .map((m) => `${m.speaker}: ${m.message}`)
    .join(' / ');
  const closing = decision.message ? ` こちらは「${decision.message}」と伝えた。` : '';
  const body = `${now} ${targetName}との会話を終了。${messages || decision.thought}${closing} 判断: ${decision.thought}`;
  return body.slice(0, 150);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
