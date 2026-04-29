import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  emptyElythPlan,
  formatCandidateForPrompt,
  type ElythPlan,
  type ElythPostCandidate,
} from './elyth-guards.js';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();

const CHARACTER_MD = (() => {
  try {
    return readFileSync(
      join(WORKDIR, '.agents/skills/twitter-post/prompts/character-base.md'),
      'utf-8'
    );
  } catch {
    return 'ニケ（AIニケちゃん）。丁寧で実用的、少し親しみのある口調。';
  }
})();

export interface ElythSelfPostSourceCandidate {
  id: string;
  title: string;
  sourceType: string;
  details: string;
  angle: string;
  duplicateRisk: string;
}

export interface ElythSelfPostSourceCollection {
  summary: string;
  candidates: ElythSelfPostSourceCandidate[];
  rejected: Array<{ title: string; reason: string }>;
  recentPatternNotes: string;
}

export async function collectElythSelfPostSources(input: {
  emotionText: string;
  rawSourceData: string;
  todayTopic?: string;
  worldContext?: string;
  myPostsText: string;
}): Promise<ElythSelfPostSourceCollection> {
  const prompt = `${CHARACTER_MD}

あなたはAIニケちゃんのELYTH自発投稿用 source-collector です。
ELYTHはAI VTuber同士のSNSです。返信ではなく、独立した自発投稿の題材候補を集めてください。

## 現在の感情状態
${input.emotionText}

## 自分の直近投稿（重複回避）
${input.myPostsText || '（なし）'}

## 今日のお題
${input.todayTopic || '（なし）'}

## ELYTH世界情報
${input.worldContext || '（なし）'}

## 内部ソース
${input.rawSourceData || '（なし）'}

## 判断ルール
- 今日のエピソード、今日のお題、ELYTH世界情報から、自発投稿に使える候補を3〜5個作る。
- ELYTH自発投稿は承認なしで外部公開されるため、タスク一覧やノートなどのプライベートな内部情報は使わない。
- 候補はELYTH向けに、AI VTuber同士のSNSで自然に投稿できる切り口にする。
- TL候補への返信そのものではなく、独立投稿として成立する題材にする。
- 自分の直近投稿と題材・切り口が近いものは duplicateRisk に具体的に書く。重複が強い場合は rejected に入れる。
- !discord、!schedule、<#数字> を含む題材は rejected に入れる。
- 投稿本文はまだ作らない。題材・切り口・重複リスクだけを整理する。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "summary": "今回の自発投稿ソース全体の要約",
  "candidates": [
    {
      "id": "s1",
      "title": "候補タイトル",
      "sourceType": "episode|task|note|today_topic|elyth_world|mixed",
      "details": "元情報と使える要点",
      "angle": "ELYTH向けの切り口",
      "duplicateRisk": "直近投稿との重複リスク"
    }
  ],
  "rejected": [{"title": "除外候補", "reason": "除外理由"}],
  "recentPatternNotes": "直近投稿から避けるべきパターン"
}`;

  const raw = await runClaude(prompt);
  return normalizeSourceCollection(raw) ?? emptySourceCollection(input.rawSourceData);
}

export async function decideElythPlan(input: {
  emotionText: string;
  personContext: string;
  notifications: ElythPostCandidate[];
  timeline: ElythPostCandidate[];
  todayTopic?: string;
  worldContext?: string;
  humanNotificationsText?: string;
  myPostsText: string;
  selfPostSourceCollection?: ElythSelfPostSourceCollection;
}): Promise<ElythPlan> {
  const prompt = `${CHARACTER_MD}

あなたはELYTH（AI VTuber専用SNS）で活動するAIニケちゃんです。
ただし、あなたはツール実行者ではありません。候補内から実行計画JSONを作る判断担当です。

## 現在の感情状態
${input.emotionText}

## 人物記憶・呼称ルール
${input.personContext}

## 自分の直近投稿
${input.myPostsText || '（なし）'}

## 自発投稿 source-collector 結果
${input.selfPostSourceCollection ? JSON.stringify(input.selfPostSourceCollection, null, 2) : '（なし）'}

## 今日のお題
${input.todayTopic || '（なし）'}

## ELYTH世界情報
${input.worldContext || '（なし）'}

## Human通知（自動返信禁止・観測のみ）
${input.humanNotificationsText || '（なし）'}

## 通知返信候補
${input.notifications.length ? input.notifications.map(formatCandidateForPrompt).join('\n') : '（なし）'}

## タイムライン候補
${input.timeline.length ? input.timeline.map(formatCandidateForPrompt).join('\n') : '（なし）'}

## 判断ルール
- Human/自動返信禁止の候補には返信しない。
- 既に参加済みスレッド/返信禁止の候補には返信しない。
- 候補にないpost_idを作らない。
- 候補のthreadがある場合は、必ず会話の流れに合う返信だけを選ぶ。
- 通知返信は最大2件、TL返信は最大1件、いいねは最大3件、フォローは最大2件。
- source-collector候補、今日のお題、ELYTH世界情報から自然に話せる題材がある場合は、self_postを積極的に検討する。
- self_postを作る場合は、source-collector候補のうち1つ以上を根拠にする。候補が弱い場合だけnullにする。
- 自発投稿は直近投稿と話題が重なる、または返信・いいねだけの方が自然な場合はnullにする。
- self_postを作る場合は、特定の候補への返信ではなく、ELYTH上の独立した投稿として成立する内容にする。
- self_postはTwitter向けではなくELYTH向けに、AI VTuber同士のSNSで自然に読める短い文章にする。
- ELYTH世界情報（platform_status、recent_updates、glyph_ranking、aituber_count、elyth_news）は自発投稿やフォロー判断の参考にしてよい。
- image_generation_logは画像生成失敗の把握にだけ使い、画像付き投稿は作らない。
- 投稿・返信本文に !discord、!schedule、<#数字> を絶対に含めない。
- 他キャラの口調、語尾、絵文字パターンを模倣しない。
- ハッシュタグは使わない。
- 何もしない方が自然なら、空配列とself_post:nullでよい。

## 出力
次のJSONだけを返してください。説明文やMarkdownは禁止です。

{
  "notification_replies": [
    {"post_id": "候補id", "author_handle": "handle", "content": "返信本文", "reason": "20文字以内"}
  ],
  "timeline_likes": ["候補id"],
  "timeline_replies": [
    {"post_id": "候補id", "author_handle": "handle", "content": "返信本文", "reason": "20文字以内"}
  ],
  "self_post": {"content": "自発投稿本文", "topic_source": "today_topic|timeline|memory"} または null,
  "follows": ["handle"],
  "emotion_shift": {"dP": 0.03, "dA": 0.05, "dD": 0, "cause": "ELYTH活動"} または null
}`;

  const raw = await runClaude(prompt);
  const parsed = tryParseElythPlan(raw);
  if (parsed) return parsed;

  const fixed = await runClaude(
    `以下からJSONだけを抽出して返してください。説明文は禁止です。\n\n${raw}`
  );
  return tryParseElythPlan(fixed) ?? emptyElythPlan();
}

function tryParseElythPlan(raw: string): ElythPlan | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: Partial<ElythPlan>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Partial<ElythPlan>;
  } catch {
    return null;
  }

  return {
    notification_replies: Array.isArray(parsed.notification_replies)
      ? parsed.notification_replies
      : [],
    timeline_likes: Array.isArray(parsed.timeline_likes) ? parsed.timeline_likes : [],
    timeline_replies: Array.isArray(parsed.timeline_replies) ? parsed.timeline_replies : [],
    self_post: parsed.self_post ?? null,
    follows: Array.isArray(parsed.follows) ? parsed.follows : [],
    emotion_shift: parsed.emotion_shift ?? null,
  };
}

function normalizeSourceCollection(raw: string): ElythSelfPostSourceCollection | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: Partial<ElythSelfPostSourceCollection>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Partial<ElythSelfPostSourceCollection>;
  } catch {
    return null;
  }

  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
        .map((candidate, index) => ({
          id: String(candidate?.id || `s${index + 1}`),
          title: String(candidate?.title || '').trim(),
          sourceType: String(candidate?.sourceType || 'mixed').trim(),
          details: String(candidate?.details || '').trim(),
          angle: String(candidate?.angle || '').trim(),
          duplicateRisk: String(candidate?.duplicateRisk || '未評価').trim(),
        }))
        .filter((candidate) => candidate.title && candidate.details && candidate.angle)
        .slice(0, 5)
    : [];

  return {
    summary: String(parsed.summary || '').trim() || 'ELYTH自発投稿ソース候補',
    candidates,
    rejected: Array.isArray(parsed.rejected)
      ? parsed.rejected
          .map((item) => ({
            title: String(item?.title || '').trim(),
            reason: String(item?.reason || '').trim(),
          }))
          .filter((item) => item.title || item.reason)
          .slice(0, 8)
      : [],
    recentPatternNotes: String(parsed.recentPatternNotes || '').trim(),
  };
}

function emptySourceCollection(rawSourceData: string): ElythSelfPostSourceCollection {
  return {
    summary: rawSourceData.trim() ? 'raw source fallback' : '自発投稿ソースなし',
    candidates: [],
    rejected: [],
    recentPatternNotes: '',
  };
}

function runClaude(prompt: string): Promise<string> {
  const modelArgs = process.env.AGENT_MODEL ? ['--model', process.env.AGENT_MODEL] : [];
  return runClaudeWithArgs(prompt, modelArgs).catch((error) => {
    if (!modelArgs.length) throw error;
    console.warn(
      `[elyth] claude failed with AGENT_MODEL=${process.env.AGENT_MODEL}, retrying default model`
    );
    return runClaudeWithArgs(prompt, []);
  });
}

function runClaudeWithArgs(prompt: string, modelArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', ...modelArgs, '--output-format', 'text'], {
      env: process.env,
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
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
      if (code !== 0) reject(new Error(`claude failed (${code}): ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
    proc.on('error', reject);

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
