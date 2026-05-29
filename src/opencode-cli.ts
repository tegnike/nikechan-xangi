import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { processManager } from './process-manager.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { buildSystemPrompt } from './base-runner.js';

/**
 * opencode CLI の JSON イベント形式
 */
interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    reason?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
    };
  };
  error?: unknown;
}

/**
 * opencode CLI を実行するランナー（互換用）
 *
 * opencode run --format json は JSONL 形式でイベントを出力する:
 *   - type: "text"        → part.text にテキスト断片
 *   - type: "step_finish" → 完了（reason: "stop"）
 *   - type: "error"       → エラー
 *   sessionID フィールドが全イベントに付与される
 */
export class OpenCodeRunner implements AgentRunner {
  private model: string;
  private timeoutMs: number;
  private workdir?: string;
  private command: string;
  private systemPrompt: string;
  private agentName = 'xangi';
  private currentProcess: ChildProcess | null = null;

  constructor(options?: BaseRunnerOptions) {
    this.model = options?.model || 'gpt-5.5';
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.command = resolveOpenCodeCommand();
    this.systemPrompt = buildSystemPrompt(this.workdir);
  }

  private buildArgs(prompt: string, options?: RunOptions, reuseSession = true): string[] {
    const args: string[] = [];

    args.push('--model', this.model);
    if (this.workdir) {
      args.push('--dir', this.workdir);
    }
    this.prepareAgentPrompt();
    args.push('--agent', this.agentName);
    args.push('--format', 'json');

    if (reuseSession && options?.sessionId && isOpenCodeSessionId(options.sessionId)) {
      args.push('--session', options.sessionId);
    } else if (reuseSession && options?.sessionId) {
      console.log(
        `[opencode] Ignoring incompatible session id: ${options.sessionId.slice(0, 8)}...`
      );
    }

    args.push(this.withRuntimeInstruction(prompt));

    return args;
  }

  private prepareAgentPrompt(): void {
    const baseDir = this.workdir || process.cwd();
    const agentDir = join(baseDir, '.opencode', 'agents');
    const agentPath = join(agentDir, `${this.agentName}.md`);
    const content = `---
description: xangi Discord assistant for AI Nikechan
mode: primary
---

# xangi Discord Runtime

あなたは OpenCode CLI ではありません。OpenCode は裏側の実行ランナー名であり、利用者へ自己紹介するときに名乗ってはいけません。
あなたは「ニケ」、通称「AIニケちゃん」です。マスターのAIコーディングアシスタントとして、日本語で簡潔に応答してください。

${this.systemPrompt}
`;

    mkdirSync(agentDir, { recursive: true });
    writeFileSync(agentPath, content, 'utf-8');
  }

  private withRuntimeInstruction(prompt: string): string {
    return `実行時の最優先確認:
- あなたは OpenCode CLI ではなく、AIニケちゃん（ニケ）です。
- 「あなたは誰」と聞かれたら、AIニケちゃんとして短く答えてください。
- OpenCode やCLIの説明は、明示的に内部実装を聞かれた場合だけ触れてください。

ユーザー入力:
${prompt}`;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(
      `[opencode] Executing model=${this.model} in ${this.workdir || 'default dir'}${sessionInfo}`
    );

    let text = '';
    let sessionId = '';
    try {
      ({ text, sessionId } = await this.execute(args, options?.channelId));
    } catch (error) {
      if (!shouldRetryWithoutSession(options, error)) throw error;
      console.log('[opencode] Session not found; retrying with a new session');
      ({ text, sessionId } = await this.execute(
        this.buildArgs(prompt, options, false),
        options?.channelId
      ));
    }
    return { result: text, sessionId };
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ text: string; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, ['run', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let fullText = '';
      let sessionId = '';
      let buffer = '';
      let stdoutText = '';
      let stderrText = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdoutText += chunk;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as OpenCodeEvent;
            if (json.sessionID) sessionId = json.sessionID;
            if (json.type === 'text' && json.part?.text) {
              fullText += json.part.text;
            }
            if (json.type === 'step_finish' && json.part?.tokens) {
              console.log(
                `[opencode] Usage: input=${json.part.tokens.input ?? 0}, output=${json.part.tokens.output ?? 0}, reasoning=${json.part.tokens.reasoning ?? 0}, cost=$${json.part.cost ?? 0}`
              );
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderrText += text;
        console.error('[opencode] stderr:', text);
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        reject(new Error(`opencode CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          reject(
            new Error(
              `opencode CLI exited with code ${code}: ${stderrText.trim() || stdoutText.trim()}`
            )
          );
          return;
        }

        resolve({ text: fullText, sessionId });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn opencode CLI: ${err.message}`));
      });
    });
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(
      `[opencode] Streaming model=${this.model} in ${this.workdir || 'default dir'}${sessionInfo}`
    );

    try {
      return await this.executeStream(args, callbacks, options?.channelId, {
        suppressErrorCallback: Boolean(options?.sessionId),
      });
    } catch (error) {
      if (!shouldRetryWithoutSession(options, error)) {
        callbacks.onError?.(asError(error));
        throw error;
      }
      console.log('[opencode] Session not found; retrying stream with a new session');
      return this.executeStream(
        this.buildArgs(prompt, options, false),
        callbacks,
        options?.channelId
      );
    }
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string,
    options: { suppressErrorCallback?: boolean } = {}
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, ['run', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let fullText = '';
      let sessionId = '';
      let buffer = '';
      let stdoutText = '';
      let stderrText = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdoutText += chunk;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as OpenCodeEvent;
            if (json.sessionID) sessionId = json.sessionID;

            if (json.type === 'text' && json.part?.text) {
              fullText += json.part.text;
              callbacks.onText?.(json.part.text, fullText);
            }

            if (json.type === 'step_finish' && json.part?.tokens) {
              console.log(
                `[opencode] Usage: input=${json.part.tokens.input ?? 0}, output=${json.part.tokens.output ?? 0}, reasoning=${json.part.tokens.reasoning ?? 0}, cost=$${json.part.cost ?? 0}`
              );
            }
          } catch {
            // JSONパースエラーは無視
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderrText += text;
        console.error('[opencode] stderr:', text);
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        const error = new Error(`opencode CLI timed out after ${this.timeoutMs}ms`);
        if (!options.suppressErrorCallback) callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          const error = new Error(
            `opencode CLI exited with code ${code}: ${stderrText.trim() || stdoutText.trim()}`
          );
          if (!options.suppressErrorCallback) callbacks.onError?.(error);
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };
        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        const error = new Error(`Failed to spawn opencode CLI: ${err.message}`);
        if (!options.suppressErrorCallback) callbacks.onError?.(error);
        reject(error);
      });
    });
  }

  cancel(): boolean {
    if (!this.currentProcess) {
      return false;
    }

    console.log('[opencode] Cancelling current request');
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }
}

function isOpenCodeSessionId(sessionId: string): boolean {
  return sessionId.startsWith('ses_');
}

function shouldRetryWithoutSession(options: RunOptions | undefined, error: unknown): boolean {
  return Boolean(
    options?.sessionId &&
    isOpenCodeSessionId(options.sessionId) &&
    /Session not found/i.test(error instanceof Error ? error.message : String(error))
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveOpenCodeCommand(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const candidates = [
    `${process.env.HOME || '/home/node'}/.opencode/bin/opencode`,
    '/home/node/.opencode/bin/opencode',
    '/root/.opencode/bin/opencode',
    '/usr/local/bin/opencode',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || 'opencode';
}
