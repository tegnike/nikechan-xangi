export type WorkflowSurface = 'x' | 'elyth' | 'karakuri' | 'discord' | 'ops';

export type WorkflowReportStatus =
  | 'success'
  | 'partial'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'dry-run';

export interface WorkflowReportAction {
  type: string;
  label: string;
  status?: WorkflowReportStatus;
  url?: string;
  id?: string;
}

export interface WorkflowReportAudit {
  releaseMode?: string;
  dryRun?: boolean;
  guardStatus?: string;
  policyVersion?: string;
  coreProfile?: string;
  coreStatus?: string;
}

export interface WorkflowReportInput {
  surface: WorkflowSurface;
  workflow: string;
  status: WorkflowReportStatus;
  title?: string;
  summary: string;
  actions?: WorkflowReportAction[];
  sourceRefs?: string[];
  audit?: WorkflowReportAudit;
  nextAction?: string;
  error?: string;
}

export interface WorkflowReport extends WorkflowReportInput {
  createdAt: string;
}

export function createWorkflowReport(input: WorkflowReportInput, now = new Date()): WorkflowReport {
  return {
    ...input,
    actions: input.actions ?? [],
    sourceRefs: input.sourceRefs ?? [],
    audit: input.audit ?? {},
    createdAt: now.toISOString(),
  };
}

export function isActionRequired(report: WorkflowReport): boolean {
  return Boolean(report.nextAction || report.status === 'failed' || report.status === 'blocked');
}

export function formatWorkflowReport(report: WorkflowReport): string {
  const lines = [
    `[${report.surface}:${report.workflow}] ${report.status}`,
    report.title ? report.title : null,
    report.summary,
  ].filter((line): line is string => Boolean(line));

  if (report.actions?.length) {
    lines.push(`actions=${formatActions(report.actions)}`);
  }
  if (report.sourceRefs?.length) {
    lines.push(`sourceRefs=${report.sourceRefs.join(',')}`);
  }
  const audit = formatAudit(report.audit);
  if (audit) {
    lines.push(`audit=${audit}`);
  }
  if (report.nextAction) {
    lines.push(`nextAction=${report.nextAction}`);
  }
  if (report.error) {
    lines.push(`error=${report.error}`);
  }
  return lines.join('\n');
}

function formatActions(actions: WorkflowReportAction[]): string {
  return actions
    .map((action) => {
      const details = [
        action.type,
        action.status,
        action.id ? `id:${action.id}` : null,
        action.url,
      ].filter(Boolean);
      return `${action.label}(${details.join(' ')})`;
    })
    .join(', ');
}

function formatAudit(audit?: WorkflowReportAudit): string {
  if (!audit) return '';
  return [
    audit.releaseMode ? `releaseMode:${audit.releaseMode}` : null,
    audit.dryRun !== undefined ? `dryRun:${audit.dryRun}` : null,
    audit.guardStatus ? `guard:${audit.guardStatus}` : null,
    audit.policyVersion ? `policy:${audit.policyVersion}` : null,
    audit.coreProfile ? `core:${audit.coreProfile}` : null,
    audit.coreStatus ? `coreStatus:${audit.coreStatus}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}
