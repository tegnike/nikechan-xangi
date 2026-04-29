import { describe, expect, it } from 'vitest';
import { isExplicitMentionCancel, isExplicitSelfTweetCancel } from '../src/lib/twitter-llm.js';

describe('twitter workflow master cancel detection', () => {
  it('treats self-tweet skip replies as cancel', () => {
    expect(isExplicitSelfTweetCancel('スキップ')).toBe(true);
    expect(isExplicitSelfTweetCancel('全体的に分かりづらいのでスキップ')).toBe(true);
    expect(isExplicitSelfTweetCancel('スキップだって')).toBe(true);
  });

  it('does not treat self-tweet approvals as cancel', () => {
    expect(isExplicitSelfTweetCancel('スキップしないで投稿して')).toBe(false);
    expect(isExplicitSelfTweetCancel('1で良いです')).toBe(false);
  });

  it('treats mention-reaction global skip replies as cancel', () => {
    expect(isExplicitMentionCancel('スキップ')).toBe(true);
    expect(isExplicitMentionCancel('今回は反応しない')).toBe(true);
    expect(isExplicitMentionCancel('全部なしで')).toBe(true);
  });

  it('does not treat mention-reaction approvals as cancel', () => {
    expect(isExplicitMentionCancel('スキップしないでリプして')).toBe(false);
    expect(isExplicitMentionCancel('2で良いです')).toBe(false);
  });
});
