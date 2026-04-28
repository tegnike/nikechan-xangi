export interface ElythPostCandidate {
  id: string;
  postId: string;
  notificationId?: string;
  threadId?: string;
  authorHandle: string;
  authorName: string;
  content: string;
  kind: 'notification' | 'timeline';
  isHuman: boolean;
  raw: unknown;
}

export interface ElythPlan {
  notification_replies: ElythReplyPlan[];
  timeline_likes: string[];
  timeline_replies: ElythReplyPlan[];
  self_post?: {
    content: string;
    topic_source?: string;
  } | null;
  follows: string[];
  emotion_shift?: {
    dP: number;
    dA: number;
    dD: number;
    cause: string;
  } | null;
}

export interface ElythReplyPlan {
  post_id: string;
  author_handle: string;
  content: string;
  reason?: string;
}

export interface ElythValidatedPlan extends ElythPlan {
  dropped: string[];
}

const FORBIDDEN_TEXT_PATTERNS = [/!discord/i, /!schedule/i, /<#\d+>/];

export function buildElythCandidates(information: unknown): {
  notifications: ElythPostCandidate[];
  timeline: ElythPostCandidate[];
  todayTopic?: string;
  trends: unknown[];
  hotAitubers: unknown[];
  activeAitubers: unknown[];
} {
  const info = unwrapDataObject(information);
  return {
    notifications: getArray(info, ['notifications', 'notification', '通知']).map((item) =>
      toCandidate(item, 'notification')
    ),
    timeline: getArray(info, ['timeline', 'posts', 'タイムライン']).map((item) =>
      toCandidate(item, 'timeline')
    ),
    todayTopic: getString(info, ['today_topic', 'todayTopic', '今日のお題']),
    trends: getArray(info, ['trends', 'トレンド']),
    hotAitubers: getArray(info, ['hot_aitubers', 'hotAitubers', '注目AITuber']),
    activeAitubers: getArray(info, ['active_aitubers', 'activeAitubers', 'アクティブAITuber']),
  };
}

export function validateElythPlan(
  input: ElythPlan,
  candidates: ElythPostCandidate[]
): ElythValidatedPlan {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const notificationIds = new Set(
    candidates
      .filter((candidate) => candidate.kind === 'notification')
      .map((candidate) => candidate.id)
  );
  const timelineIds = new Set(
    candidates.filter((candidate) => candidate.kind === 'timeline').map((candidate) => candidate.id)
  );
  const dropped: string[] = [];

  const notification_replies = input.notification_replies
    .filter((reply) => {
      if (!notificationIds.has(reply.post_id)) {
        dropped.push(`通知返信: 候補外post_id ${reply.post_id}`);
        return false;
      }
      if (!isSafeText(reply.content)) {
        dropped.push(`通知返信: 禁止文字列を含む ${reply.post_id}`);
        return false;
      }
      if (candidateById.get(reply.post_id)?.isHuman) {
        dropped.push(`通知返信: Human判定のため除外 ${reply.post_id}`);
        return false;
      }
      return true;
    })
    .slice(0, 2);

  const timeline_likes = unique(input.timeline_likes)
    .filter((postId) => {
      if (!timelineIds.has(postId)) {
        dropped.push(`いいね: 候補外post_id ${postId}`);
        return false;
      }
      if (candidateById.get(postId)?.authorHandle === 'nikechan') {
        dropped.push(`いいね: 自分の投稿を除外 ${postId}`);
        return false;
      }
      return true;
    })
    .slice(0, 3);

  const timeline_replies = input.timeline_replies
    .filter((reply) => {
      if (!timelineIds.has(reply.post_id)) {
        dropped.push(`TL返信: 候補外post_id ${reply.post_id}`);
        return false;
      }
      if (!isSafeText(reply.content)) {
        dropped.push(`TL返信: 禁止文字列を含む ${reply.post_id}`);
        return false;
      }
      if (candidateById.get(reply.post_id)?.authorHandle === 'nikechan') {
        dropped.push(`TL返信: 自分の投稿を除外 ${reply.post_id}`);
        return false;
      }
      return true;
    })
    .slice(0, 1);

  const selfPost =
    input.self_post?.content && isSafeText(input.self_post.content)
      ? {
          content: input.self_post.content.slice(0, 240),
          topic_source: input.self_post.topic_source,
        }
      : null;
  if (input.self_post?.content && !selfPost) dropped.push('自発投稿: 禁止文字列を含むため除外');

  return {
    notification_replies,
    timeline_likes,
    timeline_replies,
    self_post: selfPost,
    follows: unique(input.follows).slice(0, 2),
    emotion_shift: normalizeEmotionShift(input.emotion_shift),
    dropped,
  };
}

export function emptyElythPlan(): ElythPlan {
  return {
    notification_replies: [],
    timeline_likes: [],
    timeline_replies: [],
    self_post: null,
    follows: [],
    emotion_shift: null,
  };
}

export function formatCandidateForPrompt(candidate: ElythPostCandidate): string {
  const label = candidate.isHuman ? 'Human/自動返信禁止' : 'AIキャラ';
  return `- id=${candidate.id} / @${candidate.authorHandle}（${candidate.authorName}）/${label}: ${candidate.content.slice(0, 180)}`;
}

export function getCandidateById(
  candidates: ElythPostCandidate[],
  id: string
): ElythPostCandidate | undefined {
  return candidates.find((candidate) => candidate.id === id);
}

function toCandidate(item: unknown, kind: 'notification' | 'timeline'): ElythPostCandidate {
  const record = unwrapDataObject(item);
  const author = asRecord(record.author) ?? asRecord(record.user) ?? asRecord(record.aituber) ?? {};
  const authorText = getString(record, ['投稿者']);
  const parsedAuthor = parseAuthorText(authorText);
  const postId =
    getString(record, ['post_id', 'postId', '投稿ID']) ||
    getString(record, ['reply_to_id', 'replyToId', '返信先']) ||
    stableFallbackId(record);
  const notificationId =
    getString(record, ['notification_id', 'notificationId', '通知ID']) || undefined;
  const id = postId;
  const authorHandle =
    normalizeHandle(
      getString(author, ['handle', 'username', 'screen_name']) ||
        getString(record, ['author_handle', 'authorHandle', 'handle', 'username']) ||
        parsedAuthor.handle
    ) || 'unknown';
  const authorName =
    getString(author, ['name', 'display_name', 'displayName']) ||
    getString(record, ['author_name', 'authorName', 'display_name', 'name']) ||
    parsedAuthor.name ||
    authorHandle;
  const content =
    getString(record, ['content', 'text', 'body', 'message', '内容']) ||
    getString(record, ['post_content', 'postContent']) ||
    '';

  return {
    id,
    postId,
    notificationId,
    threadId: getString(record, ['thread_id', 'threadId', 'スレッドID']) || undefined,
    authorHandle,
    authorName,
    content,
    kind,
    isHuman: isHumanLike(authorHandle, authorName, content, record),
    raw: item,
  };
}

function isSafeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function normalizeEmotionShift(input: ElythPlan['emotion_shift']): ElythPlan['emotion_shift'] {
  if (!input) return null;
  return {
    dP: clampNumber(input.dP, -0.15, 0.15),
    dA: clampNumber(input.dA, -0.15, 0.15),
    dD: clampNumber(input.dD, -0.1, 0.1),
    cause: input.cause?.slice(0, 120) || 'ELYTH活動',
  };
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, n));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isHumanLike(
  handle: string,
  name: string,
  content: string,
  record: Record<string, unknown>
): boolean {
  const haystack = `${handle} ${name} ${content} ${JSON.stringify(record).slice(0, 1000)}`;
  return /\bHuman\b|visitor reply|人間ユーザー|human #\d+/i.test(haystack);
}

function normalizeHandle(value?: string): string {
  return (value ?? '').trim().replace(/^@/, '');
}

function parseAuthorText(value: string): { handle: string; name: string } {
  const match = value.match(/^@?([^\s(（]+)\s*[(（]([^）)]+)[)）]/);
  if (!match) return { handle: normalizeHandle(value), name: '' };
  return { handle: normalizeHandle(match[1]), name: match[2].trim() };
}

function getArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  const data = asRecord(record.data);
  if (data) return getArray(data, keys);
  return [];
}

function getString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function stableFallbackId(record: Record<string, unknown>): string {
  const raw = JSON.stringify(record).slice(0, 120);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return `candidate-${hash.toString(16)}`;
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
