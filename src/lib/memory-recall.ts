import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface MemoryRecallOptions {
  workdir?: string;
  limit?: number;
  timeoutMs?: number;
}

interface MemorySearchResult {
  kind?: string;
  score?: number;
  topic?: string;
  decision?: string;
  rationale?: string;
  open_questions?: string[];
  title?: string;
  source_table?: string;
  source_record_id?: string | number;
  chunk_type?: string;
  content?: string;
}

interface MemorySearchOutput {
  results?: MemorySearchResult[];
}

const MEMORY_RECALL_PATTERN =
  /(覚えて(?:る|ます|いる)?|記憶|思い出|前に|以前|この前|昔|過去|話(?:した|してた|題にした)|したっけ|あったっけ|決めたっけ|なんだっけ|どうなったっけ|結論(?:は|どう)|方針(?:は|どう))/u;

const COMMAND_PREFIX_PATTERN =
  /^[/!](?:self-tweet|mention-reaction|hashtag-reaction|elyth-activity|karakuri|schedule|discord|skip|new|stop|restart|settings|skills|skill|compact)(?:\s|$)/u;

export function shouldRecallMemory(prompt: string): boolean {
  const text = normalizePrompt(prompt);
  if (!text || text.length < 4) return false;
  if (COMMAND_PREFIX_PATTERN.test(text)) return false;
  return MEMORY_RECALL_PATTERN.test(text);
}

export async function buildMemoryRecallContext(
  prompt: string,
  options: MemoryRecallOptions = {}
): Promise<string | null> {
  if (process.env.MEMORY_RECALL_ENABLED === 'false') return null;
  if (!shouldRecallMemory(prompt)) return null;

  const workdir = options.workdir || process.env.WORKSPACE_PATH || process.cwd();
  const limit = options.limit ?? Number(process.env.MEMORY_RECALL_LIMIT || 5);
  const timeoutMs = options.timeoutMs ?? Number(process.env.MEMORY_RECALL_TIMEOUT_MS || 30000);
  const query = normalizePrompt(prompt).slice(0, 500);

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(workdir, 'scripts/memory-search.mjs'), query, '--limit', String(limit), '--json'],
      {
        cwd: workdir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
      }
    );
    const parsed = JSON.parse(stdout) as MemorySearchOutput;
    const results = Array.isArray(parsed.results) ? parsed.results.slice(0, limit) : [];
    if (!results.length) return null;
    return formatMemoryRecallContext(query, results);
  } catch (error) {
    console.warn(
      '[memory-recall] search failed:',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

export function formatMemoryRecallContext(query: string, results: MemorySearchResult[]): string {
  const lines = [
    '## 過去記憶検索結果',
    'ユーザーの最新メッセージは過去の記憶確認・結論確認の可能性があります。以下は検索で見つかった根拠候補です。',
    `検索クエリ: ${query}`,
    '注意: 検索結果は候補です。根拠が弱い場合や該当がない場合は、断定せずその旨を伝えてください。',
    '',
  ];

  for (const [index, result] of results.entries()) {
    const score = typeof result.score === 'number' ? result.score.toFixed(3) : 'n/a';
    if (result.kind === 'decision') {
      lines.push(
        `### ${index + 1}. decision score=${score}`,
        result.topic ? `topic: ${oneLine(result.topic, 140)}` : '',
        result.decision ? `decision: ${oneLine(result.decision, 260)}` : '',
        result.rationale ? `rationale: ${oneLine(result.rationale, 260)}` : '',
        result.open_questions?.length
          ? `open_questions: ${result.open_questions.map((item) => oneLine(item, 120)).join(' / ')}`
          : ''
      );
    } else {
      const source = [result.source_table, result.source_record_id, result.chunk_type]
        .filter((item) => item !== undefined && item !== null && String(item).trim())
        .join('/');
      lines.push(
        `### ${index + 1}. chunk score=${score}`,
        result.title ? `title: ${oneLine(result.title, 160)}` : '',
        source ? `source: ${source}` : '',
        result.content ? `content: ${oneLine(result.content, 360)}` : ''
      );
    }
    lines.push('');
  }

  return lines
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function oneLine(value: string, max: number): string {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
