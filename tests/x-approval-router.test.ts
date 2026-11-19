import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildXThreadPrompt,
  compactXPending,
  findXPendingForThread,
  isXRuntimeAvailable,
  isXThreadParent,
} from '../src/lib/x-approval-router.js';

describe('x-approval-router', () => {
  let root: string;
  let stateDir: string;

  const writeState = (name: string, value: unknown) =>
    writeFileSync(join(stateDir, name), JSON.stringify(value));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'x-router-'));
    stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('X運用CLIがある環境だけを対象にする', () => {
    expect(isXRuntimeAvailable(root)).toBe(false);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'nikechan-x.mjs'), '');
    expect(isXRuntimeAvailable(root)).toBe(true);
  });

  it('Xチャンネル配下のスレッドだけを対象にする', () => {
    expect(isXThreadParent('1477766217673478234', {})).toBe(true);
    expect(isXThreadParent('999', {})).toBe(false);
    expect(isXThreadParent(null, {})).toBe(false);
    expect(isXThreadParent('999', { NIKECHAN_X_DISCORD_CHANNEL_ID: '999' })).toBe(true);
  });

  it('現在のメンションpendingをスレッドIDで見つける', () => {
    writeState('pending-mention-reaction.json', {
      id: 'p1',
      threadId: 'T1',
      items: [{ id: 'm1', replyAction: 'reply', replyText: 'こんにちは' }],
    });
    const match = findXPendingForThread('T1', root);
    expect(match).toMatchObject({ workflow: 'mention-reaction', archived: false });
    expect(findXPendingForThread('T2', root)).toBeNull();
  });

  it('後続候補で退避されたメンションpendingは、未実行の候補が残っていれば拾う', () => {
    writeState('pending-mention-reaction.json', { id: 'new', threadId: 'T9' });
    writeState('pending-mention-reaction.100.superseded-by-new-mention-context.json', {
      id: 'old',
      threadId: 'T1',
      archiveReason: 'superseded-by-new-mention-context',
      items: [{ id: 'm1', replyAction: 'reply' }],
    });
    writeState('pending-mention-reaction.200.superseded-by-new-mention-context.json', {
      id: 'newer',
      threadId: 'T1',
      archiveReason: 'superseded-by-new-mention-context',
      items: [{ id: 'm1', replyAction: 'reply' }],
    });
    const match = findXPendingForThread('T1', root);
    expect(match?.archived).toBe(true);
    expect(match?.pending.id).toBe('newer');
  });

  it('実行済み・見送り済み・完了済みの退避pendingは拾わない', () => {
    writeState('pending-mention-reaction.100.executed-x.json', { threadId: 'T1' });
    writeState('pending-mention-reaction.101.cancelled-x.json', { threadId: 'T1' });
    writeState('pending-mention-reaction.102.closed.json', {
      threadId: 'T1',
      items: [{ id: 'm1', replyAction: 'reply' }],
      executionResult: { results: [{ itemId: 'm1' }] },
    });
    writeState('pending-mention-reaction.103.superseded-by-new-mention-context.json', {
      threadId: 'T1',
      archiveReason: 'superseded',
      cancelledAt: '2026-01-01T00:00:00Z',
      items: [{ id: 'm1', replyAction: 'reply' }],
    });
    expect(findXPendingForThread('T1', root)).toBeNull();
  });

  it('実行済みの候補を除いて残りだけを渡す', () => {
    const compact = compactXPending({
      id: 'p1',
      threadId: 'T1',
      items: [
        { id: 'm1', replyAction: 'reply', replyText: 'a', secret: 'x' },
        { id: 'm2', replyAction: 'reply', replyText: 'b' },
      ],
      executionResult: { results: [{ itemId: 'm1' }] },
    });
    expect(compact.remainingItemIds).toEqual(['m2']);
    expect(compact.executedItemIds).toEqual(['m1']);
    expect(compact.items).toHaveLength(1);
    expect(JSON.stringify(compact)).not.toContain('secret');
  });

  it('メンション承認スレッドの指示文に、CLIの場所・承認コマンド・マスターの返信を入れる', () => {
    writeState('pending-mention-reaction.json', {
      id: 'p1',
      threadId: 'T1',
      items: [{ id: 'm1', replyAction: 'reply', replyText: 'こんにちは' }],
    });
    const result = buildXThreadPrompt('T1', 'どうぞ', { root });
    expect(result.kind).toBe('mention-reaction');
    expect(result.prompt).toContain(`cd ${root}`);
    expect(result.prompt).toContain('mention-approve --thread-id T1');
    expect(result.prompt).toContain('## マスターの返信\nどうぞ');
    expect(result.prompt).toContain('こんにちは');
    expect(result.prompt).not.toContain('退避済み');
  });

  it('pendingのないスレッドは報告スレッドとして扱い、スレッドの内容を渡す', () => {
    const result = buildXThreadPrompt('T404', 'このRTはなぜ見送った？', {
      root,
      threadContext: '## スレッドの内容\nRT1件、スキップ1件',
    });
    expect(result.kind).toBe('report');
    expect(result.prompt).toContain('承認待ちの候補はありません');
    expect(result.prompt).toContain('RT1件、スキップ1件');
    expect(result.prompt).toContain('このRTはなぜ見送った？');
  });
});
