import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn((filePath: string) => {
    return filePath.endsWith('XANGI_COMMANDS.md') || filePath.endsWith('RTK.md');
  }),
  readFileSync: vi.fn((filePath: string) => {
    if (filePath.endsWith('XANGI_COMMANDS.md')) {
      return 'xangi command docs';
    }
    if (filePath.endsWith('RTK.md')) {
      return 'use rtk first';
    }
    throw new Error(`unexpected read: ${filePath}`);
  }),
}));

describe('base-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should append RTK instructions when workdir has RTK.md', async () => {
    const { buildSystemPrompt } = await import('../src/base-runner.js');
    const prompt = buildSystemPrompt('/workspace/project');

    expect(prompt).toContain('XANGI_COMMANDS.md');
    expect(prompt).toContain('xangi command docs');
    expect(prompt).toContain('RTK.md');
    expect(prompt).toContain('use rtk first');
  });

  it('should omit RTK instructions when workdir is not provided', async () => {
    const { buildSystemPrompt } = await import('../src/base-runner.js');
    const prompt = buildSystemPrompt();

    expect(prompt).toContain('XANGI_COMMANDS.md');
    expect(prompt).not.toContain('RTK.md');
    expect(prompt).not.toContain('use rtk first');
  });
});
