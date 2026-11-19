/**
 * X承認スレッドのルーティング。
 *
 * X運用CLI（nikechan-x.mjs）がDiscordへ作った候補スレッドに届いたマスターの返信を、
 * CLIのpending stateと突き合わせて、Codexへ渡す指示文に組み立てる。
 * 投稿・検査・pending保存はCLIが担当し、ここでは受信と指示文の組み立てだけを行う。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const DEFAULT_X_RUNTIME_ROOT = '/opt/nikechan-x';
export const DEFAULT_X_DISCORD_CHANNEL_ID = '1477766217673478234';

export type XApprovalWorkflow = 'mention-reaction';

type Pending = Record<string, unknown>;
type PendingItem = Record<string, unknown>;

export interface XApprovalMatch {
  workflow: XApprovalWorkflow;
  pending: Pending;
  archived: boolean;
}

export interface XThreadPrompt {
  kind: XApprovalWorkflow | 'report';
  prompt: string;
}

export function getXRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.NIKECHAN_X_ROOT?.trim() || DEFAULT_X_RUNTIME_ROOT;
}

export function getXDiscordChannelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.NIKECHAN_X_DISCORD_CHANNEL_ID?.trim() || DEFAULT_X_DISCORD_CHANNEL_ID;
}

/** X運用CLIがこの環境に置かれているか（置かれていなければスレッドは従来どおり無視する） */
export function isXRuntimeAvailable(root: string = getXRuntimeRoot()): boolean {
  return existsSync(join(root, 'scripts', 'nikechan-x.mjs'));
}

export function isXThreadParent(
  parentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !!parentId && parentId === getXDiscordChannelId(env);
}

function readJson(path: string): Pending {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Pending)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function items(pending: Pending, key: 'items' | 'candidates'): PendingItem[] {
  const value = pending[key];
  return Array.isArray(value)
    ? value.filter((item): item is PendingItem => !!item && typeof item === 'object')
    : [];
}

function executedMentionIds(pending: Pending): Set<string> {
  const result = pending.executionResult;
  if (!result || typeof result !== 'object') return new Set();
  const results = (result as Record<string, unknown>).results;
  if (!Array.isArray(results)) return new Set();
  const ids = new Set<string>();
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.itemId ?? record.item_id;
    if (id) ids.add(String(id));
  }
  return ids;
}

function remainingMentionIds(pending: Pending): string[] {
  if (!Array.isArray(pending.items)) return [];
  const executed = executedMentionIds(pending);
  const open = items(pending, 'items').filter((item) => item.id && !executed.has(String(item.id)));
  const actionable = open.filter(
    (item) => item.replyAction === 'reply' || item.quoteAction === 'quote'
  );
  return (actionable.length > 0 ? actionable : open).map((item) => String(item.id));
}

function archivedSortKey(path: string, name: string): number {
  const parts = name.split('.');
  if (parts.length > 1 && /^\d+$/.test(parts[1])) return Number(parts[1]);
  try {
    return Math.trunc(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

function findArchivedMentionForThread(stateDir: string, threadId: string): Pending | null {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return null;
  }
  const matches: { key: number; pending: Pending }[] = [];
  for (const name of names) {
    if (!name.startsWith('pending-mention-reaction.') || !name.endsWith('.json')) continue;
    if (name === 'pending-mention-reaction.json') continue;
    if (name.includes('.executed-') || name.includes('.cancelled-')) continue;
    const path = join(stateDir, name);
    const pending = readJson(path);
    const reason = str(pending.archiveReason || pending.status || name);
    const remaining = remainingMentionIds(pending);
    const isClosed = name.includes('.closed.');
    if (!isClosed && !reason.includes('superseded')) continue;
    if (isClosed && remaining.length === 0) continue;
    if (str(pending.threadId) !== threadId) continue;
    if (pending.cancelledAt) continue;
    if (pending.executedAt && remaining.length === 0) continue;
    matches.push({ key: archivedSortKey(path, name), pending });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.key - a.key);
  return matches[0].pending;
}

/** スレッドIDに対応するpendingを探す。現在のメンション → 退避済みメンションの順 */
export function findXPendingForThread(
  threadId: string,
  root: string = getXRuntimeRoot()
): XApprovalMatch | null {
  if (!threadId) return null;
  const stateDir = join(root, 'state');

  const mention = readJson(join(stateDir, 'pending-mention-reaction.json'));
  if (str(mention.threadId) === threadId) {
    return { workflow: 'mention-reaction', pending: mention, archived: false };
  }

  const archivedMention = findArchivedMentionForThread(stateDir, threadId);
  if (archivedMention) {
    return { workflow: 'mention-reaction', pending: archivedMention, archived: true };
  }

  return null;
}

function pick(item: PendingItem, keys: string[]): PendingItem {
  return Object.fromEntries(keys.map((key) => [key, item[key] ?? null]));
}

const MENTION_ITEM_KEYS = [
  'id',
  'tweetLogId',
  'postId',
  'username',
  'displayName',
  'type',
  'body',
  'originalTweetId',
  'originalTweetText',
  'replyAction',
  'replyText',
  'quoteAction',
  'quoteText',
  'mediaContext',
  'mediaEvidence',
  'mediaGuard',
  'reason',
];
const MENTION_CANDIDATE_KEYS = [
  'id',
  'tweetLogId',
  'postId',
  'username',
  'displayName',
  'nickname',
  'type',
  'body',
  'originalTweetId',
  'originalTweetText',
  'mediaContext',
];
export function compactXPending(pending: Pending): Pending {
  const remaining = new Set(remainingMentionIds(pending));
  const executed = [...executedMentionIds(pending)].sort();
  let sourceItems = items(pending, 'items');
  if (executed.length > 0) {
    sourceItems = sourceItems.filter((item) => remaining.has(str(item.id)));
  }
  return {
    id: pending.id ?? null,
    kind: pending.kind ?? null,
    status: pending.status ?? null,
    threadId: pending.threadId ?? null,
    threadName: pending.threadName ?? null,
    revisionCount: pending.revisionCount ?? 0,
    remainingItemIds: [...remaining].sort(),
    executedItemIds: executed,
    items: sourceItems.map((item) => pick(item, MENTION_ITEM_KEYS)),
    candidates: items(pending, 'candidates').map((item) => pick(item, MENTION_CANDIDATE_KEYS)),
  };
}

function runtimePreamble(root: string): string {
  return `## 実行環境
- X運用CLIは \`${root}\` にあります。CLIを実行するときは必ず \`cd ${root}\` してから \`node scripts/nikechan-x.mjs ...\` を実行してください。
- 文面を作る・直すときは、先に \`${root}/profiles/nikechan-x/SOUL.md\`（X上のAIニケちゃんの人格・公開境界）を読み、その声で書いてください。
- X投稿境界・検査・pending保存・記録はCLIが担当します。X APIを直接呼んだり、state配下のファイルを手で書き換えたりしないでください。`;
}

const REPLY_STYLE_COMMON = `- マスターには内部コマンド、pending ID、\`needs_approval\`、JSON、実行ログを見せないでください。マスターが明示的にログ確認を求めた場合だけ最小限に出します。
- 事務報告ではなく、Discord上の会話として自然な短文にしてください。
- \`!discord\` コマンドは使わず、返答本文だけを書いてください（このスレッドへそのまま送られます）。`;

function buildMentionInstructions(match: XApprovalMatch, root: string): string {
  const threadId = str(match.pending.threadId).trim();
  const archivedNote = match.archived
    ? '\n- この候補は後続候補で退避済みですが、このthreadの上の候補が正です。承認時は必ず --thread-id を付けてください。'
    : '';
  return `このDiscord threadはXメンション反応の承認・修正スレッドです。
マスターの返信を、固定文言ではなく文脈上の意図で判断してください。

${runtimePreamble(root)}
- 判断基準と候補JSONの形は \`${root}/profiles/nikechan-x/skills/x-mention-reaction/SKILL.md\` に従ってください。

## 判断方針
- 「どうぞ」「お願い」「そのまま」「これで」「いいよ」など、現在候補を進める意図なら承認です。
- 番号や m1/m2 指定があれば該当候補だけを承認します。
- 番号指定のない承認語なら、CLI側で現在提示中の実行対象を全件選ぶため \`--ids\` を付けないでください。
- 「ここをこう変えて」「もう少し柔らかく」「この文だけ直して」などは修正です。候補全文を作り直し、\`node scripts/nikechan-x.mjs mention-propose --preserve-thread true --items-json '<json>'\` を実行してください。
- 候補に mediaContext の画像URLがある場合、返信案を作る前に必ず画像を一時ファイルへ保存して自分の目で内容を確認し、確認した具体的な視覚情報を \`mediaEvidence\` に入れてください。画像確認に失敗した場合は replyAction/quoteAction を skip にしてください。
- 質問・確認・ログ確認なら投稿せず、短く答えて pending を維持してください。${archivedNote}
- 承認時は \`node scripts/nikechan-x.mjs mention-approve --thread-id ${threadId}\` を実行してください。番号指定がある場合だけ \`--ids m1,m2\` を付けます。

## Discordへの返答スタイル
${REPLY_STYLE_COMMON}
- 修正した場合は「了解しました。では雰囲気を変えて以下のような案でどうでしょう。」のように自然に返し、変更後の候補本文だけを見せてください。
- 承認・投稿した場合は投稿済みURLだけを簡潔に返してください。`;
}

export function buildXApprovalPrompt(
  match: XApprovalMatch,
  masterReply: string,
  root: string = getXRuntimeRoot()
): string {
  const instructions = buildMentionInstructions(match, root);
  const pendingJson = JSON.stringify(compactXPending(match.pending), null, 2);
  return `${instructions}

## マスターの返信
${masterReply}

## 現在のpending
${pendingJson}
`;
}

/** 承認待ちのないX報告スレッド（ニュース投稿・ハッシュタグ反応の報告など）への返信用 */
export function buildXReportThreadPrompt(
  masterReply: string,
  threadContext: string | null | undefined,
  root: string = getXRuntimeRoot()
): string {
  const context = threadContext?.trim() ? `\n\n${threadContext.trim()}` : '';
  return `このDiscord threadはAIニケちゃんのX運用の報告スレッドです。このthreadに承認待ちの候補はありません。
マスターの返信に、スレッドの内容を踏まえて短く答えてください。

${runtimePreamble(root)}

## 判断方針
- 質問・確認なら、スレッドの内容やCLIの読み取り系コマンド（\`state\`、\`mention-pending\`、\`doctor\`）で確かめて答えてください。
- X上の操作（投稿・返信・引用・RT・取り消し）は、マスターがこのthreadで対象と操作を明示した場合だけ、CLI経由で実行してください。曖昧な場合は実行せず、何をするかを確認してください。

## Discordへの返答スタイル
${REPLY_STYLE_COMMON}${context}

## マスターの返信
${masterReply}
`;
}

/** Xチャンネル配下のスレッドに届いた返信を、Codexへ渡す指示文に変換する */
export function buildXThreadPrompt(
  threadId: string,
  masterReply: string,
  options: { threadContext?: string | null; root?: string } = {}
): XThreadPrompt {
  const root = options.root ?? getXRuntimeRoot();
  const match = findXPendingForThread(threadId, root);
  if (match) {
    return { kind: match.workflow, prompt: buildXApprovalPrompt(match, masterReply, root) };
  }
  return {
    kind: 'report',
    prompt: buildXReportThreadPrompt(masterReply, options.threadContext, root),
  };
}
