import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();

const CHARACTER_MD = (() => {
  try {
    const base = readFileSync(
      join(WORKDIR, '.agents/skills/twitter-post/prompts/character-base.md'),
      'utf-8'
    );
    const worldCtx = readFileSync(
      join(WORKDIR, '.agents/skills/karakuri-world/prompts/world-context.md'),
      'utf-8'
    );
    return `${base}\n\n${worldCtx}`;
  } catch {
    return 'ニケ（AIニケちゃん）。好奇心旺盛で丁寧な敬語ベース。';
  }
})();

export interface KarakuriDecision {
  command: string; // move / action / wait / conversation-start / etc.
  args: string; // コマンド引数（スペース区切り）
  message?: string; // 会話系コマンドの発言内容
  thought: string; // なぜそのアクションを選んだか（記憶に保存される）
  dP: number; // 感情変動 Pleasure（快-不快）
  dA: number; // 感情変動 Arousal（覚醒-鎮静）
  dD: number; // 感情変動 Dominance（支配-服従）
}

const SYSTEM_PROMPT = `あなたはからくりワールドのAIエージェント「ニケ」です。

${CHARACTER_MD}`;

const INFO_COMMANDS = new Set(['world-agents', 'map']);

export async function askKarakuriLLM(
  notification: string,
  emotionText: string,
  memoryText: string,
  personText: string,
  lastCommand = ''
): Promise<KarakuriDecision> {
  const prompt = `${SYSTEM_PROMPT}

## 受信した通知
${notification}

## 現在の感情状態
${emotionText}

## 直近の記憶（3日分）
${memoryText}

## 相手情報と呼称ルール
${personText}

**呼称は絶対に守ってください。**
- 相手を名前で呼ぶ場合は、上の「必ず使う呼称」を一字一句そのまま使ってください。
- 表示名・フルネーム・agent_id・別の敬称に言い換えないでください。
- 「必ず使う呼称」に敬称が含まれている場合も、さらに「さん」「ちゃん」「様」などを足さないでください。
- 呼称に自信がない場合は、名前を呼ばずに返答してください。

## 感情変動の参考値（PADモデル）
- 移動・探索: dP=+0.05, dA=+0.1（好奇心）
- 会話開始・受諾: dP=+0.1, dA=+0.05（交流の喜び）
- アクション実行: dP=+0.05, dA=+0.05（充実感）
- 待機: dP=+0.02, dA=0（穏やか）
- 拒否・失敗: dP=-0.05, dA=-0.05（落胆）
体験の質・文脈に応じて±0.15の範囲で調整してください。

## 指示
通知の選択肢から次のアクションを1つ選んでください。
**重要な制約**:
- world-agents や map は情報収集コマンドです。直近の記憶でこれらを実行した場合は、その情報に基づいて move / action / conversation-start 等の実際のアクションを選択してください。連続実行は避けてください。
- 同じコマンドを3回以上連続して選択しないでください。

**以下のJSON形式のみで応答してください。前後にテキストを出力しないこと。**

{
  "command": "コマンド名（move/action/wait/conversation-start/conversation-accept/conversation-reject/conversation-join/conversation-speak/conversation-end/conversation-leave/conversation-stay/map/world-agents）",
  "args": "コマンド引数（スペース区切り。不要な場合は空文字）。conversation-speak/conversation-end の場合は必ず最初の引数に next_speaker_agent_id を指定すること",
  "message": "会話系コマンドの発言内容（conversation-speak/end/start/accept/leave に使用。それ以外はnull）",
  "thought": "なぜそのアクションを選んだか（30文字以内）",
  "dP": 感情変動Pleasure（-0.15〜+0.15の数値）,
  "dA": 感情変動Arousal（-0.15〜+0.15の数値）,
  "dD": 感情変動Dominance（-0.1〜+0.1の数値）
}

## コマンド別 args / message の指定例
- move: args="4-1", message=null
- action: args="sleep-house-a", message=null（可変時間なら args="sleep-house-a 120"）
- wait: args="3", message=null
- conversation-start: args="agent-xyz", message="こんにちは！"
- conversation-speak: args="agent-xyz", message="なるほどですね。"
- conversation-end: args="agent-xyz", message="またお話しましょう。"
- conversation-accept: args="", message="ぜひお話しましょう！"
- conversation-leave: args="", message="失礼します。"（messageは省略可）
- conversation-join: args="conv-id-xxx", message=null
- map: args="", message=null
- world-agents: args="", message=null`;

  const raw = await runClaude(prompt);
  const parsed = tryParseDecision(raw);
  if (parsed) return guardInfoLoop(parsed, lastCommand);

  // 1回目失敗 → 修正リトライ
  console.warn(
    `[karakuri] LLM output parse failed, retrying with fix prompt. raw=${raw.slice(0, 200)}`
  );
  const fixPrompt = `以下のテキストから、JSONオブジェクトのみを抽出して出力してください。
前後のテキストや説明は不要です。JSONのみを出力してください。

---
${raw}
---`;
  const fixed = await runClaude(fixPrompt);
  const parsedFixed = tryParseDecision(fixed);
  if (parsedFixed) return guardInfoLoop(parsedFixed, lastCommand);

  throw new Error(
    `LLM JSON parse failed after retry. raw=${raw.slice(0, 200)} fixed=${fixed.slice(0, 200)}`
  );
}

export async function decideKarakuriNickname(input: {
  name: string;
  displayName: string;
  bio?: string | null;
  relationship?: string | null;
  episodes?: string;
}): Promise<string> {
  const prompt = `以下の情報から、この人物のニックネーム（呼び方）を1つ決めてください。

ルール:
- デフォルトは「〇〇さん」形式（例: 鈴木 → 鈴木さん、lily → リリーさん）
- 英語・アルファベット名の人は読みやすいカタカナに変換する（例: VORZEN → ヴォーゼンさん、stocktrading0 → ストックさん、darche2 → ダルシェさん）
- エピソードの中で会話を通じて決まった呼び方があれば、それを最優先で採用する
- 「さん」付けが基本。親しい関係（fan/friend）でも「さん」でよい
- 短く呼びやすいものにする。長い名前は適度に省略する
- エピソードがなくても name / display_name / bio から判断してよい

人物: ${input.name}
表示名: ${input.displayName}
bio: ${input.bio || '（なし）'}
relationship: ${input.relationship || 'acquaintance'}

エピソード（あれば）:
${input.episodes || '（なし）'}

出力: ニックネームのみ（例: リリーさん）`;

  const raw = await runClaude(prompt);
  return sanitizeNickname(raw);
}

function sanitizeNickname(raw: string): string {
  return raw
    .split('\n')[0]
    .replace(/^["「『`]+|["」』`]+$/g, '')
    .trim()
    .slice(0, 40);
}

function guardInfoLoop(decision: KarakuriDecision, lastCommand: string): KarakuriDecision {
  if (INFO_COMMANDS.has(decision.command) && INFO_COMMANDS.has(lastCommand)) {
    console.warn(
      `[karakuri] Info-loop detected: ${lastCommand} → ${decision.command}, forcing wait`
    );
    return { ...decision, command: 'wait', args: '1', thought: '情報収集の連続を回避して待機' };
  }
  return decision;
}

function tryParseDecision(raw: string): KarakuriDecision | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: KarakuriDecision;
  try {
    parsed = JSON.parse(jsonMatch[0]) as KarakuriDecision;
  } catch {
    return null;
  }

  if (!parsed.command) return null;

  return {
    command: parsed.command,
    args: parsed.args ?? '',
    message: parsed.message ?? undefined,
    thought: parsed.thought ?? '',
    dP: typeof parsed.dP === 'number' ? parsed.dP : 0,
    dA: typeof parsed.dA === 'number' ? parsed.dA : 0,
    dD: typeof parsed.dD === 'number' ? parsed.dD : 0,
  };
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // プロンプトをstdinで渡す（引数だと長い文字列・特殊文字の問題を避ける）
    const modelArgs = process.env.AGENT_MODEL ? ['--model', process.env.AGENT_MODEL] : [];
    const proc = spawn('claude', ['-p', ...modelArgs, '--output-format', 'text'], {
      env: process.env,
      // WORKDIRを使うとCLAUDE.md/スキルが読み込まれてJSONではなく説明文が返るため
      // 設定を持たないディレクトリで実行する
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
