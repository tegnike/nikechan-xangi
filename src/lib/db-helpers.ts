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

export function formatMemory(entries: MemoryEntry[]): string {
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
    for (const e of dayEntries) {
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

// ─── ユーザー ────────────────────────────────────────────────────────

export async function ensureKarakuriUser(
  agentId: string,
  agentName: string
): Promise<{ id: string; needsMemoInit: boolean }> {
  const raw = await runDbSh(['user-ensure', 'karakuri', agentId, agentId, agentName]);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`user-ensure returned non-JSON: ${raw.slice(0, 100)}`);
  }
  const id = data.id as string;
  const needsMemoInit = !data.memo;
  return { id, needsMemoInit };
}

export async function updateUserMemo(userId: string, memo: string): Promise<void> {
  await runDbSh(['user-update', userId, 'memo', memo]);
}

export async function touchUser(userId: string): Promise<void> {
  await runDbSh(['user-touch', userId]);
}
