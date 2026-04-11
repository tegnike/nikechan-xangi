import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn((filePath: string) => {
    return filePath.endsWith('XANGI_COMMANDS.md');
  }),
  readFileSync: vi.fn((filePath: string) => {
    if (filePath.endsWith('XANGI_COMMANDS.md')) {
      return 'xangi command docs';
    }
    throw new Error(`unexpected read: ${filePath}`);
  }),
}));

describe('base-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should append xangi command instructions', async () => {
    const { buildSystemPrompt } = await import('../src/base-runner.js');
    const prompt = buildSystemPrompt('/workspace/project');

    expect(prompt).toContain('XANGI_COMMANDS.md');
    expect(prompt).toContain('xangi command docs');
  });

  it('should not depend on workdir to build the prompt', async () => {
    const { buildSystemPrompt } = await import('../src/base-runner.js');
    const prompt = buildSystemPrompt();

    expect(prompt).toContain('XANGI_COMMANDS.md');
    expect(prompt).toContain('xangi command docs');
  });
});
