import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isXApprovalThread, isXApprovalThreadName, parseChannelIdCsv } from '../src/discord-filters.js';

describe('discord filters', () => {
  it('detects X approval thread names', () => {
    expect(isXApprovalThreadName('Xメンション 2026-06-12 cf3ee324')).toBe(true);
    expect(isXApprovalThreadName('Xセルフツイート 2026-06-12')).toBe(true);
    expect(isXApprovalThreadName('Xハッシュタグ 2026-06-12')).toBe(true);
    expect(isXApprovalThreadName('general thread')).toBe(false);
  });

  it('ignores every thread under the default X approval parent channel', () => {
    expect(
      isXApprovalThread({
        channelType: ChannelType.PublicThread,
        parentId: '1477766217673478234',
        name: 'anything',
      })
    ).toBe(true);
  });

  it('does not ignore the parent channel itself', () => {
    expect(
      isXApprovalThread({
        channelType: ChannelType.GuildText,
        parentId: null,
        name: 'nikechan-tweet',
      })
    ).toBe(false);
  });

  it('supports extra parent channel ids', () => {
    expect(
      isXApprovalThread(
        {
          channelType: ChannelType.PublicThread,
          parentId: '123',
          name: 'random',
        },
        parseChannelIdCsv('123, 456')
      )
    ).toBe(true);
  });
});
