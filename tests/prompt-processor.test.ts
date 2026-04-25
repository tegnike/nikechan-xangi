import { describe, expect, it } from 'vitest';
import { getDisplayChunks, getDisplayText } from '../src/prompt-processor.js';

describe('prompt-processor display helpers', () => {
  it('keeps the exact visible body of !discord send output', () => {
    const result = '!discord send <#123> [からくりワールド] ノード19-26に移動';

    expect(getDisplayText(result)).toBe('[からくりワールド] ノード19-26に移動');
    expect(getDisplayChunks(result)).toEqual(['[からくりワールド] ノード19-26に移動']);
  });

  it('drops silent responses from mirrored output', () => {
    expect(getDisplayText('[SILENT]\n内部処理のみ')).toBe('');
    expect(getDisplayChunks('[SILENT]\n内部処理のみ')).toEqual([]);
  });
});
