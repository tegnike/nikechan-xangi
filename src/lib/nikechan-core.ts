import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type NikechanCoreProfileId =
  | 'xangi-assistant'
  | 'xangi-social'
  | 'xangi-world-elyth'
  | 'xangi-world-karakuri'
  | 'xangi-ops';

interface ProfileExpectation {
  role: string;
  surface: string;
}

const PROFILE_EXPECTATIONS: Record<NikechanCoreProfileId, ProfileExpectation> = {
  'xangi-assistant': { role: 'assistant', surface: 'discord' },
  'xangi-social': { role: 'social', surface: 'x' },
  'xangi-world-elyth': { role: 'world', surface: 'elyth' },
  'xangi-world-karakuri': { role: 'world', surface: 'karakuri' },
  'xangi-ops': { role: 'assistant', surface: 'discord' },
};

export interface NikechanCoreContext {
  profileId: NikechanCoreProfileId;
  role: string;
  surface: string;
  system?: string;
  generatedAt?: string;
  coreVersion?: string;
  sourceCommit?: string;
  snapshotSha256?: string;
  prompt: string;
}

interface SnapshotJson {
  schemaVersion?: number;
  profileId?: string;
  surface?: string;
  profile?: {
    role?: string;
    system?: string;
    surface?: string;
  };
}

interface VersionJson {
  profileId?: string;
  profile?: string;
  role?: string;
  system?: string;
  generatedAt?: string;
  coreVersion?: string;
  source?: {
    commit?: string;
  };
  checksums?: {
    snapshotSha256?: string;
  };
}

export function loadNikechanCoreContext(
  profileId: NikechanCoreProfileId,
  options?: { rootDir?: string; warn?: boolean }
): NikechanCoreContext | null {
  if (process.env.NIKECHAN_CORE_ENABLED === 'false') return null;

  const rootDir = resolveSnapshotRoot(options?.rootDir);
  const profileDir = join(rootDir, profileId);
  if (!existsSync(profileDir)) {
    if (options?.warn) {
      console.warn(`[nikechan-core] snapshot profile not found, falling back: ${profileDir}`);
    }
    return null;
  }

  const snapshot = readJson<SnapshotJson>(join(profileDir, 'snapshot.json'));
  const version = readJson<VersionJson>(join(profileDir, 'version.json'));
  const prompt = readFileSync(join(profileDir, 'prompt.md'), 'utf-8').trim();
  validateContext(profileId, snapshot, version);

  return {
    profileId,
    role: snapshot.profile?.role || version.role || '',
    surface: snapshot.surface || snapshot.profile?.surface || '',
    system: snapshot.profile?.system || version.system,
    generatedAt: version.generatedAt,
    coreVersion: version.coreVersion,
    sourceCommit: version.source?.commit,
    snapshotSha256: version.checksums?.snapshotSha256,
    prompt,
  };
}

export function buildNikechanCorePrompt(
  profileId: NikechanCoreProfileId,
  prompt: string,
  options?: { rootDir?: string; warn?: boolean }
): string {
  const context = loadNikechanCoreContext(profileId, options);
  if (!context) return prompt;
  return `${formatNikechanCoreContext(context)}\n\n${prompt}`;
}

export function formatNikechanCoreContext(context: NikechanCoreContext): string {
  const metadata = [
    `profileId=${context.profileId}`,
    `role=${context.role}`,
    `surface=${context.surface}`,
    context.coreVersion ? `coreVersion=${context.coreVersion}` : null,
    context.generatedAt ? `generatedAt=${context.generatedAt}` : null,
    context.sourceCommit ? `sourceCommit=${context.sourceCommit}` : null,
    context.snapshotSha256 ? `snapshotSha256=${context.snapshotSha256}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return `## nikechan-core snapshot\n${metadata}\n\n${context.prompt}`;
}

export function getNikechanCoreAudit(profileId: NikechanCoreProfileId): Record<string, unknown> {
  const context = loadNikechanCoreContext(profileId);
  if (!context) {
    return {
      profileId,
      status: process.env.NIKECHAN_CORE_ENABLED === 'false' ? 'disabled' : 'fallback',
    };
  }
  return {
    profileId: context.profileId,
    role: context.role,
    surface: context.surface,
    generatedAt: context.generatedAt,
    coreVersion: context.coreVersion,
    sourceCommit: context.sourceCommit,
    snapshotSha256: context.snapshotSha256,
    status: 'loaded',
  };
}

export function resolveSnapshotRoot(explicitRoot?: string): string {
  if (explicitRoot) return resolve(explicitRoot);
  if (process.env.NIKECHAN_CORE_SNAPSHOT_DIR) {
    return resolve(process.env.NIKECHAN_CORE_SNAPSHOT_DIR);
  }

  const workspacePath = process.env.WORKSPACE_PATH;
  if (workspacePath) return resolve(workspacePath, '.nikechan-core');

  const candidates = [
    resolve(process.cwd(), '.nikechan-core'),
    resolve(process.cwd(), '..', '.nikechan-core'),
    resolve(__dirname, '..', '..', '..', '.nikechan-core'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function validateContext(
  expectedProfileId: NikechanCoreProfileId,
  snapshot: SnapshotJson,
  version: VersionJson
): void {
  const expected = PROFILE_EXPECTATIONS[expectedProfileId];
  const snapshotProfileId = snapshot.profileId;
  const versionProfileId = version.profileId || version.profile;
  const role = snapshot.profile?.role || version.role;
  const surface = snapshot.surface || snapshot.profile?.surface;

  if (snapshot.schemaVersion !== 1) {
    throw new Error(
      `[nikechan-core] schemaVersion mismatch for ${expectedProfileId}: ${snapshot.schemaVersion}`
    );
  }
  if (snapshotProfileId !== expectedProfileId || versionProfileId !== expectedProfileId) {
    throw new Error(
      `[nikechan-core] profile mismatch for ${expectedProfileId}: snapshot=${snapshotProfileId} version=${versionProfileId}`
    );
  }
  if (role !== expected.role || surface !== expected.surface) {
    throw new Error(
      `[nikechan-core] role/surface mismatch for ${expectedProfileId}: role=${role} surface=${surface}`
    );
  }
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[nikechan-core] failed to read ${filePath}: ${message}`);
  }
}
