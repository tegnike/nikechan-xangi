import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowReport } from '../src/lib/workflow-report.js';
import {
  formatWorkflowReportForDiscord,
  resolveWorkflowControl,
} from '../src/lib/workflow-manager.js';

describe('workflow manager', () => {
  const originalShadow = process.env.PUBLIC_WORKFLOW_SHADOW_MODE;
  const originalCanary = process.env.PUBLIC_WORKFLOW_CANARY_SURFACES;

  afterEach(() => {
    restoreEnv('PUBLIC_WORKFLOW_SHADOW_MODE', originalShadow);
    restoreEnv('PUBLIC_WORKFLOW_CANARY_SURFACES', originalCanary);
  });

  it('resolves manager execution control from release mode', () => {
    delete process.env.PUBLIC_WORKFLOW_SHADOW_MODE;
    delete process.env.PUBLIC_WORKFLOW_CANARY_SURFACES;
    expect(resolveWorkflowControl('x')).toEqual({
      surface: 'x',
      releaseMode: 'live',
      dryRun: false,
      live: true,
      persist: true,
    });

    process.env.PUBLIC_WORKFLOW_CANARY_SURFACES = 'elyth';
    expect(resolveWorkflowControl('x')).toMatchObject({
      releaseMode: 'canary-dry-run',
      dryRun: true,
      live: false,
      persist: false,
    });
    expect(resolveWorkflowControl('elyth')).toMatchObject({
      releaseMode: 'canary-live',
      dryRun: false,
      live: true,
      persist: true,
    });
  });

  it('formats a manager-facing Discord report', () => {
    const report = createWorkflowReport(
      {
        surface: 'karakuri',
        workflow: 'karakuri-world',
        status: 'dry-run',
        summary: 'move 1-2 was planned',
        actions: [{ type: 'move', label: 'move 1-2', status: 'dry-run' }],
        audit: { releaseMode: 'shadow', dryRun: true },
        nextAction: 'switch canary surface to live when ready',
      },
      new Date('2026-05-15T00:00:00.000Z')
    );

    expect(formatWorkflowReportForDiscord(report, '[からくりワールド] move 1-2')).toBe(
      [
        '管理レポート: からくり / karakuri-world',
        'status=dry-run mode=shadow dryRun=true',
        'move 1-2 was planned',
        'actions=move 1-2:dry-run',
        'next=switch canary surface to live when ready',
        '',
        '[からくりワールド] move 1-2',
      ].join('\n')
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
