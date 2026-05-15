import { spawn } from 'child_process';
import { join } from 'path';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();
const GUARD_SCRIPT = join(WORKDIR, 'scripts/public-safety.sh');

export async function assertPublicOutputAllowed(surface: string): Promise<void> {
  await runPublicSafety(['output-allowed', surface]);
}

export async function assertPublicEgressAllowed(surface: string, text: string): Promise<void> {
  await runPublicSafety(['egress-check', surface, text]);
}

function runPublicSafety(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [GUARD_SCRIPT, ...args], {
      cwd: WORKDIR,
      env: process.env,
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
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(formatPublicSafetyError(stdout, stderr)));
    });
    proc.on('error', reject);
  });
}

function formatPublicSafetyError(stdout: string, stderr: string): string {
  const body = stdout.trim() || stderr.trim();
  if (!body) return 'public safety guard blocked output';
  try {
    const parsed = JSON.parse(body) as { reason?: string; reasons?: string[] };
    const reason = parsed.reason || parsed.reasons?.join(', ');
    return reason ? `public safety guard blocked output: ${reason}` : body;
  } catch {
    return body;
  }
}
