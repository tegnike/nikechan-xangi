import { ChannelType } from 'discord.js';

export const DEFAULT_X_APPROVAL_PARENT_CHANNEL_IDS = ['1477766217673478234'];

export interface DiscordThreadLike {
  channelType: number;
  parentId?: string | null;
  name?: string | null;
}

export function parseChannelIdCsv(value?: string): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isDiscordThreadChannelType(channelType: number): boolean {
  return (
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread
  );
}

export function isXApprovalThreadName(name?: string | null): boolean {
  const normalized = String(name || '').trim();
  return (
    /^X(?:メンション|セルフツイート|ハッシュタグ)/u.test(normalized) ||
    /^X\s*(?:mention|self[-\s]?tweet|hashtag)/iu.test(normalized)
  );
}

export function isXApprovalThread(
  thread: DiscordThreadLike,
  extraParentChannelIds: string[] = []
): boolean {
  if (!isDiscordThreadChannelType(thread.channelType)) return false;
  if (isXApprovalThreadName(thread.name)) return true;

  const parentIds = new Set([
    ...DEFAULT_X_APPROVAL_PARENT_CHANNEL_IDS,
    ...extraParentChannelIds.map((id) => id.trim()).filter(Boolean),
  ]);
  return Boolean(thread.parentId && parentIds.has(thread.parentId));
}
