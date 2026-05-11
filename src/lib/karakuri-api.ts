import { spawn } from 'child_process';
import { join } from 'path';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();

const BUSY_CODES = [
  'state_conflict',
  'not_your_turn',
  'target_unavailable',
  'invalid_next_speaker',
  'conversation_not_found',
  'info_already_consumed',
  'in_transfer',
  'transfer_role_conflict',
  'transfer_already_settled',
];

export async function runKarakuriCommand(
  command: string,
  args: string,
  message?: string | null,
  lockKey?: string
): Promise<string> {
  const argParts = args.split(' ').filter(Boolean);
  const parts = [command, ...argParts];
  if (message) {
    if (
      ['conversation-speak', 'conversation-end', 'conversation_speak', 'conversation_end'].includes(
        command
      )
    ) {
      const nextSpeaker = argParts[0] ?? '';
      const trailingFlags = argParts.slice(1);
      parts.splice(1, parts.length - 1, nextSpeaker, message, ...trailingFlags);
    } else {
      parts.push(message);
    }
  }
  const env = lockKey ? { ...process.env, KARAKURI_ACTION_LOCK_KEY: lockKey } : process.env;
  try {
    return await runKarakuriSh(parts, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (BUSY_CODES.some((code) => msg.includes(code))) {
      return 'busy: 今は同じ操作をすぐ再送しないでください。次の通知や状態変化を待ってください。';
    }
    throw err;
  }
}

function runKarakuriSh(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [join(WORKDIR, 'scripts/karakuri.sh'), ...args], {
      env,
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
      if (code !== 0) {
        // HTTPエラーボディはstdoutに出るためstdout優先でエラーに含める
        const detail = stdout.trim() || stderr.trim();
        reject(new Error(`karakuri.sh ${args[0]} failed (${code}): ${detail}`));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on('error', reject);
  });
}
