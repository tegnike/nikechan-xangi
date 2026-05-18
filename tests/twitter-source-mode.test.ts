import { describe, expect, it } from 'vitest';
import { parseSelfTweetSourceMode } from '../src/workflows/twitter.js';

describe('self-tweet source mode command parsing', () => {
  it('parses Discord self-tweet source mode arguments', () => {
    expect(parseSelfTweetSourceMode('/self-tweet news')).toBe('news');
    expect(parseSelfTweetSourceMode('/self-tweet tech')).toBe('tech');
    expect(parseSelfTweetSourceMode('/self-tweet presence')).toBe('presence');
    expect(parseSelfTweetSourceMode('/self-tweet daily_life')).toBe('daily_life');
    expect(parseSelfTweetSourceMode('/self-tweet（memory）')).toBe('memory');
  });

  it('ignores scheduler labels and unknown arguments', () => {
    expect(parseSelfTweetSourceMode('/self-tweet（スケジュール実行）')).toBeUndefined();
    expect(parseSelfTweetSourceMode('/self-tweet unknown')).toBeUndefined();
  });
});
