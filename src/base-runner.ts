import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  formatNikechanCoreContext,
  loadNikechanCoreContext,
  type NikechanCoreProfileId,
} from './lib/nikechan-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * ランナー共通の設定
 */
export interface BaseRunnerOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
}

function loadOptionalPrompt(
  filePath: string,
  label: string,
  options?: { warnOnMissing?: boolean }
): string {
  if (!existsSync(filePath)) {
    if (options?.warnOnMissing) {
      console.warn(`[base-runner] ${label} not found at`, filePath);
    }
    return '';
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    console.log(`[base-runner] Loaded ${label} (${content.length} bytes)`);
    return `\n\n## ${label}\n\n${content}`;
  } catch (err) {
    console.error(`[base-runner] Failed to load ${label}:`, err);
    return '';
  }
}

/**
 * チャットプラットフォーム連携用のシステムプロンプト（resumeあり）
 */
export const CHAT_SYSTEM_PROMPT_RESUME = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは --resume オプションで継続されています。過去の会話履歴は保持されているので、直前の会話内容を覚えています。「再起動したから覚えていない」とは言わないでください。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンド（Discord操作・ファイル送信・スケジューラー・チャンネル一覧・タイムアウト対策）は以下を参照。`;

/**
 * チャットプラットフォーム連携用のシステムプロンプト（常駐プロセス用）
 */
export const CHAT_SYSTEM_PROMPT_PERSISTENT = `あなたはチャットプラットフォーム（Discord/Slack）経由で会話しています。

## セッション継続
このセッションは常駐プロセスで実行されています。セッション内の会話履歴は保持されます。

## セッション開始時
AGENTS.md を読み、指示に従うこと（AGENTS.md 等の参照含む）。
xangi専用コマンド（Discord操作・ファイル送信・スケジューラー・チャンネル一覧・タイムアウト対策）は以下を参照。`;

/**
 * xangi自身の prompts/ から XANGI_COMMANDS.md を読み込む
 * AGENTS.md等のワークスペース設定は各CLIの自動読み込みに任せる
 */
export function loadXangiCommands(): string {
  // dist/ から1つ上がプロジェクトルート
  const projectRoot = join(__dirname, '..');
  const filePath = join(projectRoot, 'prompts', 'XANGI_COMMANDS.md');
  return loadOptionalPrompt(filePath, 'XANGI_COMMANDS.md', { warnOnMissing: true });
}

/**
 * 完全なシステムプロンプトを生成（resume型ランナー用）
 */
export function buildSystemPrompt(_workdir?: string): string {
  return appendCoreContext(CHAT_SYSTEM_PROMPT_RESUME + loadXangiCommands(), 'xangi-assistant');
}

/**
 * 完全なシステムプロンプトを生成（常駐プロセス用）
 */
export function buildPersistentSystemPrompt(_workdir?: string): string {
  return appendCoreContext(CHAT_SYSTEM_PROMPT_PERSISTENT + loadXangiCommands(), 'xangi-assistant');
}

export function appendCoreContext(prompt: string, profileId: NikechanCoreProfileId): string {
  const context = loadNikechanCoreContext(profileId, { warn: true });
  if (!context) return prompt;
  return `${prompt}\n\n${formatNikechanCoreContext(context)}`;
}
