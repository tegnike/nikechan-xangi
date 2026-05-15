import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildNikechanCorePrompt,
  getNikechanCoreAudit,
  loadNikechanCoreContext,
  type NikechanCoreProfileId,
} from '../src/lib/nikechan-core.js';

describe('nikechan-core snapshot loader', () => {
  let root: string;
  const originalEnabled = process.env.NIKECHAN_CORE_ENABLED;
  const originalSnapshotDir = process.env.NIKECHAN_CORE_SNAPSHOT_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nikechan-core-test-'));
    delete process.env.NIKECHAN_CORE_ENABLED;
    delete process.env.NIKECHAN_CORE_SNAPSHOT_DIR;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.NIKECHAN_CORE_ENABLED = originalEnabled;
    process.env.NIKECHAN_CORE_SNAPSHOT_DIR = originalSnapshotDir;
  });

  it('loads and formats a valid profile snapshot', () => {
    writeProfile('xangi-social', {
      role: 'social',
      surface: 'x',
      prompt: 'social prompt body',
    });

    const context = loadNikechanCoreContext('xangi-social', { rootDir: root });
    expect(context?.profileId).toBe('xangi-social');
    expect(context?.role).toBe('social');
    expect(context?.surface).toBe('x');
    expect(context?.snapshotSha256).toBe('snapshot-sha');

    const prompt = buildNikechanCorePrompt('xangi-social', 'original prompt', { rootDir: root });
    expect(prompt).toContain('## nikechan-core snapshot');
    expect(prompt).toContain('profileId=xangi-social');
    expect(prompt).toContain('social prompt body');
    expect(prompt).toContain('original prompt');

    process.env.NIKECHAN_CORE_SNAPSHOT_DIR = root;
    expect(getNikechanCoreAudit('xangi-social')).toEqual({
      profileId: 'xangi-social',
      role: 'social',
      surface: 'x',
      generatedAt: '2026-05-15T00:00:00.000Z',
      coreVersion: '0.1.0',
      sourceCommit: 'abc1234',
      snapshotSha256: 'snapshot-sha',
      status: 'loaded',
    });
  });

  it('falls back when snapshots are disabled or missing', () => {
    expect(buildNikechanCorePrompt('xangi-social', 'original', { rootDir: root })).toBe(
      'original'
    );

    writeProfile('xangi-social', {
      role: 'social',
      surface: 'x',
      prompt: 'social prompt body',
    });
    process.env.NIKECHAN_CORE_ENABLED = 'false';
    expect(buildNikechanCorePrompt('xangi-social', 'original', { rootDir: root })).toBe(
      'original'
    );
  });

  it('rejects a snapshot with the wrong profile or role', () => {
    writeProfile('xangi-social', {
      profileId: 'xangi-assistant',
      role: 'assistant',
      surface: 'discord',
      prompt: 'wrong prompt',
    });

    expect(() => loadNikechanCoreContext('xangi-social', { rootDir: root })).toThrow(
      /profile mismatch/
    );
  });

  function writeProfile(
    expectedProfile: NikechanCoreProfileId,
    options: {
      profileId?: string;
      role: string;
      surface: string;
      prompt: string;
    }
  ): void {
    const profileDir = join(root, expectedProfile);
    const profileId = options.profileId ?? expectedProfile;
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'snapshot.json'),
      JSON.stringify({
        schemaVersion: 1,
        profileId,
        surface: options.surface,
        profile: {
          role: options.role,
          surface: options.surface,
          system: 'nikechan-xangi',
        },
      })
    );
    writeFileSync(
      join(profileDir, 'version.json'),
      JSON.stringify({
        profileId,
        role: options.role,
        system: 'nikechan-xangi',
        generatedAt: '2026-05-15T00:00:00.000Z',
        coreVersion: '0.1.0',
        source: { commit: 'abc1234' },
        checksums: { snapshotSha256: 'snapshot-sha' },
      })
    );
    writeFileSync(join(profileDir, 'prompt.md'), options.prompt);
  }
});
