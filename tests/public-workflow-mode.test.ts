import { afterEach, describe, expect, it } from 'vitest';
import {
  getCanarySurfaces,
  getPublicWorkflowReleaseMode,
  shouldDryRunPublicWorkflow,
} from '../src/lib/public-workflow-mode.js';

describe('public workflow release mode', () => {
  const originalShadow = process.env.PUBLIC_WORKFLOW_SHADOW_MODE;
  const originalCanary = process.env.PUBLIC_WORKFLOW_CANARY_SURFACES;

  afterEach(() => {
    restoreEnv('PUBLIC_WORKFLOW_SHADOW_MODE', originalShadow);
    restoreEnv('PUBLIC_WORKFLOW_CANARY_SURFACES', originalCanary);
  });

  it('runs live by default', () => {
    delete process.env.PUBLIC_WORKFLOW_SHADOW_MODE;
    delete process.env.PUBLIC_WORKFLOW_CANARY_SURFACES;

    expect(getPublicWorkflowReleaseMode('x')).toBe('live');
    expect(shouldDryRunPublicWorkflow('x')).toBe(false);
  });

  it('forces dry-run for explicit dry-run and shadow mode', () => {
    delete process.env.PUBLIC_WORKFLOW_CANARY_SURFACES;
    expect(getPublicWorkflowReleaseMode('elyth', true)).toBe('dry-run');
    expect(shouldDryRunPublicWorkflow('elyth', true)).toBe(true);

    process.env.PUBLIC_WORKFLOW_SHADOW_MODE = 'true';
    expect(getPublicWorkflowReleaseMode('karakuri')).toBe('shadow');
    expect(shouldDryRunPublicWorkflow('karakuri')).toBe(true);
  });

  it('limits live execution to canary surfaces', () => {
    delete process.env.PUBLIC_WORKFLOW_SHADOW_MODE;
    process.env.PUBLIC_WORKFLOW_CANARY_SURFACES = 'x, elyth,unknown';

    expect(getCanarySurfaces()).toEqual(['x', 'elyth']);
    expect(getPublicWorkflowReleaseMode('x')).toBe('canary-live');
    expect(shouldDryRunPublicWorkflow('x')).toBe(false);
    expect(getPublicWorkflowReleaseMode('karakuri')).toBe('canary-dry-run');
    expect(shouldDryRunPublicWorkflow('karakuri')).toBe(true);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
