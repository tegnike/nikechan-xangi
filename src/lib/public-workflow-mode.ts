export type PublicWorkflowSurface = 'x' | 'elyth' | 'karakuri' | 'discord';

export type PublicWorkflowReleaseMode =
  | 'live'
  | 'dry-run'
  | 'shadow'
  | 'canary-live'
  | 'canary-dry-run';

export function shouldDryRunPublicWorkflow(
  surface: PublicWorkflowSurface,
  explicitDryRun = false
): boolean {
  const mode = getPublicWorkflowReleaseMode(surface, explicitDryRun);
  return mode !== 'live' && mode !== 'canary-live';
}

export function getPublicWorkflowReleaseMode(
  surface: PublicWorkflowSurface,
  explicitDryRun = false
): PublicWorkflowReleaseMode {
  if (explicitDryRun) return 'dry-run';
  if (process.env.PUBLIC_WORKFLOW_SHADOW_MODE === 'true') return 'shadow';

  const canarySurfaces = getCanarySurfaces();
  if (canarySurfaces.length > 0) {
    return canarySurfaces.includes(surface) ? 'canary-live' : 'canary-dry-run';
  }

  return 'live';
}

export function getCanarySurfaces(): PublicWorkflowSurface[] {
  const raw = process.env.PUBLIC_WORKFLOW_CANARY_SURFACES || '';
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(isPublicWorkflowSurface);
}

function isPublicWorkflowSurface(value: string): value is PublicWorkflowSurface {
  return value === 'x' || value === 'elyth' || value === 'karakuri' || value === 'discord';
}
