import { spawn, ChildProcess } from 'child_process';
import { processManager } from './process-manager.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { BaseRunnerOptions } from './base-runner.js';

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
 * opencode CLI を実行するランナー（Alibaba/Qwen 対応）
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
  private currentProcess: ChildProcess | null = null;

  constructor(options?: BaseRunnerOptions) {
    this.model = options?.model || 'alibaba/qwen3.5-plus';
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
  }

  private buildArgs(prompt: string, options?: RunOptions): string[] {
    const args: string[] = [];

    args.push('--model', this.model);
    args.push('--format', 'json');

    if (options?.sessionId) {
      args.push('--session', options.sessionId);
    }

    args.push(prompt);

    return args;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(
      `[opencode] Executing model=${this.model} in ${this.workdir || 'default dir'}${sessionInfo}`
    );

    const { text, sessionId } = await this.execute(args, options?.channelId);
    return { result: text, sessionId };
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ text: string; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('opencode', ['run', ...args], {
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

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
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
        console.error('[opencode] stderr:', data.toString());
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
          reject(new Error(`opencode CLI exited with code ${code}`));
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

    return this.executeStream(args, callbacks, options?.channelId);
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('opencode', ['run', ...args], {
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

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
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
        console.error('[opencode] stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        const error = new Error(`opencode CLI timed out after ${this.timeoutMs}ms`);
        callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          const error = new Error(`opencode CLI exited with code ${code}`);
          callbacks.onError?.(error);
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
        callbacks.onError?.(error);
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
