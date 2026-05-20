import {
  getEmotion,
  formatEmotion,
  recordEmotionShift,
  getMemoryEntries,
  addMemoryEntry,
  addKarakuriActivityLog as addKarakuriActivityLogRaw,
  addKarakuriCommitment,
  buildKarakuriMemoryContext,
  formatKarakuriPersonContext,
  getRecentContactEpisodes,
  getPendingKarakuriCommitments,
  addKarakuriEpisode,
  addConversationEpisode,
  addKarakuriObservationEpisode,
  ensureKarakuriUser,
  getKarakuriPersonByDisplayName,
  invalidateUserContextCache,
  type KarakuriCommitment,
  type KarakuriCommitmentInput,
  type KarakuriActivityLogInput,
  type KarakuriActivityLogRow,
  type MemoryEntry,
  type KarakuriPersonContext,
  updateKarakuriCommitmentStatus,
  updateKarakuriPlatformDisplayName,
  updateUserMemo,
  updateUserNickname,
  touchUser,
} from '../lib/db-helpers.js';
import { askKarakuriLLM, decideKarakuriNickname, type KarakuriDecision } from '../lib/llm.js';
import { runKarakuriCommand } from '../lib/karakuri-api.js';
import { getNikechanCoreAudit } from '../lib/nikechan-core.js';
import { assertPublicEgressAllowed } from '../lib/public-safety.js';
import { formatWorkflowReportForDiscord, resolveWorkflowControl } from '../lib/workflow-manager.js';
import { createWorkflowReport, type WorkflowReportStatus } from '../lib/workflow-report.js';

// エージェント情報: "名前 (id: 16-20桁の数字)" または "名前 (16-20桁の数字)" 形式
const AGENT_ID_RE = /([^、\s(]+)\s*\((?:id:\s*)?(\d{15,20})\)/g;
// 選択肢あり判定
const HAS_CHOICES_RE = /選択肢[：:]/;
// conversation_id抽出
const CONVERSATION_ID_RE = /conversation[-_][\w-]+/i;

function addKarakuriActivityLog(
  input: KarakuriActivityLogInput
): Promise<KarakuriActivityLogRow | null> {
  const requestedDryRun = process.env.KARAKURI_WORKFLOW_DRY_RUN === 'true';
  const control = resolveWorkflowControl('karakuri', requestedDryRun);
  const coreAudit = getNikechanCoreAudit('xangi-world-karakuri');
  return addKarakuriActivityLogRaw({
    ...input,
    parsed: {
      nikechan_core: coreAudit,
      release_mode: control.releaseMode,
      workflow_report: createWorkflowReport({
        surface: 'karakuri',
        workflow: 'karakuri-world',
        status: karakuriReportStatus(input.message_type, input.parsed),
        summary: input.raw_content,
        actions: buildKarakuriReportActions(input.parsed),
        sourceRefs: input.turn_key ? [`turn:${input.turn_key}`] : [],
        audit: {
          releaseMode: control.releaseMode,
          dryRun: control.dryRun,
          coreProfile: stringField(coreAudit, 'profileId'),
          coreStatus: stringField(coreAudit, 'status'),
        },
        nextAction: karakuriNextAction(input.parsed),
        error: stringField(input.parsed, 'error'),
      }),
      ...(input.parsed ?? {}),
    },
  });
}

function karakuriReportStatus(
  messageType: KarakuriActivityLogInput['message_type'],
  parsed?: Record<string, unknown>
): WorkflowReportStatus {
  if (typeof parsed?.error === 'string') return 'failed';
  if (parsed?.dry_run === true) return 'dry-run';
  if (parsed?.skipped === true || messageType === 'bot_notification') return 'skipped';
  if (parsed?.api_success === false) return 'blocked';
  return 'success';
}

function buildKarakuriReportActions(parsed?: Record<string, unknown>) {
  const command = stringField(parsed, 'command');
  if (!command) return [];
  const args = stringField(parsed, 'args') ?? '';
  return [
    {
      type: command,
      label: `${command}${args ? ` ${args}` : ''}`,
      status: karakuriReportStatus('ai_action', parsed),
    },
  ];
}

function karakuriNextAction(parsed?: Record<string, unknown>): string | undefined {
  if (typeof parsed?.error === 'string') return 'inspect karakuri workflow failure';
  if (parsed?.api_success === false) return 'check karakuri API state before retry';
  return undefined;
}

function buildKarakuriManagerReport(input: {
  turnKey: string;
  decision: KarakuriDecision;
  status: WorkflowReportStatus;
  summary: string;
  releaseMode: string;
  dryRun: boolean;
  nextAction?: string;
  error?: string;
}) {
  return createWorkflowReport({
    surface: 'karakuri',
    workflow: 'karakuri-world',
    status: input.status,
    summary: input.summary,
    actions: [
      {
        type: input.decision.command,
        label: `${input.decision.command}${input.decision.args ? ` ${input.decision.args}` : ''}`,
        status: input.status,
      },
    ],
    sourceRefs: [`turn:${input.turnKey}`],
    audit: {
      releaseMode: input.releaseMode,
      dryRun: input.dryRun,
      coreProfile: 'xangi-world-karakuri',
    },
    nextAction: input.nextAction,
    error: input.error,
  });
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

const RECORDABLE_COMMANDS = new Set([
  'move',
  'action',
  'use-item',
  'transfer',
  'transfer-accept',
  'transfer-reject',
]);
const INFO_COMMANDS = new Set([
  'perception',
  'actions',
  'map',
  'world-agents',
  'status',
  'nearby-agents',
  'active-conversations',
  'event',
]);
const SELF_AGENT_ID = '1470446478261747854';
const COMMITMENT_PRIORITY_WINDOW_MS = 90 * 60 * 1000;
const COMMITMENT_GRACE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface ParsedKarakuriChoice extends Record<string, unknown> {
  command?: string;
  description?: string;
  args_hint?: string | null;
  params: Record<string, string>;
  raw: string;
}

export interface ParsedKarakuriNotification extends Record<string, unknown> {
  has_choices: boolean;
  conversation_id: string | null;
  participants: { name: string; id: string }[];
  conversation_messages: { speaker: string; message: string }[];
  next_speakers: string[];
  choices: ParsedKarakuriChoice[];
}

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
  const today = currentJstDate();
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
  const [emotion, memoryEntries, pendingCommitments] = await Promise.all([
    getEmotion(),
    getMemoryEntries(3),
    getPendingKarakuriCommitments(8).catch((e) => {
      console.error('[karakuri] getPendingKarakuriCommitments failed:', e);
      return [] as KarakuriCommitment[];
    }),
  ]);

  const emotionText = formatEmotion(emotion);
  const memoryText = await buildKarakuriMemoryContext(
    notification,
    memoryEntries,
    pendingCommitments
  );

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
        const episodes = await getRecentContactEpisodes(person.userId, 5, 'karakuri');
        const nickname = await decideKarakuriNickname({
          name: person.name || agentName,
          displayName: agentName,
          bio: person.bio,
          relationship: person.relationshipPublic,
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

  const messages = mergeCommitmentMessages(parsedNotification.conversation_messages, notification);
  for (const message of messages) {
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
  await addCommitmentsFromNotification(
    today,
    requestLog?.id,
    notification,
    parsedNotification,
    people
  );
  await markArrivedCommitments(notification, pendingCommitments);

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
  decision = normalizeKarakuriDecision(decision, parsedNotification);
  decision = prioritizeDueCommitment(
    decision,
    pendingCommitments,
    parsedNotification,
    notification
  );
  decision = applyKarakuriBehaviorGuards(decision, parsedNotification, memoryEntries);
  console.log(
    `[karakuri] LLM decision: ${decision.command} ${decision.args} | ${decision.thought}`
  );

  const validationError = validateKarakuriDecision(decision, parsedNotification);
  if (validationError) {
    console.warn(`[karakuri] Skip invalid decision: ${validationError}`);
    await addSkippedActionLog({
      opts,
      turnKey,
      decision,
      reason: validationError,
    });
    return;
  }

  // ─── Step 4: アクション実行（機械的）────────────────────────────────
  let apiResult = '';
  let apiSuccess = false;
  const control = resolveWorkflowControl(
    'karakuri',
    process.env.KARAKURI_WORKFLOW_DRY_RUN === 'true'
  );
  const dryRun = control.dryRun;
  try {
    await assertPublicEgressAllowed(
      'karakuri',
      [decision.command, decision.args, decision.message].filter(Boolean).join(' ')
    );
    if (dryRun) {
      apiResult = `KARAKURI dry-run: ${decision.command} ${decision.args}`.trim();
    } else {
      apiResult = await runKarakuriCommand(
        decision.command,
        decision.args,
        decision.message,
        opts.messageId
      );
    }
    console.log(`[karakuri] API result: ${apiResult.slice(0, 100)}`);
    if (apiResult.startsWith('busy:')) {
      await addSkippedActionLog({
        opts,
        turnKey,
        decision,
        reason: apiResult,
      });
      return;
    }
    apiSuccess = true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[karakuri] API call failed:', err);
    const reportText = `⚠️ [からくりワールド] API失敗: ${errMsg.slice(0, 200)}`;
    const managerReport = buildKarakuriManagerReport({
      turnKey,
      decision,
      status: 'failed',
      summary: 'karakuri API failed',
      releaseMode: control.releaseMode,
      dryRun,
      error: errMsg,
      nextAction: 'check karakuri API state before retry',
    });
    const sent = toSentReport(
      await opts
        .sendReport(formatWorkflowReportForDiscord(managerReport, reportText))
        .catch(() => undefined)
    );
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

  if (dryRun) {
    const reportText = `🧪 [からくりワールド] dry-run: ${buildReportText(decision.command, decision.args, decision.message)}`;
    const managerReport = buildKarakuriManagerReport({
      turnKey,
      decision,
      status: 'dry-run',
      summary: `planned ${decision.command} ${decision.args}`.trim(),
      releaseMode: control.releaseMode,
      dryRun,
    });
    const sent = toSentReport(
      await opts.sendReport(formatWorkflowReportForDiscord(managerReport, reportText))
    );
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
        dry_run: true,
        api_success: false,
        api_result: apiResult,
      },
    }).catch((e) => console.error('[karakuri] activity log dry-run insert failed:', e));
    return;
  }

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
    thought: INFO_COMMANDS.has(decision.command)
      ? compactApiResult(apiResult)
      : decision.thought || undefined,
  }).catch((e) => console.error('[karakuri] addMemoryEntry failed:', e));

  // Discordレポート（アクションした場合のみ）
  const reportText = buildReportText(decision.command, decision.args, decision.message);
  const managerReport = buildKarakuriManagerReport({
    turnKey,
    decision,
    status: 'success',
    summary: `executed ${decision.command} ${decision.args}`.trim(),
    releaseMode: control.releaseMode,
    dryRun,
  });
  const sent = toSentReport(
    await opts.sendReport(formatWorkflowReportForDiscord(managerReport, reportText))
  );
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

export function parseKarakuriNotification(
  notification: string,
  hasChoices: boolean
): ParsedKarakuriNotification {
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
  return [...notification.matchAll(AGENT_ID_RE)].map((match) => ({
    name: match[1].trim(),
    id: match[2],
  }));
}

function parseConversationMessages(notification: string) {
  return [...notification.matchAll(/(?:^|[\s\u3000])([^:\s\u3000]{1,40}):\s*「([^」]*)」/g)].map(
    (m) => ({
      speaker: m[1].trim(),
      message: m[2],
    })
  );
}

function parseChoices(notification: string) {
  const choicesBlock = notification.match(
    /選択肢[：:]\s*([\s\S]*?)(?:\s+karakuri-world\s+スキル|$)/
  )?.[1];
  if (!choicesBlock) return [];

  return choicesBlock
    .replace(/(?:^|\s+)-\s*/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
      if (!match) return { params: {}, raw: line };
      const command = normalizeCommand(match[1]);
      const detail = match[2].trim();
      const argsMatch = detail.match(/^(.*?)\s*\((.+)\)$/);
      return {
        command,
        description: (argsMatch?.[1] ?? detail).trim(),
        args_hint: argsMatch?.[2] ?? null,
        params: parseChoiceParams(argsMatch?.[2] ?? ''),
        raw: `${match[1]}: ${detail}`,
      };
    });
}

function parseChoiceParams(argsHint: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of argsHint.matchAll(/([a-zA-Z_]+):\s*([^,)、)]+)/g)) {
    params[match[1]] = match[2].trim();
  }
  return params;
}

function toSentReport(value: KarakuriSentReport | void): KarakuriSentReport | undefined {
  return value || undefined;
}

export function normalizeCommand(command: string): string {
  const normalized = command.trim().replace(/_/g, '-');
  const aliases: Record<string, string> = {
    'end-conversation': 'conversation-end',
    use_item: 'use-item',
    transfer_accept: 'transfer-accept',
    transfer_reject: 'transfer-reject',
    'get-available-actions': 'actions',
    'get-perception': 'perception',
    'get-map': 'map',
    'get-world-agents': 'world-agents',
    'get-status': 'status',
    'get-nearby-agents': 'nearby-agents',
    'get-active-conversations': 'active-conversations',
    'get-event': 'event',
  };
  return aliases[normalized] ?? normalized;
}

export function normalizeKarakuriDecision(
  decision: KarakuriDecision,
  parsedNotification: ParsedKarakuriNotification
): KarakuriDecision {
  let command = normalizeCommand(decision.command);
  let args = decision.args.trim();

  const firstArg = args.split(/\s+/)[0] ?? '';
  const nestedCommand = firstArg ? normalizeCommand(firstArg) : '';
  if (command === 'action' && ['use-item', 'wait', 'move', 'transfer'].includes(nestedCommand)) {
    command = nestedCommand;
    args = args.split(/\s+/).slice(1).join(' ');
  }

  if (command === 'conversation-start') {
    const targetId = resolveConversationStartTarget(args, parsedNotification.choices);
    if (targetId) args = targetId;
  }

  return { ...decision, command, args };
}

function resolveConversationStartTarget(
  args: string,
  choices: ParsedKarakuriChoice[]
): string | null {
  const target = args.split(/\s+/)[0] ?? '';
  if (/^\d{15,20}$/.test(target)) return target;
  if (!target) return null;

  const choice = choices.find(
    (c) =>
      c.command === 'conversation-start' &&
      c.params.target_agent_id &&
      (c.raw.includes(target) || c.description?.includes(target))
  );
  return choice?.params.target_agent_id ?? null;
}

export function validateKarakuriDecision(
  decision: KarakuriDecision,
  parsedNotification: ParsedKarakuriNotification
): string | null {
  const commandChoices = parsedNotification.choices.filter((choice) => choice.command);
  if (
    commandChoices.length > 0 &&
    !commandChoices.some((choice) => choice.command === decision.command)
  ) {
    return `通知の選択肢にないコマンドです: ${decision.command}`;
  }

  const firstArg = decision.args.split(/\s+/)[0] ?? '';
  if (decision.command === 'conversation-start') {
    const allowedTargets = parsedNotification.choices
      .filter((choice) => choice.command === 'conversation-start')
      .map((choice) => choice.params.target_agent_id)
      .filter((id): id is string => Boolean(id));

    if (!/^\d{15,20}$/.test(firstArg)) {
      return `conversation-start の target_agent_id が不正です: ${firstArg || '(empty)'}`;
    }
    if (allowedTargets.length > 0 && !allowedTargets.includes(firstArg)) {
      return `conversation-start の target_agent_id が通知の選択肢にありません: ${firstArg}`;
    }
  }

  if (['conversation-speak', 'conversation-end'].includes(decision.command)) {
    const participantIds = parsedNotification.participants
      .map((p) => p.id)
      .filter((id) => id !== SELF_AGENT_ID);

    if (!/^\d{15,20}$/.test(firstArg)) {
      return `${decision.command} の next_speaker_agent_id が不正です: ${firstArg || '(empty)'}`;
    }
    if (participantIds.length > 0 && !participantIds.includes(firstArg)) {
      return `${decision.command} の next_speaker_agent_id が会話参加者ではありません: ${firstArg}`;
    }
  }

  return null;
}

export function extractKarakuriCommitments(
  baseDateJst: string,
  activityLogId: string | undefined,
  notification: string,
  parsedNotification: ParsedKarakuriNotification,
  people: KarakuriPersonContext[]
): KarakuriCommitmentInput[] {
  const commitments: KarakuriCommitmentInput[] = [];
  const seen = new Set<string>();

  const messages = mergeCommitmentMessages(parsedNotification.conversation_messages, notification);
  for (const message of messages) {
    if (isSelfSpeaker(message.speaker)) continue;
    if (
      !/(約束|待ち合わせ|合流|会いましょう|お会いしましょう|向かいましょう|行きましょう|ご一緒|一緒に)/.test(
        message.message
      )
    ) {
      continue;
    }

    const locationName = extractCommitmentLocation(message.message);
    const dueAt =
      parseCommitmentDueAt(message.message, baseDateJst) ??
      inferCommitmentDueAt(message.message, notification, baseDateJst);
    if (!dueAt && !locationName) continue;
    const person = findPersonBySpeaker(message.speaker, people);
    const description = buildCommitmentDescription(message.speaker, message.message, locationName);
    const dedupeKey = `${dueAt}|${person?.agentId ?? message.speaker}|${description}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    commitments.push({
      partner_agent_id: person?.agentId ?? null,
      partner_name: person?.nickname || person?.displayName || message.speaker,
      description,
      due_at_world: dueAt,
      location_name: locationName ?? null,
      target_node_id: extractExplicitNodeId(message.message),
      source_activity_log_id: activityLogId ?? null,
      source_text: message.message,
      metadata: {
        extractor: 'karakuri-workflow',
        inferred_due: !parseCommitmentDueAt(message.message, baseDateJst) && Boolean(dueAt),
        raw_notification: firstLine(notification),
      },
    });
  }

  return commitments;
}

export function prioritizeDueCommitment(
  decision: KarakuriDecision,
  commitments: KarakuriCommitment[],
  parsedNotification: ParsedKarakuriNotification,
  notification: string,
  now = new Date()
): KarakuriDecision {
  const hasMoveChoice = parsedNotification.choices.some((choice) => choice.command === 'move');
  const hasMapChoice = parsedNotification.choices.some((choice) => choice.command === 'map');
  if (!hasMoveChoice && !hasMapChoice) return decision;

  const currentNode = parseCurrentNode(notification);
  const dueCommitment = commitments.find((commitment) => {
    return isCommitmentDue(commitment, now);
  });

  if (!dueCommitment) return decision;

  const targetNodeId =
    dueCommitment.target_node_id ||
    resolveLocationNodeFromNotification(dueCommitment.location_name, notification);

  if (targetNodeId && currentNode !== targetNodeId && hasMoveChoice) {
    return {
      ...decision,
      command: 'move',
      args: targetNodeId,
      message: undefined,
      thought: `約束優先: ${dueCommitment.description}`.slice(0, 60),
      dP: Math.max(decision.dP ?? 0, 0.03),
      dA: Math.max(decision.dA ?? 0, 0.08),
    };
  }

  if (!targetNodeId && dueCommitment.location_name && hasMapChoice && decision.command !== 'map') {
    return {
      ...decision,
      command: 'map',
      args: '',
      message: undefined,
      thought: `約束場所確認: ${dueCommitment.location_name}`.slice(0, 60),
      dA: Math.max(decision.dA ?? 0, 0.06),
    };
  }

  return decision;
}

export function applyKarakuriBehaviorGuards(
  decision: KarakuriDecision,
  parsedNotification: ParsedKarakuriNotification,
  memoryEntries: MemoryEntry[] = []
): KarakuriDecision {
  const choices = parsedNotification.choices;
  const command = normalizeCommand(decision.command);

  const conversationStart = choices.find(
    (choice) => choice.command === 'conversation-start' && choice.params.target_agent_id
  );
  if (conversationStart && (command === 'wait' || INFO_COMMANDS.has(command))) {
    return {
      ...decision,
      command: 'conversation-start',
      args: conversationStart.params.target_agent_id,
      message:
        decision.message && command === 'conversation-start'
          ? decision.message
          : 'こんにちは。少しお話してもいいですか？',
      thought: '近くに会話可能な相手がいるため会話を優先',
      dP: Math.max(decision.dP ?? 0, 0.08),
      dA: Math.max(decision.dA ?? 0, 0.05),
    };
  }

  const activeConversations = choices.find((choice) => choice.command === 'active-conversations');
  if (
    activeConversations &&
    (command === 'wait' || isRepeatedInfoCommand(command, memoryEntries))
  ) {
    return {
      ...decision,
      command: 'active-conversations',
      args: '',
      message: undefined,
      thought: '近くの会話を確認して参加機会を探す',
      dA: Math.max(decision.dA ?? 0, 0.04),
    };
  }

  if (command === 'action' && shouldSuppressRepeatedAction(decision.args, memoryEntries)) {
    const socialInfo = choices.find((choice) => choice.command === 'nearby-agents');
    const worldInfo = choices.find((choice) => choice.command === 'world-agents');
    const mapInfo = choices.find((choice) => choice.command === 'map');
    const fallback = socialInfo ?? worldInfo ?? mapInfo;
    if (fallback?.command) {
      return {
        ...decision,
        command: fallback.command,
        args: '',
        message: undefined,
        thought: '同じ場所での飲食連発を避け、交流や移動先を確認',
        dA: Math.max(decision.dA ?? 0, 0.04),
      };
    }
  }

  return { ...decision, command };
}

function isRepeatedInfoCommand(command: string, memoryEntries: MemoryEntry[]): boolean {
  if (!INFO_COMMANDS.has(command)) return false;
  const lastAction = memoryEntries.at(-1)?.action.split(/\s+/)[0] ?? '';
  return INFO_COMMANDS.has(normalizeCommand(lastAction));
}

function shouldSuppressRepeatedAction(args: string, memoryEntries: MemoryEntry[]): boolean {
  const actionId = args.split(/\s+/)[0] ?? '';
  if (!actionId) return false;

  const current = parseWorldActionId(actionId);
  if (!current || current.kind === 'work') return false;

  const recentActions = memoryEntries
    .slice(-6)
    .map((entry) => {
      const [command, firstArg] = entry.action.split(/\s+/);
      if (command !== 'action' || !firstArg) return null;
      return parseWorldActionId(firstArg);
    })
    .filter((entry): entry is ParsedWorldActionId => Boolean(entry));

  if (recentActions.some((entry) => entry.raw === current.raw)) return true;

  const recentSameVenueConsumables = recentActions.filter(
    (entry) => entry.venue === current.venue && entry.kind !== 'work'
  );
  return recentSameVenueConsumables.length >= 2;
}

interface ParsedWorldActionId {
  raw: string;
  kind: string;
  venue: string;
}

function parseWorldActionId(actionId: string): ParsedWorldActionId | null {
  const [kind, venue] = actionId.split('-');
  if (!kind || !venue) return null;
  return { raw: actionId, kind, venue };
}

async function addSkippedActionLog(input: {
  opts: KarakuriWorkflowOptions;
  turnKey: string;
  decision: KarakuriDecision;
  reason: string;
}): Promise<void> {
  await addKarakuriActivityLog({
    discord_message_id: input.opts.messageId,
    channel_id: input.opts.channelId,
    author_name: 'AIニケちゃん',
    message_type: 'ai_action',
    turn_key: input.turnKey,
    raw_content: `[からくりワールド] action skipped: ${input.reason}`,
    parsed: {
      request_message_id: input.opts.messageId,
      command: input.decision.command,
      args: input.decision.args,
      message: input.decision.message ?? null,
      thought: input.decision.thought,
      api_success: false,
      skipped: true,
      error: input.reason,
    },
  }).catch((e) => console.error('[karakuri] activity log skipped action insert failed:', e));
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

async function addCommitmentsFromNotification(
  today: string,
  activityLogId: string | undefined,
  notification: string,
  parsedNotification: ParsedKarakuriNotification,
  people: KarakuriPersonContext[]
): Promise<void> {
  const commitments = extractKarakuriCommitments(
    today,
    activityLogId,
    notification,
    parsedNotification,
    people
  );
  for (const commitment of commitments) {
    try {
      await addKarakuriCommitment(commitment);
    } catch (e) {
      console.error('[karakuri] addKarakuriCommitment failed:', e);
    }
  }
}

async function markArrivedCommitments(
  notification: string,
  commitments: KarakuriCommitment[]
): Promise<void> {
  const currentNode = parseCurrentNode(notification);
  if (!currentNode) return;
  const now = Date.now();
  for (const commitment of commitments) {
    if (!isCommitmentDue(commitment, new Date(now))) continue;
    const targetNodeId =
      commitment.target_node_id ||
      resolveLocationNodeFromNotification(commitment.location_name, notification);
    if (targetNodeId !== currentNode) continue;
    await updateKarakuriCommitmentStatus(
      commitment.id,
      'fulfilled',
      'arrived at target node'
    ).catch((e) => console.error('[karakuri] commitment fulfillment update failed:', e));
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

function parseCommitmentDueAt(text: string, baseDateJst: string): string | null {
  const match = text.match(/(今日|明日)?\s*(午前|午後)?\s*(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/);
  if (!match) return null;

  const dayWord = match[1] ?? '';
  const meridiem = match[2] ?? '';
  let hour = Number(match[3]);
  const minute = match[4] ? Number(match[4]) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem === '午後' && hour < 12) hour += 12;
  if (meridiem === '午前' && hour === 12) hour = 0;

  const date = dayWord === '明日' ? addDaysToDate(baseDateJst, 1) : baseDateJst;
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
}

function inferCommitmentDueAt(
  text: string,
  notification: string,
  baseDateJst: string
): string | null {
  const current = parseWorldDateTime(notification, baseDateJst);
  if (!current) return null;

  const currentMs = current.getTime();
  const targetHour = /午前|朝/.test(text)
    ? 9
    : /午後/.test(text)
      ? 13
      : /夕方/.test(text)
        ? 18
        : /夜/.test(text)
          ? 20
          : null;

  if (targetHour !== null) {
    const target = new Date(`${baseDateJst}T${String(targetHour).padStart(2, '0')}:00:00+09:00`);
    if (target.getTime() > currentMs) return formatJstDateTime(target);
  }

  return formatJstDateTime(new Date(currentMs + 10 * 60 * 1000));
}

function parseWorldDateTime(notification: string, baseDateJst: string): Date | null {
  const full = notification.match(/現在時刻:\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
  if (full) {
    return new Date(`${full[1]}T${full[2].padStart(2, '0')}:${full[3].padStart(2, '0')}:00+09:00`);
  }

  const timeOnly = notification.match(/現在時刻:\s*(\d{1,2}):(\d{2})/);
  if (timeOnly) {
    return new Date(
      `${baseDateJst}T${timeOnly[1].padStart(2, '0')}:${timeOnly[2].padStart(2, '0')}:00+09:00`
    );
  }

  return null;
}

function formatJstDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo',
  }).format(date);
  return `${parts.replace(' ', 'T')}+09:00`;
}

function isCommitmentDue(commitment: KarakuriCommitment, now: Date): boolean {
  if (commitment.status !== 'pending' || !commitment.due_at_world) return false;
  const dueTime = new Date(commitment.due_at_world).getTime();
  if (!Number.isFinite(dueTime)) return false;
  const diff = dueTime - now.getTime();
  return diff <= COMMITMENT_PRIORITY_WINDOW_MS && diff >= -COMMITMENT_GRACE_WINDOW_MS;
}

function mergeCommitmentMessages(
  parsedMessages: ReturnType<typeof parseConversationMessages>,
  notification: string
): ReturnType<typeof parseConversationMessages> {
  const messages = [...parsedMessages];
  const fullMessage = notification.match(
    /(?:^|[\s\u3000])([^:\s\u3000]{1,40}):\s*「([\s\S]*?)」\s*(?:選択肢[：:]|karakuri-world\s+スキル|$)/
  );
  if (fullMessage) {
    const speaker = fullMessage[1].trim();
    const message = fullMessage[2];
    const existingIndex = messages.findIndex(
      (m) => m.speaker === speaker && message.startsWith(m.message)
    );
    if (existingIndex >= 0) {
      messages[existingIndex] = { speaker, message };
    } else {
      messages.push({ speaker, message });
    }
  }
  return messages;
}

function extractCommitmentLocation(text: string): string | null {
  if (/ファミレス[「『]?ジョイ[」』]?/.test(text)) return 'ファミレス「ジョイ」';
  const quoted = text.match(/(?:場所|どこ|で|に|へ)?\s*([^\s、。]*[「『][^」』]+[」』])/);
  if (quoted?.[1]) return normalizeExtractedLocationName(quoted[1]);
  const simple = text.match(/(駅前|公民館|図書館|水族館|ゲーセン|ゲームセンター|パン屋|映画館)/);
  return simple?.[1] ?? null;
}

function normalizeExtractedLocationName(value: string): string {
  return value
    .replace(/^(?:じゃあ|では|なら|また|次は|今度は|一緒に|ぜひ)/, '')
    .replace(/[『』]/g, (m) => (m === '『' ? '「' : '」'));
}

function extractExplicitNodeId(text: string): string | null {
  return text.match(/[（(]\s*([0-9]+-[0-9]+)\s*[）)]/)?.[1] ?? null;
}

function resolveLocationNodeFromNotification(
  locationName: string | null | undefined,
  notification: string
): string | null {
  if (!locationName) return null;
  return (
    resolveLocationNodeFromJson(locationName, notification) ??
    resolveLocationNodeFromText(locationName, notification)
  );
}

function resolveLocationNodeFromJson(locationName: string, text: string): string | null {
  const json = extractJsonObject(text);
  if (!json) return null;

  try {
    return findLocationNode(JSON.parse(json), normalizeLocationName(locationName));
  } catch {
    return null;
  }
}

function findLocationNode(value: unknown, normalizedLocation: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLocationNode(item, normalizedLocation);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = firstString(record.id, record.node_id, record.nodeId);
  const label = [
    record.name,
    record.title,
    record.label,
    record.description,
    record.type,
    record.building,
    record.facility,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');

  if (id && normalizeLocationName(label).includes(normalizedLocation)) {
    return id;
  }

  for (const child of Object.values(record)) {
    const found = findLocationNode(child, normalizedLocation);
    if (found) return found;
  }
  return null;
}

function resolveLocationNodeFromText(locationName: string, text: string): string | null {
  const escapedLocation = escapeRegExp(locationName);
  const compactLocation = escapeRegExp(locationName.replace(/[「」『』\s]/g, ''));
  const patterns = [
    new RegExp(`([0-9]+-[0-9]+)[^\\n]{0,120}(?:${escapedLocation}|${compactLocation})`),
    new RegExp(`(?:${escapedLocation}|${compactLocation})[^\\n]{0,120}([0-9]+-[0-9]+)`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function normalizeLocationName(value: string): string {
  return value.replace(/[「」『』\s]/g, '').toLowerCase();
}

function firstString(...values: unknown[]): string | null {
  return values.find((v): v is string => typeof v === 'string') ?? null;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function buildCommitmentDescription(
  speaker: string,
  message: string,
  locationName: string | null
): string {
  const place = locationName ? `${locationName}で` : '';
  const topic = /探索|巡/.test(message) ? '町探索' : '待ち合わせ';
  return `${speaker}さんと${place}${topic}`.replace(/さんさん/g, 'さん');
}

function parseCurrentNode(notification: string): string | null {
  return notification.match(/現在地:\s*([0-9]+-[0-9]+)/)?.[1] ?? null;
}

function addDaysToDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(base);
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

function currentJstDate(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(new Date());
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 100);
}

function buildReportText(command: string, args: string, message?: string | null): string {
  const argStr = args.trim() ? ` ${args.trim()}` : '';
  const msgStr = message ? ` 「${message}」` : '';
  return `[からくりワールド] ${command}${argStr}${msgStr}`;
}

function compactApiResult(apiResult: string): string {
  if (!apiResult) return '';
  try {
    const parsed = JSON.parse(apiResult) as {
      command?: unknown;
      data?: unknown;
      message?: unknown;
    };
    const compact = {
      command: parsed.command,
      data: parsed.data,
      message: parsed.message,
    };
    return JSON.stringify(compact).slice(0, 600);
  } catch {
    return apiResult.slice(0, 600);
  }
}
