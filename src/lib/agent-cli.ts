import { spawn } from 'child_process';

export interface AgentCliResult {
  text: string;
  sessionId?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  session_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  result?: string;
  content?: string;
}

export function shouldUseCodexHelper(): boolean {
  return process.env.AGENT_BACKEND === 'codex';
}

export function runCodexHelper(
  prompt: string,
  options?: { systemPrompt?: string; logPrefix?: string }
): Promise<AgentCliResult> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ephemeral',
      '--cd',
      '/tmp',
    ];
    if (process.env.AGENT_MODEL) args.push('--model', process.env.AGENT_MODEL);

    const fullPrompt = options?.systemPrompt
      ? `<system-context>\n${options.systemPrompt}\n</system-context>\n\n${prompt}`
      : prompt;
    args.push(fullPrompt);

    const proc = spawn('codex', args, {
      env: process.env,
      cwd: '/tmp',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let sessionId: string | undefined;
    let text = '';

    proc.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexEvent;
          sessionId = event.thread_id ?? event.session_id ?? sessionId;
          const eventText =
            event.type === 'item.completed' && event.item?.type === 'agent_message'
              ? event.item.text
              : (event.result ?? event.content);
          if (eventText) text = eventText;
        } catch {
          // Ignore partial/non-JSON lines.
        }
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim().slice(0, 500) || 'no stderr/stdout';
        reject(new Error(`codex failed (${code}): ${detail}`));
        return;
      }
      if (!text.trim()) {
        reject(new Error(`codex returned empty result: ${stdout.slice(0, 500)}`));
        return;
      }
      if (stderr.trim() && options?.logPrefix) {
        console.warn(`[${options.logPrefix}] codex stderr: ${stderr.trim().slice(0, 500)}`);
      }
      resolve({ text: text.trim(), sessionId });
    });
    proc.on('error', reject);
  });
}
