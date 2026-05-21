import { describe, expect, it } from 'vitest';
import { formatMemoryRecallContext, shouldRecallMemory } from '../src/lib/memory-recall.js';

describe('memory recall', () => {
  it('detects natural recall questions', () => {
    expect(shouldRecallMemory('前に記憶検索の話をしたか覚えてる？')).toBe(true);
    expect(shouldRecallMemory('検索改善の結論どうなったっけ？')).toBe(true);
    expect(shouldRecallMemory('その方針って以前決めたっけ')).toBe(true);
  });

  it('does not trigger for workflow commands', () => {
    expect(shouldRecallMemory('/self-tweet memory')).toBe(false);
    expect(shouldRecallMemory('!schedule list')).toBe(false);
  });

  it('formats decision and chunk evidence', () => {
    const text = formatMemoryRecallContext('検索改善の結論どうなった？', [
      {
        kind: 'decision',
        score: 0.57,
        topic: '記憶検索改善の実装方針',
        decision: 'memory_chunksとdecision_recordsを中心に実装する',
        rationale: '既存テーブルの役割を棚卸ししたため',
      },
      {
        kind: 'chunk',
        score: 0.54,
        title: '[coding-agent] 2026-05-20',
        source_table: 'local_episodes',
        source_record_id: 7732,
        chunk_type: 'episode',
        content: '記憶検索改善について一括実装方針を整理した。',
      },
    ]);

    expect(text).toContain('## 過去記憶検索結果');
    expect(text).toContain('decision: memory_chunksとdecision_recordsを中心に実装する');
    expect(text).toContain('source: local_episodes/7732/episode');
  });
});
