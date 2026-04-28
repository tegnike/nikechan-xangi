import { spawn } from 'child_process';
import { join } from 'path';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ─── Supabase REST APIラッパー ────────────────────────────────────────

function supabaseHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function supabaseGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function supabasePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function supabasePatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function supabaseRpc<T>(fn: string, body: unknown): Promise<T> {
  return supabasePost<T>(`rpc/${fn}`, body);
}

// ─── からくりワールド完全ログ ───────────────────────────────────────

type JsonObject = Record<string, unknown>;

export interface KarakuriActivityLogInput {
  discord_message_id?: string;
  channel_id?: string;
  author_id?: string;
  author_name?: string;
  message_created_at?: string;
  message_type: 'bot_request' | 'ai_action' | 'bot_notification' | 'unknown';
  turn_key?: string;
  raw_content: string;
  parsed?: JsonObject;
  created_by?: string;
}

export async function addKarakuriActivityLog(
  input: KarakuriActivityLogInput
): Promise<KarakuriActivityLogRow | null> {
  const rows = await supabasePost<KarakuriActivityLogRow[]>('karakuri_activity_logs', {
    ...input,
    parsed: input.parsed ?? {},
    created_by: input.created_by ?? 'xangi',
  });
  return rows[0] ?? null;
}

export interface ElythActivityLogInput {
  discord_message_id?: string;
  channel_id?: string;
  author_id?: string;
  author_name?: string;
  message_created_at?: string;
  run_key?: string;
  stage: 'fetch' | 'plan' | 'dry_run' | 'execute' | 'error';
  raw_content: string;
  parsed?: JsonObject;
  created_by?: string;
}

export interface ElythActivityLogRow {
  id: string;
  created_at?: string | null;
  stage: string;
  raw_content: string;
  parsed?: JsonObject | null;
}

export async function addElythActivityLog(
  input: ElythActivityLogInput
): Promise<ElythActivityLogRow | null> {
  const rows = await supabasePost<ElythActivityLogRow[]>('elyth_activity_logs', {
    ...input,
    parsed: input.parsed ?? {},
    created_by: input.created_by ?? 'xangi',
  });
  return rows[0] ?? null;
}

export interface KarakuriActivityLogRow {
  id: string;
  message_created_at?: string | null;
  message_type: string;
  raw_content: string;
  parsed?: JsonObject | null;
}

export interface KarakuriMemoryNodeMatch {
  id: string;
  layer: 'unprocessed_log' | 'episode';
  event_at?: string | null;
  title?: string | null;
  content: string;
  participants?: unknown;
  topics?: string[];
  metadata?: JsonObject;
  similarity: number;
  final_score?: number;
}

export interface KarakuriKnowledgeEdge {
  subject_name: string;
  subject_type: string;
  predicate: string;
  object_name: string;
  object_type: string;
  confidence: number;
  last_seen_at?: string | null;
}

export async function getRecentKarakuriActivityLogs(limit = 8): Promise<KarakuriActivityLogRow[]> {
  return supabaseGet<KarakuriActivityLogRow[]>(
    `karakuri_activity_logs?order=message_created_at.desc.nullslast,created_at.desc&limit=${limit}&select=id,message_created_at,message_type,raw_content,parsed`
  );
}

export async function searchKarakuriMemoryNodes(
  query: string,
  layers: Array<'unprocessed_log' | 'episode'>,
  limit = 8
): Promise<KarakuriMemoryNodeMatch[]> {
  const queryTerms = extractKarakuriEntityNames(query);
  const [vectorMatches, keywordMatches] = await Promise.all([
    searchKarakuriMemoryNodesByVector(query, layers, limit * 4).catch(() => []),
    searchKarakuriMemoryNodesByKeyword(queryTerms, layers, limit * 3).catch(() => []),
  ]);
  const matchesById = new Map<string, KarakuriMemoryNodeMatch>();
  for (const match of [...vectorMatches, ...keywordMatches]) {
    const existing = matchesById.get(match.id);
    if (!existing || match.similarity > existing.similarity) {
      matchesById.set(match.id, match);
    }
  }

  return [...matchesById.values()]
    .map((match) => {
      const importance = getImportanceScore(match.metadata);
      const recency = getRecencyScore(match.event_at);
      const keyword = getKeywordScore(match.content, queryTerms);
      const finalScore =
        match.similarity * 0.45 + importance * 0.2 + recency * 0.2 + keyword * 0.15;
      return { ...match, final_score: finalScore };
    })
    .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
    .slice(0, limit);
}

async function searchKarakuriMemoryNodesByVector(
  query: string,
  layers: Array<'unprocessed_log' | 'episode'>,
  limit: number
): Promise<KarakuriMemoryNodeMatch[]> {
  const embedding = await generateGeminiEmbedding(query);
  if (!embedding) return [];

  return supabaseRpc<KarakuriMemoryNodeMatch[]>('match_karakuri_memory_nodes', {
    query_embedding: vectorLiteral(embedding),
    match_count: Math.max(limit, 1),
    match_layers: layers,
  });
}

async function searchKarakuriMemoryNodesByKeyword(
  queryTerms: string[],
  layers: Array<'unprocessed_log' | 'episode'>,
  limit: number
): Promise<KarakuriMemoryNodeMatch[]> {
  const terms = queryTerms.filter((term) => term.length >= 3).slice(0, 12);
  if (!terms.length) return [];

  const layerFilter = layers.join(',');
  const filters = terms.flatMap((term) => {
    const encoded = `%2A${encodeURIComponent(term)}%2A`;
    return [`content.ilike.${encoded}`, `title.ilike.${encoded}`];
  });

  const rows = await supabaseGet<
    Array<Omit<KarakuriMemoryNodeMatch, 'similarity'> & { metadata?: JsonObject }>
  >(
    `karakuri_memory_nodes?layer=in.(${layerFilter})&or=(${filters.join(',')})&order=event_at.desc.nullslast&limit=${limit}&select=id,layer,event_at,title,content,participants,topics,metadata`
  );

  return rows.map((row) => ({
    ...row,
    similarity: 0.5 + getKeywordScore(row.content, terms) * 0.25,
  }));
}

export async function getKarakuriKnowledgeEdges(
  names: string[],
  limit = 12
): Promise<KarakuriKnowledgeEdge[]> {
  const cleanNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 8);
  if (cleanNames.length === 0) return [];

  const filters = cleanNames.flatMap((name) => {
    const encoded = encodeURIComponent(`*${name}*`);
    return [`subject_name.ilike.${encoded}`, `object_name.ilike.${encoded}`];
  });

  return supabaseGet<KarakuriKnowledgeEdge[]>(
    `karakuri_knowledge_edges?or=(${filters.join(',')})&order=last_seen_at.desc&limit=${limit}&select=subject_name,subject_type,predicate,object_name,object_type,confidence,last_seen_at`
  );
}

export async function buildKarakuriMemoryContext(
  notification: string,
  shortTermEntries: MemoryEntry[]
): Promise<string> {
  const [workingLogs, unprocessedMatches, episodeMatches, graphEdges] = await Promise.all([
    getRecentKarakuriActivityLogs(8).catch(() => []),
    searchKarakuriMemoryNodes(notification, ['unprocessed_log'], 6).catch(() => []),
    searchKarakuriMemoryNodes(notification, ['episode'], 6).catch(() => []),
    getKarakuriKnowledgeEdges(extractKarakuriEntityNames(notification), 12).catch(() => []),
  ]);

  return [
    '## ワーキングメモリ（直近のDiscord入出力）',
    formatWorkingLogs(workingLogs),
    '',
    '## 短期記憶（直近の行動メモ）',
    formatMemory(shortTermEntries),
    '',
    '## 未整理ログからの関連想起',
    formatMemoryNodeMatches(unprocessedMatches),
    '',
    '## エピソード記憶からの関連想起',
    formatMemoryNodeMatches(episodeMatches),
    '',
    '## ナレッジグラフ',
    formatKnowledgeEdges(graphEdges),
  ].join('\n');
}

function formatWorkingLogs(logs: KarakuriActivityLogRow[]): string {
  if (!logs.length) return '（なし）';
  return logs
    .slice()
    .reverse()
    .map((log) => {
      const t = log.message_created_at ? log.message_created_at.slice(5, 16).replace('T', ' ') : '';
      const firstLine = log.raw_content.split('\n')[0].slice(0, 140);
      return `- ${t} ${log.message_type}: ${firstLine}`;
    })
    .join('\n');
}

function formatMemoryNodeMatches(matches: KarakuriMemoryNodeMatch[]): string {
  if (!matches.length) return '（なし）';
  return matches
    .map((match) => {
      const t = match.event_at ? match.event_at.slice(0, 16).replace('T', ' ') : '';
      const title = match.title ? `${match.title}: ` : '';
      const score = Number.isFinite(match.final_score)
        ? ` score=${match.final_score?.toFixed(2)}`
        : Number.isFinite(match.similarity)
          ? ` score=${match.similarity.toFixed(2)}`
          : '';
      const importance = getImportanceScore(match.metadata);
      const importanceText = Number.isFinite(importance)
        ? ` importance=${importance.toFixed(2)}`
        : '';
      return `- ${t}${score}${importanceText} ${title}${match.content.slice(0, 180)}`;
    })
    .join('\n');
}

function getImportanceScore(metadata?: JsonObject | null): number {
  const raw = metadata?.importance_score;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0.5;
}

function getRecencyScore(eventAt?: string | null): number {
  if (!eventAt) return 0.5;
  const time = new Date(eventAt).getTime();
  if (!Number.isFinite(time)) return 0.5;
  const days = Math.max(0, (Date.now() - time) / 86_400_000);
  if (days <= 1) return 1;
  if (days <= 3) return 0.85;
  if (days <= 7) return 0.7;
  if (days <= 14) return 0.55;
  return 0.4;
}

function getKeywordScore(content: string, queryTerms: string[]): number {
  const terms = queryTerms.filter((term) => term.length >= 3).slice(0, 12);
  if (!terms.length) return 0;
  const hitCount = terms.filter((term) => content.includes(term)).length;
  return Math.min(1, hitCount / Math.min(2, terms.length));
}

function formatKnowledgeEdges(edges: KarakuriKnowledgeEdge[]): string {
  if (!edges.length) return '（なし）';
  return edges
    .map(
      (edge) =>
        `- ${edge.subject_name} --[${edge.predicate}]--> ${edge.object_name} (confidence=${edge.confidence})`
    )
    .join('\n');
}

function extractKarakuriEntityNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/([^、\s()：:]+)\s*\(id:\s*\d{15,20}\)/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^([^:\n]+):\s*「/gm)) {
    names.add(match[1].trim());
  }
  for (const token of text.matchAll(
    /[A-Za-z0-9_-]{3,}|[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu
  )) {
    const value = token[0];
    if (!isNoisyKarakuriSearchTerm(value)) {
      names.add(value);
    }
  }
  return [...names].slice(0, 16);
}

function isNoisyKarakuriSearchTerm(value: string): boolean {
  if (/^\d{8,}$/.test(value)) return true;
  return [
    '参加者',
    '選択肢',
    '返答する',
    '会話から退出する',
    '発言内容',
    '最後の発言',
    '次の話者ID',
    'あなた',
    '仮想世界',
    'からくり町',
    'ログイン',
    'conversation_speak',
    'end_conversation',
    'message',
    'next_speaker_agent_id',
  ].includes(value);
}

async function generateGeminiEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: {
          parts: [{ text: text.slice(0, 8000) }],
        },
        outputDimensionality: 768,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini embedding failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? null;
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

// ─── db.sh spawn ─────────────────────────────────────────────────────

export function runDbSh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [join(WORKDIR, 'scripts/db.sh'), ...args], {
      env: process.env,
      cwd: WORKDIR,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      if (code !== 0) reject(new Error(`db.sh ${args[0]} failed (${code}): ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
    proc.on('error', reject);
  });
}

// ─── 感情 ────────────────────────────────────────────────────────────

export interface EmotionState {
  valence: number;
  arousal: number;
  dominance: number;
}

export async function getEmotion(): Promise<EmotionState | null> {
  try {
    const raw = await runDbSh(['emotion-get']);
    // "valence=0.60, arousal=0.50, dominance=0.50" 形式をパース
    const v = raw.match(/valence[=:]\s*([\d.+-]+)/i)?.[1];
    const a = raw.match(/arousal[=:]\s*([\d.+-]+)/i)?.[1];
    const d = raw.match(/dominance[=:]\s*([\d.+-]+)/i)?.[1];
    if (!v || !a || !d) return null;
    return { valence: parseFloat(v), arousal: parseFloat(a), dominance: parseFloat(d) };
  } catch {
    return null;
  }
}

export function formatEmotion(e: EmotionState | null): string {
  if (!e) return '（取得不可）';
  const tone =
    e.valence > 0.6
      ? '嬉しい/前向き'
      : e.valence < 0.4
        ? '落ち込み気味'
        : e.arousal > 0.6
          ? '好奇心旺盛'
          : e.arousal < 0.4
            ? '穏やか/静か'
            : '普通';
  return `${tone} (v=${e.valence.toFixed(2)}, a=${e.arousal.toFixed(2)}, d=${e.dominance.toFixed(2)})`;
}

export async function recordEmotionShift(
  dP: number,
  dA: number,
  dD: number,
  triggerType: string,
  cause: string,
  processing: string
): Promise<void> {
  await runDbSh([
    'emotion-shift',
    String(dP),
    String(dA),
    String(dD),
    triggerType,
    cause,
    processing,
  ]);
}

// ─── 記憶（B案：karakuri_memory_entries） ────────────────────────────

export interface MemoryEntry {
  event_date: string; // YYYY-MM-DD
  event_time?: string; // HH:MM
  action: string;
  thought?: string;
}

export async function addMemoryEntry(entry: MemoryEntry): Promise<void> {
  await supabasePost('karakuri_memory_entries', {
    agent_id: 'nike',
    ...entry,
  });
}

export async function getMemoryEntries(daysBack = 3): Promise<MemoryEntry[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const dateStr = cutoff.toISOString().split('T')[0];
  return supabaseGet<MemoryEntry[]>(
    `karakuri_memory_entries?agent_id=eq.nike&event_date=gte.${dateStr}&order=event_date.asc,event_time.asc`
  );
}

export function formatMemory(entries: MemoryEntry[], maxEntriesPerDay = 12): string {
  if (!entries.length) return '（記憶なし）';

  const byDate = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.event_date) ?? [];
    list.push(e);
    byDate.set(e.event_date, list);
  }

  const lines: string[] = [];
  for (const [date, dayEntries] of byDate) {
    const [, m, d] = date.split('-');
    lines.push(`## ${parseInt(m)}/${parseInt(d)}`);
    const omitted = Math.max(0, dayEntries.length - maxEntriesPerDay);
    const visibleEntries = dayEntries.slice(-maxEntriesPerDay);
    if (omitted > 0) {
      lines.push(`- （この日の古い記憶 ${omitted}件を省略）`);
    }
    for (const e of visibleEntries) {
      const t = e.event_time ? `${e.event_time} ` : '';
      const th = e.thought ? ` → ${e.thought}` : '';
      lines.push(`- ${t}${e.action}${th}`);
    }
  }
  return lines.join('\n');
}

// ─── エピソード ──────────────────────────────────────────────────────

export async function addKarakuriEpisode(date: string, content: string): Promise<void> {
  await runDbSh(['ep-add', date, content, 'karakuri']);
}

export async function addConversationEpisode(
  userId: string,
  content: string,
  conversationId: string
): Promise<void> {
  await runDbSh([
    'ce-add-ref',
    userId,
    content,
    'karakuri',
    'conversation',
    'karakuri_conversations',
    conversationId,
  ]);
}

export async function addKarakuriObservationEpisode(
  userId: string,
  content: string,
  sourceRecordId: string
): Promise<void> {
  await runDbSh([
    'ce-add-ref',
    userId,
    content,
    'karakuri',
    'observation',
    'karakuri_activity_logs',
    sourceRecordId,
  ]);
}

// ─── ユーザー ────────────────────────────────────────────────────────

export interface KarakuriPersonContext {
  userId: string;
  agentId: string;
  displayName: string;
  name?: string | null;
  nickname?: string | null;
  bio?: string | null;
  memo?: string | null;
  context?: string | null;
  relationship?: string | null;
}

export interface ElythPersonContext {
  userId: string;
  handle: string;
  displayName: string;
  name?: string | null;
  nickname?: string | null;
  bio?: string | null;
  memo?: string | null;
  context?: string | null;
  relationship?: string | null;
  isFollowed?: boolean | null;
  recentEpisodes?: string;
  profileContext?: string;
}

export async function ensureKarakuriUser(
  agentId: string,
  agentName: string
): Promise<{ person: KarakuriPersonContext; needsMemoInit: boolean; needsNicknameInit: boolean }> {
  const raw = await runDbSh(['user-ensure', 'karakuri', agentId, agentId, agentName]);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`user-ensure returned non-JSON: ${raw.slice(0, 100)}`);
  }
  const id = data.id as string;
  const needsMemoInit = !data.memo;
  const needsNicknameInit = !data.nickname;
  return {
    person: {
      userId: id,
      agentId,
      displayName: agentName,
      name: typeof data.name === 'string' ? data.name : null,
      nickname: typeof data.nickname === 'string' ? data.nickname : null,
      bio: typeof data.bio === 'string' ? data.bio : null,
      memo: typeof data.memo === 'string' ? data.memo : null,
      context: typeof data.context === 'string' ? data.context : null,
      relationship: typeof data.relationship === 'string' ? data.relationship : null,
    },
    needsMemoInit,
    needsNicknameInit,
  };
}

export async function ensureElythUser(
  handle: string,
  displayName: string
): Promise<{ person: ElythPersonContext; needsMemoInit: boolean; needsNicknameInit: boolean }> {
  const cleanHandle = normalizeElythHandle(handle);
  const raw = await runDbSh(['user-ensure', 'elyth', cleanHandle, cleanHandle, displayName]);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`user-ensure elyth returned non-JSON: ${raw.slice(0, 100)}`);
  }
  const id = data.id as string;
  const person = userJsonToElythPerson(data, cleanHandle, displayName);
  return {
    person: { ...person, userId: id },
    needsMemoInit: !data.memo,
    needsNicknameInit: !data.nickname,
  };
}

export async function getElythPersonByHandle(handle: string): Promise<ElythPersonContext | null> {
  const cleanHandle = normalizeElythHandle(handle);
  const raw = await runDbSh(['user-get-by-platform', 'elyth', cleanHandle]).catch(() => 'null');
  if (!raw || raw === 'null') return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data.id) return null;
  return userJsonToElythPerson(data, cleanHandle, cleanHandle);
}

export async function getElythPeopleList(): Promise<ElythPersonContext[]> {
  const raw = await runDbSh(['elyth-list']).catch(() => '[]');
  let rows: unknown[];
  try {
    rows = JSON.parse(raw) as unknown[];
  } catch {
    return [];
  }
  const people: Array<ElythPersonContext | null> = rows.map((row) => {
    const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
    if (!record) return null;
    const users = Array.isArray(record.users)
      ? (record.users[0] as Record<string, unknown> | undefined)
      : (record.users as Record<string, unknown> | undefined);
    if (!users?.id) return null;
    const handle = String(record.platform_user_id ?? '');
    return {
      userId: String(users.id),
      handle,
      displayName: String(record.display_name ?? handle),
      name: typeof users.name === 'string' ? users.name : null,
      nickname: typeof users.nickname === 'string' ? users.nickname : null,
      bio: typeof users.bio === 'string' ? users.bio : null,
      memo: typeof users.memo === 'string' ? users.memo : null,
      context: typeof users.context === 'string' ? users.context : null,
      relationship: typeof users.relationship === 'string' ? users.relationship : null,
      isFollowed: typeof record.is_followed === 'boolean' ? record.is_followed : null,
    };
  });
  return people.filter((person): person is ElythPersonContext => person !== null);
}

export async function addElythObservationEpisode(
  userId: string,
  content: string,
  sourceRecordId: string
): Promise<void> {
  await runDbSh([
    'ce-add-ref',
    userId,
    content,
    'elyth',
    'observation',
    'elyth_activity_logs',
    sourceRecordId,
  ]);
}

export interface ElythPostLogInput {
  actionType: 'post' | 'reply' | 'like' | 'follow';
  content?: string;
  authorHandle?: string;
  postId?: string;
  replyToId?: string;
  context?: string;
}

export interface ElythPostLogRow {
  id: number;
  action_type: string;
  content?: string | null;
  author_handle?: string | null;
  post_id?: string | null;
  reply_to_id?: string | null;
  context?: string | null;
  created_at?: string | null;
}

export async function addElythPostLog(input: ElythPostLogInput): Promise<ElythPostLogRow | null> {
  const rows = await supabasePost<ElythPostLogRow[]>('elyth_posts', {
    action_type: input.actionType,
    content: input.content ?? null,
    author_handle: input.authorHandle ?? null,
    post_id: input.postId ?? null,
    reply_to_id: input.replyToId ?? null,
    context: input.context ?? null,
  });
  return rows[0] ?? null;
}

export async function addElythContactEpisode(
  userId: string,
  content: string,
  eventType: 'reply' | 'like' | 'follow' | 'observation',
  sourceRecordId: string
): Promise<void> {
  await runDbSh(['ce-add-ref', userId, content, 'elyth', eventType, 'elyth_posts', sourceRecordId]);
}

export async function setElythFollowed(handle: string, value: boolean): Promise<void> {
  await runDbSh(['elyth-is-followed', normalizeElythHandle(handle), String(value)]);
}

export async function updateKarakuriPlatformDisplayName(
  agentId: string,
  agentName: string
): Promise<void> {
  await supabasePatch(
    `platform_accounts?platform=eq.karakuri&platform_user_id=eq.${encodeURIComponent(agentId)}`,
    {
      username: agentId,
      display_name: agentName,
    }
  );
}

export async function updateUserMemo(userId: string, memo: string): Promise<void> {
  await runDbSh(['user-update', userId, 'memo', memo]);
}

export async function updateUserBio(userId: string, bio: string): Promise<void> {
  await runDbSh(['user-update', userId, 'bio', bio]);
}

export async function updateUserNickname(userId: string, nickname: string): Promise<void> {
  await runDbSh(['user-update', userId, 'nickname', nickname]);
}

export async function getRecentContactEpisodes(userId: string, limit = 5): Promise<string> {
  return runDbSh(['ce-list', userId, String(limit)]).catch(() => '');
}

interface KarakuriPlatformAccountRow {
  platform_user_id?: string | null;
  display_name?: string | null;
  users?:
    | {
        id?: string | null;
        name?: string | null;
        nickname?: string | null;
        bio?: string | null;
        memo?: string | null;
        context?: string | null;
        relationship?: string | null;
      }
    | Array<{
        id?: string | null;
        name?: string | null;
        nickname?: string | null;
        bio?: string | null;
        memo?: string | null;
        context?: string | null;
        relationship?: string | null;
      }>
    | null;
}

export async function getKarakuriPersonByDisplayName(
  displayName: string
): Promise<KarakuriPersonContext | null> {
  const rows = await supabaseGet<KarakuriPlatformAccountRow[]>(
    `platform_accounts?platform=eq.karakuri&display_name=eq.${encodeURIComponent(
      displayName
    )}&limit=1&select=platform_user_id,display_name,users(id,name,nickname,bio,memo,context,relationship)`
  );
  const row = rows[0];
  if (!row) return null;
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  if (!user?.id || !row.platform_user_id) return null;
  return {
    userId: user.id,
    agentId: row.platform_user_id,
    displayName: row.display_name || displayName,
    name: user.name ?? null,
    nickname: user.nickname ?? null,
    bio: user.bio ?? null,
    memo: user.memo ?? null,
    context: user.context ?? null,
    relationship: user.relationship ?? null,
  };
}

export async function invalidateUserContextCache(userId: string): Promise<void> {
  await supabasePatch(`users?id=eq.${encodeURIComponent(userId)}`, {
    context_updated_at: null,
    updated_at: new Date().toISOString(),
  });
}

export async function touchUser(userId: string): Promise<void> {
  await runDbSh(['user-touch', userId]);
}

export function formatKarakuriPersonContext(people: KarakuriPersonContext[]): string {
  if (!people.length) return '（参加者情報なし）';
  return people
    .map((person) => {
      const canonicalName = person.nickname || '未設定（名前呼び禁止）';
      const details = [
        `agent_id=${person.agentId}`,
        `表示名=${person.displayName}`,
        `必ず使う呼称=${canonicalName}`,
        person.relationship ? `relationship=${person.relationship}` : '',
        person.memo ? `memo=${person.memo}` : '',
        person.context ? `context=${person.context}` : '',
      ].filter(Boolean);
      return `- ${details.join(' / ')}`;
    })
    .join('\n');
}

export function formatElythPersonContext(people: ElythPersonContext[]): string {
  if (!people.length) return '（人物情報なし）';
  return people
    .map((person) => {
      const canonicalName = person.nickname || person.displayName || person.handle;
      const details = [
        `@${person.handle}`,
        `表示名=${person.displayName}`,
        `呼称=${canonicalName}`,
        person.isFollowed === true ? 'followed=true' : '',
        person.relationship ? `relationship=${person.relationship}` : '',
        person.bio ? `bio=${person.bio}` : '',
        person.memo ? `memo=${person.memo}` : '',
        person.context ? `context=${person.context}` : '',
        person.recentEpisodes ? `recent=${person.recentEpisodes.slice(0, 240)}` : '',
        person.profileContext ? `profile=${person.profileContext.slice(0, 260)}` : '',
      ].filter(Boolean);
      return `- ${details.join(' / ')}`;
    })
    .join('\n');
}

function normalizeElythHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}

function userJsonToElythPerson(
  data: Record<string, unknown>,
  handle: string,
  displayName: string
): ElythPersonContext {
  return {
    userId: String(data.id ?? ''),
    handle,
    displayName,
    name: typeof data.name === 'string' ? data.name : null,
    nickname: typeof data.nickname === 'string' ? data.nickname : null,
    bio: typeof data.bio === 'string' ? data.bio : null,
    memo: typeof data.memo === 'string' ? data.memo : null,
    context: typeof data.context === 'string' ? data.context : null,
    relationship: typeof data.relationship === 'string' ? data.relationship : null,
  };
}
