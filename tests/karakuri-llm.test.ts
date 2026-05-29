import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askKarakuriLLM } from '../src/lib/llm.js';

class MockProcess extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../src/lib/nikechan-core.js', () => ({
  buildNikechanCorePrompt: (_profile: string, prompt: string) => prompt,
}));

describe('karakuri LLM runner', () => {
  const originalAgentModel = process.env.AGENT_MODEL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_MODEL = 'kimi-k2.5';
  });

  afterEach(() => {
    if (originalAgentModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalAgentModel;
  });

  it('falls back to the default model when AGENT_MODEL fails', async () => {
    spawnMock.mockImplementation((_command: string, _args: string[]) => {
      const proc = new MockProcess();
      const callNumber = spawnMock.mock.calls.length;
      setImmediate(() => {
        if (callNumber === 1) {
          proc.emit('close', 1);
          return;
        }

        proc.stdout.emit(
          'data',
          JSON.stringify({
            command: 'wait',
            args: '3',
            message: null,
            thought: 'wait',
            dP: 0,
            dA: 0,
            dD: 0,
          })
        );
        proc.emit('close', 0);
      });
      return proc;
    });

    const decision = await askKarakuriLLM('notification', 'neutral', 'none', 'none');

    expect(decision.command).toBe('wait');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toContain('--model');
    expect(spawnMock.mock.calls[0][1]).toContain('kimi-k2.5');
    expect(spawnMock.mock.calls[1][1]).not.toContain('--model');
  });

  it('includes a useful detail when claude exits without output', async () => {
    spawnMock.mockImplementation(() => {
      const proc = new MockProcess();
      setImmediate(() => proc.emit('close', 1));
      return proc;
    });

    await expect(askKarakuriLLM('notification', 'neutral', 'none', 'none')).rejects.toThrow(
      'no stderr/stdout'
    );
  });
});
