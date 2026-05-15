import {
  getPublicWorkflowReleaseMode,
  shouldDryRunPublicWorkflow,
  type PublicWorkflowReleaseMode,
  type PublicWorkflowSurface,
} from './public-workflow-mode.js';
import { type WorkflowReport } from './workflow-report.js';

export interface WorkflowControl {
  surface: PublicWorkflowSurface;
  releaseMode: PublicWorkflowReleaseMode;
  dryRun: boolean;
  live: boolean;
  persist: boolean;
}

export function resolveWorkflowControl(
  surface: PublicWorkflowSurface,
  explicitDryRun = false
): WorkflowControl {
  const releaseMode = getPublicWorkflowReleaseMode(surface, explicitDryRun);
  const dryRun = shouldDryRunPublicWorkflow(surface, explicitDryRun);
  return {
    surface,
    releaseMode,
    dryRun,
    live: !dryRun,
    persist: !dryRun,
  };
}

export function formatWorkflowReportForDiscord(
  report: WorkflowReport,
  detailText?: string
): string {
  const lines = [
    `管理レポート: ${surfaceLabel(report.surface)} / ${report.workflow}`,
    `status=${report.status} mode=${report.audit?.releaseMode ?? 'unknown'} dryRun=${report.audit?.dryRun ?? 'unknown'}`,
    report.summary,
  ];

  if (report.actions?.length) {
    lines.push(
      `actions=${report.actions
        .map((action) => `${action.label}:${action.status ?? report.status}`)
        .join(', ')}`
    );
  }
  if (report.nextAction) {
    lines.push(`next=${report.nextAction}`);
  }
  if (report.error) {
    lines.push(`error=${report.error.slice(0, 240)}`);
  }
  if (detailText?.trim()) {
    lines.push('', detailText.trim());
  }

  return lines.join('\n');
}

function surfaceLabel(surface: WorkflowReport['surface']): string {
  switch (surface) {
    case 'x':
      return 'X';
    case 'elyth':
      return 'ELYTH';
    case 'karakuri':
      return 'からくり';
    case 'discord':
      return 'Discord';
    case 'ops':
      return 'ops';
  }
}
