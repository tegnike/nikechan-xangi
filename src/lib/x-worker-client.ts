import { spawn } from 'child_process';

export type XWorkerWorkflowStatus =
  | 'success'
  | 'partial'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'dry-run'
  | 'needs_approval';

export interface XWorkerWorkflowRequest {
  workflow: 'self-tweet';
  surface: 'x';
  mode: 'dry-run' | 'shadow' | 'canary' | 'live';
  requested_by: string;
  schedule_id?: string;
  correlation_id?: string;
  constraints?: {
    require_approval?: boolean;
    max_actions?: number;
  };
  context?: Record<string, unknown>;
}

export interface XWorkerWorkflowAction {
  type: string;
  status: string;
  label?: string;
  preview?: string;
  reason?: string;
  id?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface XWorkerWorkflowReport {
  surface: 'x';
  workflow: 'self-tweet';
  status: XWorkerWorkflowStatus;
  summary: string;
  actions: XWorkerWorkflowAction[];
  sourceRefs: Array<{ type: string; id?: string; url?: string; label?: string }>;
  audit: Record<string, unknown>;
  memoryProposals: unknown[];
  skillProposals: unknown[];
  nextAction?: string;
  error?: string;
  createdAt: string;
}

export function isXWorkerSelfTweetEnabled(): boolean {
  return process.env.NIKECHAN_X_WORKER_SELF_TWEET_ENABLED === 'true';
}

export async function runXWorkerWorkflow(
  request: XWorkerWorkflowRequest
): Promise<XWorkerWorkflowReport> {
  const endpoint = process.env.NIKECHAN_X_WORKER_URL;
  if (endpoint) return runXWorkerWorkflowHttp(endpoint, request);
  return runXWorkerWorkflowCli(request);
}

async function runXWorkerWorkflowHttp(
  endpoint: string,
  request: XWorkerWorkflowRequest
): Promise<XWorkerWorkflowReport> {
  const url = endpoint.replace(/\/+$/u, '');
  const res = await fetch(`${url}/workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`nikechan-x-worker HTTP failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return parseXWorkerReport(body);
}

async function runXWorkerWorkflowCli(
  request: XWorkerWorkflowRequest
): Promise<XWorkerWorkflowReport> {
  const command = process.env.NIKECHAN_X_WORKER_COMMAND ?? 'nikechan-x-worker';
  const args = readCliArgs(request);
  const cwd = process.env.NIKECHAN_X_WORKER_CWD || process.cwd();
  const timeoutMs = Number(process.env.NIKECHAN_X_WORKER_TIMEOUT_MS ?? 180000);
  const raw = await execFileText(command, args, cwd, timeoutMs);
  return parseXWorkerReport(raw);
}

function readCliArgs(request: XWorkerWorkflowRequest): string[] {
  const configured = process.env.NIKECHAN_X_WORKER_ARGS;
  const payload = JSON.stringify(request);
  if (!configured) return ['run', '--json', payload];
  return configured
    .split(/\s+/u)
    .filter(Boolean)
    .map((arg) => (arg === '{json}' ? payload : arg));
}

function execFileText(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`nikechan-x-worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`nikechan-x-worker failed (${code}): ${stderr.trim().slice(0, 800)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseXWorkerReport(raw: string): XWorkerWorkflowReport {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('nikechan-x-worker returned non-object JSON');
  }
  const report = parsed as Partial<XWorkerWorkflowReport>;
  if (
    report.surface !== 'x' ||
    report.workflow !== 'self-tweet' ||
    !Array.isArray(report.actions)
  ) {
    throw new Error('nikechan-x-worker returned unexpected WorkflowReport shape');
  }
  return report as XWorkerWorkflowReport;
}
