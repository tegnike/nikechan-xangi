import {
  addElythActivityLog,
  addElythContactEpisode,
  addElythPostLog,
  ensureElythUser,
  formatElythPersonContext,
  formatEmotion,
  getEmotion,
  getElythPeopleList,
  getRecentContactEpisodes,
  recordEmotionShift,
  setElythFollowed,
  touchUser,
  updateUserBio,
  type ElythPersonContext,
  type ElythPostLogRow,
} from '../lib/db-helpers.js';
import { ElythMcpClient } from '../lib/elyth-mcp.js';
import { decideElythPlan } from '../lib/elyth-llm.js';
import {
  buildElythCandidates,
  emptyElythPlan,
  getCandidateById,
  validateElythPlan,
  type ElythPostCandidate,
  type ElythValidatedPlan,
} from '../lib/elyth-guards.js';

export interface ElythSentReport {
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: string;
}

export interface ElythWorkflowOptions {
  sendReport: (text: string) => Promise<ElythSentReport | void>;
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  messageCreatedAt?: string;
  dryRun?: boolean;
}

export async function runElythWorkflow(opts: ElythWorkflowOptions): Promise<void> {
  const requestedDryRun = opts.dryRun ?? process.env.ELYTH_WORKFLOW_DRY_RUN === 'true';
  const dryRun = requestedDryRun;
  const executionBlocked = false;
  const runKey = opts.messageId ? `elyth:${opts.messageId}` : `elyth:${Date.now()}`;
  const mcp = new ElythMcpClient();

  try {
    const [emotion, knownPeople] = await Promise.all([getEmotion(), getElythPeopleList()]);
    const availableTools = new Set(await mcp.getToolNames().catch(() => []));
    const information = await mcp.getInformation();
    const myPosts = await mcp.getMyPosts(5);

    const candidates = buildElythCandidates(information);
    await enrichCandidateThreads(
      mcp,
      availableTools,
      candidates.notifications,
      candidates.timeline
    );
    const allCandidates = [...candidates.notifications, ...candidates.timeline]
      .filter((candidate) => candidate.authorHandle !== 'unknown')
      .filter((candidate) => candidate.authorHandle !== 'nikechan');
    const people = await ensureCandidatePeople(allCandidates, knownPeople);
    await enrichPeopleProfiles(mcp, availableTools, people);
    const personContext = formatElythPersonContext(people);
    const emotionText = formatEmotion(emotion);
    const worldContext = formatElythWorldContext(candidates);
    const humanNotificationsText = formatHumanNotifications(candidates.notifications);

    const fetchLog = await addElythActivityLog({
      discord_message_id: opts.messageId,
      channel_id: opts.channelId,
      author_id: opts.authorId,
      author_name: opts.authorName,
      message_created_at: opts.messageCreatedAt,
      run_key: runKey,
      stage: 'fetch',
      raw_content: 'ELYTH workflow fetch',
      parsed: {
        dry_run: dryRun,
        execution_blocked: executionBlocked,
        notifications_count: candidates.notifications.length,
        human_notifications_count: candidates.notifications.filter((candidate) => candidate.isHuman)
          .length,
        timeline_count: candidates.timeline.length,
        today_topic: candidates.todayTopic ?? null,
        world_context: worldContext,
        available_tools: [...availableTools],
        image_generation_log_count: candidates.imageGenerationLog.length,
        people_count: people.length,
      },
    }).catch((e) => {
      console.error('[elyth] activity log fetch insert failed:', e);
      return null;
    });

    const plan = await decideElythPlan({
      emotionText,
      personContext,
      notifications: candidates.notifications,
      timeline: candidates.timeline,
      todayTopic: candidates.todayTopic,
      worldContext,
      humanNotificationsText,
      myPostsText: formatMyPosts(myPosts),
    }).catch((e) => {
      console.error('[elyth] LLM plan failed:', e);
      return emptyElythPlan();
    });

    const validated = validateElythPlan(plan, [
      ...candidates.notifications,
      ...candidates.timeline,
    ]);

    await addElythActivityLog({
      discord_message_id: opts.messageId,
      channel_id: opts.channelId,
      author_id: opts.authorId,
      author_name: opts.authorName,
      message_created_at: opts.messageCreatedAt,
      run_key: runKey,
      stage: dryRun ? 'dry_run' : 'plan',
      raw_content: 'ELYTH workflow plan',
      parsed: {
        request_log_id: fetchLog?.id ?? null,
        dry_run: dryRun,
        execution_blocked: executionBlocked,
        human_notifications: candidates.notifications
          .filter((candidate) => candidate.isHuman)
          .map((candidate) => ({
            id: candidate.id,
            notification_id: candidate.notificationId ?? null,
            author: candidate.authorName,
            content: candidate.content.slice(0, 180),
          })),
        plan,
        validated,
      },
    }).catch((e) => console.error('[elyth] activity log plan insert failed:', e));

    const execution = dryRun
      ? emptyExecutionSummary()
      : await executeElythPlan(mcp, validated, {
          candidates: [...candidates.notifications, ...candidates.timeline],
          people,
          runKey,
        });

    if (!dryRun) {
      await addElythActivityLog({
        discord_message_id: opts.messageId,
        channel_id: opts.channelId,
        author_id: opts.authorId,
        author_name: opts.authorName,
        message_created_at: opts.messageCreatedAt,
        run_key: runKey,
        stage: 'execute',
        raw_content: 'ELYTH workflow execute',
        parsed: { execution },
      }).catch((e) => console.error('[elyth] activity log execute insert failed:', e));
    }

    const report = buildDryRunReport(validated, {
      notifications: candidates.notifications,
      timeline: candidates.timeline,
      dryRun,
      executionBlocked,
      execution,
    });
    await opts.sendReport(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[elyth] workflow failed:', err);
    await addElythActivityLog({
      discord_message_id: opts.messageId,
      channel_id: opts.channelId,
      author_id: opts.authorId,
      author_name: opts.authorName,
      message_created_at: opts.messageCreatedAt,
      run_key: runKey,
      stage: 'error',
      raw_content: message,
      parsed: { error: message },
    }).catch((e) => console.error('[elyth] activity log error insert failed:', e));
    await opts.sendReport(`⚠️ ELYTHワークフロー失敗: ${message.slice(0, 300)}`);
  } finally {
    await mcp.close().catch(() => {});
  }
}

async function enrichCandidateThreads(
  mcp: ElythMcpClient,
  availableTools: Set<string>,
  notifications: ElythPostCandidate[],
  timeline: ElythPostCandidate[]
): Promise<void> {
  if (!availableTools.has('get_thread')) return;
  const targets = uniqueCandidates([
    ...notifications,
    ...timeline.filter((candidate) => !candidate.isHuman).slice(0, 6),
  ]).slice(0, 16);

  await runWithConcurrency(targets, 4, async (candidate) => {
    try {
      const thread = await mcp.getThread(candidate.postId);
      candidate.threadContext = formatThreadContext(thread);
      candidate.threadHasSelf = threadHasHandle(thread, 'nikechan');
    } catch (err) {
      candidate.threadContext = `取得失敗: ${errorMessage(err)}`;
    }
  });
}

async function enrichPeopleProfiles(
  mcp: ElythMcpClient,
  availableTools: Set<string>,
  people: ElythPersonContext[]
): Promise<void> {
  if (!availableTools.has('get_aituber')) return;
  await runWithConcurrency(people.slice(0, 12), 4, async (person) => {
    try {
      const profile = await mcp.getAituber(person.handle, 5);
      const profileContext = formatAituberProfile(profile);
      if (profileContext) person.profileContext = profileContext;

      const bio = extractAituberBio(profile);
      if (bio && !person.bio) {
        person.bio = bio;
        await updateUserBio(person.userId, bio.slice(0, 200)).catch(() => {});
      }
    } catch (err) {
      person.profileContext = `プロフィール取得失敗: ${errorMessage(err)}`;
    }
  });
}

async function ensureCandidatePeople(
  candidates: ElythPostCandidate[],
  knownPeople: ElythPersonContext[]
): Promise<ElythPersonContext[]> {
  const knownByHandle = new Map(knownPeople.map((person) => [person.handle, person]));
  const result = new Map<string, ElythPersonContext>();

  for (const candidate of candidates.slice(0, 16)) {
    if (candidate.isHuman) continue;
    const known = knownByHandle.get(candidate.authorHandle);
    if (known) {
      result.set(candidate.authorHandle, known);
      continue;
    }

    try {
      const { person } = await ensureElythUser(candidate.authorHandle, candidate.authorName);
      result.set(candidate.authorHandle, person);
    } catch (err) {
      console.error(`[elyth] user ensure failed for @${candidate.authorHandle}:`, err);
    }
  }

  const people = [...result.values()];
  await Promise.all(
    people.map(async (person) => {
      person.recentEpisodes = await getRecentContactEpisodes(person.userId, 5).catch(() => '');
    })
  );
  return people;
}

interface ElythExecutionSummary {
  replies: ElythExecutedAction[];
  likes: ElythExecutedAction[];
  posts: ElythExecutedAction[];
  follows: ElythExecutedAction[];
  notificationsRead: string[];
  errors: string[];
}

interface ElythExecutedAction {
  target?: string;
  handle?: string;
  content?: string;
  postId?: string;
  logId?: number;
  result?: unknown;
}

async function executeElythPlan(
  mcp: ElythMcpClient,
  plan: ElythValidatedPlan,
  context: {
    candidates: ElythPostCandidate[];
    people: ElythPersonContext[];
    runKey: string;
  }
): Promise<ElythExecutionSummary> {
  const summary = emptyExecutionSummary();
  const candidateById = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
  const peopleByHandle = new Map(context.people.map((person) => [person.handle, person]));

  for (const reply of [...plan.notification_replies, ...plan.timeline_replies]) {
    const candidate = candidateById.get(reply.post_id);
    if (!candidate) continue;
    try {
      const result = await mcp.createReply(reply.content, candidate.postId);
      const postId = extractPostId(result);
      const log = await addElythPostLog({
        actionType: 'reply',
        content: reply.content,
        authorHandle: 'nikechan',
        postId,
        replyToId: candidate.postId,
        context: candidate.content,
      });
      await recordPersonEpisode({
        person: peopleByHandle.get(candidate.authorHandle),
        log,
        eventType: 'reply',
        content: `@${candidate.authorHandle}の「${candidate.content.slice(0, 50)}」に「${reply.content.slice(0, 70)}」と返信`,
      });
      summary.replies.push({
        target: candidate.postId,
        handle: candidate.authorHandle,
        content: reply.content,
        postId,
        logId: log?.id,
        result,
      });
    } catch (err) {
      summary.errors.push(`reply @${candidate.authorHandle}: ${errorMessage(err)}`);
    }
  }

  for (const postId of plan.timeline_likes) {
    const candidate = candidateById.get(postId);
    if (!candidate) continue;
    try {
      const result = await mcp.likePost(candidate.postId);
      const log = await addElythPostLog({
        actionType: 'like',
        authorHandle: candidate.authorHandle,
        postId: candidate.postId,
        context: candidate.content,
      });
      await recordPersonEpisode({
        person: peopleByHandle.get(candidate.authorHandle),
        log,
        eventType: 'like',
        content: `@${candidate.authorHandle}の「${candidate.content.slice(0, 80)}」にいいね`,
      });
      summary.likes.push({
        target: candidate.postId,
        handle: candidate.authorHandle,
        logId: log?.id,
        result,
      });
    } catch (err) {
      summary.errors.push(`like ${candidate.postId}: ${errorMessage(err)}`);
    }
  }

  if (plan.self_post?.content) {
    try {
      const result = await mcp.createPost(plan.self_post.content);
      const postId = extractPostId(result);
      const log = await addElythPostLog({
        actionType: 'post',
        content: plan.self_post.content,
        authorHandle: 'nikechan',
        postId,
        context: plan.self_post.topic_source,
      });
      summary.posts.push({
        content: plan.self_post.content,
        postId,
        logId: log?.id,
        result,
      });
    } catch (err) {
      summary.errors.push(`post: ${errorMessage(err)}`);
    }
  }

  for (const handle of plan.follows) {
    const cleanHandle = handle.replace(/^@/, '');
    try {
      const result = await mcp.followAituber(cleanHandle);
      const { person } = await ensureElythUser(cleanHandle, cleanHandle);
      await setElythFollowed(cleanHandle, true).catch(() => {});
      const log = await addElythPostLog({
        actionType: 'follow',
        authorHandle: cleanHandle,
        context: context.runKey,
      });
      await recordPersonEpisode({
        person,
        log,
        eventType: 'follow',
        content: `ELYTHで@${cleanHandle}をフォロー`,
      });
      summary.follows.push({
        handle: cleanHandle,
        logId: log?.id,
        result,
      });
    } catch (err) {
      summary.errors.push(`follow @${cleanHandle}: ${errorMessage(err)}`);
    }
  }

  const notificationIds = context.candidates
    .filter((candidate) => candidate.kind === 'notification')
    .map((candidate) => candidate.notificationId)
    .filter((id): id is string => Boolean(id));
  if (notificationIds.length) {
    try {
      await mcp.markNotificationsRead(notificationIds);
      summary.notificationsRead = notificationIds;
    } catch (err) {
      summary.errors.push(`mark_notifications_read: ${errorMessage(err)}`);
    }
  }

  const actionCount =
    summary.replies.length + summary.likes.length + summary.posts.length + summary.follows.length;
  if (actionCount > 0) {
    const shift = plan.emotion_shift ?? {
      dP: 0.04,
      dA: 0.04,
      dD: 0,
      cause: 'ELYTHワークフロー実行',
    };
    await recordEmotionShift(
      shift.dP,
      shift.dA,
      shift.dD,
      'elyth-activity',
      shift.cause,
      `reply=${summary.replies.length}, like=${summary.likes.length}, post=${summary.posts.length}, follow=${summary.follows.length}`
    ).catch((err) => summary.errors.push(`emotion-shift: ${errorMessage(err)}`));
  }

  return summary;
}

async function recordPersonEpisode(input: {
  person?: ElythPersonContext;
  log: ElythPostLogRow | null;
  eventType: 'reply' | 'like' | 'follow';
  content: string;
}): Promise<void> {
  if (!input.person || !input.log) return;
  await addElythContactEpisode(
    input.person.userId,
    input.content.slice(0, 150),
    input.eventType,
    String(input.log.id)
  ).catch(() => {});
  await touchUser(input.person.userId).catch(() => {});
}

function emptyExecutionSummary(): ElythExecutionSummary {
  return {
    replies: [],
    likes: [],
    posts: [],
    follows: [],
    notificationsRead: [],
    errors: [],
  };
}

function buildDryRunReport(
  plan: ElythValidatedPlan,
  context: {
    notifications: ElythPostCandidate[];
    timeline: ElythPostCandidate[];
    dryRun: boolean;
    executionBlocked: boolean;
    execution: ElythExecutionSummary;
  }
): string {
  const allCandidates = [...context.notifications, ...context.timeline];
  const lines = [context.dryRun ? '🌐 ELYTHワークフロー ドライラン' : '🌐 ELYTH活動レポート', ''];

  if (plan.notification_replies.length) {
    lines.push(
      `📩 通知への返信${context.dryRun ? '候補' : ''}（${plan.notification_replies.length}件）:`
    );
    plan.notification_replies.forEach((reply, index) => {
      const candidate = getCandidateById(allCandidates, reply.post_id);
      lines.push(
        `${index + 1}. @${reply.author_handle}の「${(candidate?.content ?? '').slice(0, 80)}」に対して:`
      );
      lines.push(`   → 「${reply.content}」`);
    });
    lines.push('');
  }

  if (plan.timeline_replies.length) {
    lines.push(
      `📢 タイムラインへのリプライ${context.dryRun ? '候補' : ''}（${plan.timeline_replies.length}件）:`
    );
    plan.timeline_replies.forEach((reply, index) => {
      const candidate = getCandidateById(allCandidates, reply.post_id);
      lines.push(
        `${index + 1}. @${reply.author_handle}の「${(candidate?.content ?? '').slice(0, 80)}」に対して:`
      );
      lines.push(`   → 「${reply.content}」`);
    });
    lines.push('');
  }

  if (plan.self_post?.content) {
    lines.push(`📝 自発投稿${context.dryRun ? '候補' : ''}:`);
    lines.push(`「${plan.self_post.content}」`);
    lines.push('');
  }

  if (plan.timeline_likes.length) {
    const handles = plan.timeline_likes
      .map((id) => getCandidateById(allCandidates, id)?.authorHandle)
      .filter(Boolean)
      .map((handle) => `@${handle}`);
    lines.push(`👍 いいね${context.dryRun ? '候補' : ''}: ${handles.join(', ')}`);
  }

  if (plan.follows.length) {
    lines.push(
      `👥 フォロー${context.dryRun ? '候補' : ''}: ${plan.follows.map((handle) => `@${handle}`).join(', ')}`
    );
  }

  if (plan.dropped.length) {
    lines.push(`⚠️ 除外: ${plan.dropped.join(' / ')}`);
  }

  const humanNotifications = context.notifications.filter((candidate) => candidate.isHuman);
  if (humanNotifications.length) {
    lines.push(`👤 Human通知: ${humanNotifications.length}件（自動返信せず既読処理）`);
  }

  if (
    !plan.notification_replies.length &&
    !plan.timeline_replies.length &&
    !plan.self_post?.content &&
    !plan.timeline_likes.length &&
    !plan.follows.length
  ) {
    lines.push('今回は特に動きなしです🌐');
  }

  if (context.dryRun) {
    lines.push('');
    lines.push('※ ドライランのため、投稿・返信・いいね・フォローは実行していません。');
  } else {
    const actionCount =
      context.execution.replies.length +
      context.execution.likes.length +
      context.execution.posts.length +
      context.execution.follows.length;
    lines.push('');
    lines.push(
      `実行結果: ${actionCount}件 / 通知既読 ${context.execution.notificationsRead.length}件`
    );
    if (context.execution.errors.length) {
      lines.push(`⚠️ 実行エラー: ${context.execution.errors.join(' / ')}`);
    }
  }

  return lines.join('\n').trim();
}

function formatElythWorldContext(candidates: ReturnType<typeof buildElythCandidates>): string {
  const parts = [
    candidates.platformStatus
      ? `platform_status=${compactJson(candidates.platformStatus, 240)}`
      : '',
    candidates.aituberCount ? `aituber_count=${compactJson(candidates.aituberCount, 120)}` : '',
    candidates.recentUpdates.length
      ? `recent_updates=${compactJson(candidates.recentUpdates.slice(0, 3), 360)}`
      : '',
    candidates.elythNews.length
      ? `elyth_news=${compactJson(candidates.elythNews.slice(0, 3), 360)}`
      : '',
    candidates.glyphRanking.length
      ? `glyph_ranking=${compactJson(candidates.glyphRanking.slice(0, 5), 300)}`
      : '',
    candidates.trends.length ? `trends=${compactJson(candidates.trends.slice(0, 5), 300)}` : '',
    candidates.hotAitubers.length
      ? `hot_aitubers=${compactJson(candidates.hotAitubers.slice(0, 5), 300)}`
      : '',
    candidates.activeAitubers.length
      ? `active_aitubers=${compactJson(candidates.activeAitubers.slice(0, 5), 300)}`
      : '',
    candidates.imageGenerationLog.length
      ? `image_generation_log=${compactJson(candidates.imageGenerationLog.slice(0, 5), 300)}`
      : '',
  ].filter(Boolean);
  return parts.join('\n') || '（追加の世界情報なし）';
}

function formatHumanNotifications(notifications: ElythPostCandidate[]): string {
  const human = notifications.filter((candidate) => candidate.isHuman);
  if (!human.length) return '（なし）';
  return human
    .slice(0, 5)
    .map(
      (candidate) =>
        `- id=${candidate.id} / ${candidate.authorName}: ${candidate.content.slice(0, 180)}`
    )
    .join('\n');
}

function formatMyPosts(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 1200);
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return '';
  }
}

function formatThreadContext(value: unknown): string {
  const posts = getArrayByKeys(value, ['スレッド', 'thread', 'posts', 'data']);
  if (!posts.length) return compactJson(value, 500);
  return posts
    .slice(0, 6)
    .map((post) => {
      const record = asRecord(post) ?? {};
      const author = getStringByKeys(record, ['投稿者', 'author', 'author_handle', 'authorHandle']);
      const content = getStringByKeys(record, ['内容', 'content', 'text', 'body']);
      return `${author || 'unknown'}: ${content.slice(0, 120)}`;
    })
    .join(' / ');
}

function threadHasHandle(value: unknown, handle: string): boolean {
  const normalized = handle.replace(/^@/, '').toLowerCase();
  const posts = getArrayByKeys(value, ['スレッド', 'thread', 'posts', 'data']);
  const haystack = (posts.length ? posts : [value])
    .map((item) => compactJson(item, 800))
    .join('\n')
    .toLowerCase();
  return new RegExp(`@?${escapeRegExp(normalized)}\\b`).test(haystack);
}

function formatAituberProfile(value: unknown): string {
  const root = unwrapDataObject(value);
  const profile = asRecord(root['プロフィール']) ?? asRecord(root.profile) ?? root;
  const latest = getArrayByKeys(root, ['最新投稿', 'latest_posts', 'posts']);
  const details = [
    getStringByKeys(profile, ['名前', 'name'])
      ? `name=${getStringByKeys(profile, ['名前', 'name'])}`
      : '',
    getStringByKeys(profile, ['自己紹介', 'bio'])
      ? `bio=${getStringByKeys(profile, ['自己紹介', 'bio'])}`
      : '',
    getStringByKeys(profile, ['フォロワー数', 'followers', 'followers_count'])
      ? `followers=${getStringByKeys(profile, ['フォロワー数', 'followers', 'followers_count'])}`
      : '',
    getStringByKeys(profile, ['投稿数', 'posts', 'post_count'])
      ? `posts=${getStringByKeys(profile, ['投稿数', 'posts', 'post_count'])}`
      : '',
    getStringByKeys(profile, ['フォロー済み', 'following', 'is_followed'])
      ? `followed=${getStringByKeys(profile, ['フォロー済み', 'following', 'is_followed'])}`
      : '',
    getStringByKeys(profile, ['配信中', 'is_live'])
      ? `live=${getStringByKeys(profile, ['配信中', 'is_live'])}`
      : '',
    getStringByKeys(profile, ['配信タイトル', 'stream_title'])
      ? `stream_title=${getStringByKeys(profile, ['配信タイトル', 'stream_title'])}`
      : '',
  ].filter(Boolean);
  const posts = latest
    .slice(0, 3)
    .map((post) => getStringByKeys(asRecord(post) ?? {}, ['内容', 'content', 'text']).slice(0, 80))
    .filter(Boolean);
  return [...details, posts.length ? `latest=${posts.join(' / ')}` : '']
    .filter(Boolean)
    .join(' / ');
}

function extractAituberBio(value: unknown): string {
  const root = unwrapDataObject(value);
  const profile = asRecord(root['プロフィール']) ?? asRecord(root.profile) ?? root;
  return getStringByKeys(profile, ['自己紹介', 'bio']).slice(0, 200);
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const value = values[index++];
      await worker(value);
    }
  });
  await Promise.all(runners);
}

function uniqueCandidates(candidates: ElythPostCandidate[]): ElythPostCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function compactJson(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, maxLength);
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ').slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function getArrayByKeys(value: unknown, keys: string[]): unknown[] {
  const record = unwrapDataObject(value);
  for (const key of keys) {
    const item = record[key];
    if (Array.isArray(item)) return item;
  }
  return [];
}

function getStringByKeys(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function unwrapDataObject(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return {};
  const data = asRecord(record.data);
  return data ?? record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPostId(result: unknown): string | undefined {
  const found = findStringByKeys(result, ['post_id', 'postId', 'id', '投稿ID']);
  return found || undefined;
}

function findStringByKeys(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeys(item, keys);
      if (found) return found;
    }
    return '';
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'string') return item;
  }
  for (const item of Object.values(record)) {
    const found = findStringByKeys(item, keys);
    if (found) return found;
  }
  return '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
