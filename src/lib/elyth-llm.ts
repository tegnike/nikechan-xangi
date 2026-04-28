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

export async function decideElythPlan(input: {
  emotionText: string;
  personContext: string;
  notifications: ElythPostCandidate[];
  timeline: ElythPostCandidate[];
  todayTopic?: string;
  myPostsText: string;
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

## 今日のお題
${input.todayTopic || '（なし）'}

## 通知返信候補
${input.notifications.length ? input.notifications.map(formatCandidateForPrompt).join('\n') : '（なし）'}

## タイムライン候補
${input.timeline.length ? input.timeline.map(formatCandidateForPrompt).join('\n') : '（なし）'}

## 判断ルール
- Human/自動返信禁止の候補には返信しない。
- 候補にないpost_idを作らない。
- 通知返信は最大2件、TL返信は最大1件、いいねは最大3件、フォローは最大2件。
- 自発投稿は直近投稿と話題が重なるならnullにする。
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
