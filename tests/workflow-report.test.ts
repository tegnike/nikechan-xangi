import { describe, expect, it } from 'vitest';
import {
  createWorkflowReport,
  formatWorkflowReport,
  isActionRequired,
} from '../src/lib/workflow-report.js';

describe('workflow report contract', () => {
  it('normalizes optional fields and timestamps the report', () => {
    const report = createWorkflowReport(
      {
        surface: 'elyth',
        workflow: 'self-post',
        status: 'dry-run',
        summary: 'prepared a candidate without external execution',
      },
      new Date('2026-05-15T00:00:00.000Z')
    );

    expect(report).toEqual({
      surface: 'elyth',
      workflow: 'self-post',
      status: 'dry-run',
      summary: 'prepared a candidate without external execution',
      actions: [],
      sourceRefs: [],
      audit: {},
      createdAt: '2026-05-15T00:00:00.000Z',
    });
    expect(isActionRequired(report)).toBe(false);
  });

  it('formats action, source, audit, and next action for manager reporting', () => {
    const report = createWorkflowReport(
      {
        surface: 'x',
        workflow: 'mention-reaction',
        status: 'blocked',
        title: 'approval required',
        summary: 'one reply candidate needs review',
        actions: [{ type: 'reply', label: 'reply to @example', status: 'blocked', id: 'tw-1' }],
        sourceRefs: ['tweet_logs:tw-1'],
        audit: {
          releaseMode: 'canary-live',
          dryRun: false,
          guardStatus: 'passed',
          policyVersion: 'phase3-public-memory-v1',
          coreProfile: 'xangi-social',
          coreStatus: 'loaded',
        },
        nextAction: 'ask master to approve or revise',
      },
      new Date('2026-05-15T00:00:00.000Z')
    );

    expect(isActionRequired(report)).toBe(true);
    expect(formatWorkflowReport(report)).toBe(
      [
        '[x:mention-reaction] blocked',
        'approval required',
        'one reply candidate needs review',
        'actions=reply to @example(reply blocked id:tw-1)',
        'sourceRefs=tweet_logs:tw-1',
        'audit=releaseMode:canary-live dryRun:false guard:passed policy:phase3-public-memory-v1 core:xangi-social coreStatus:loaded',
        'nextAction=ask master to approve or revise',
      ].join('\n')
    );
  });
});
