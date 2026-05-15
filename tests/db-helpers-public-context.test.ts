import { describe, expect, it } from 'vitest';
import {
  formatElythPersonContext,
  formatKarakuriPersonContext,
} from '../src/lib/db-helpers.js';

describe('public workflow person context formatting', () => {
  it('does not expose raw memo/context/relationship in ELYTH prompt context', () => {
    const text = formatElythPersonContext([
      {
        userId: 'user-1',
        handle: 'alice',
        displayName: 'Alice',
        nickname: 'アリスさん',
        bio: '公開プロフィール',
        memo: 'private memo',
        context: 'private context',
        relationship: 'friend',
        relationshipPublic: 'known_close',
        recentEpisodes: '[]',
      },
    ]);

    expect(text).toContain('relationship_public=known_close');
    expect(text).toContain('bio=公開プロフィール');
    expect(text).not.toContain('private memo');
    expect(text).not.toContain('private context');
    expect(text).not.toContain('relationship=friend');
  });

  it('does not expose raw memo/context/relationship in karakuri prompt context', () => {
    const text = formatKarakuriPersonContext([
      {
        userId: 'user-1',
        agentId: '1470446478261747854',
        displayName: 'Alice',
        nickname: 'アリスさん',
        memo: 'private memo',
        context: 'private context',
        relationship: 'friend',
        relationshipPublic: 'known_close',
      },
    ]);

    expect(text).toContain('relationship_public=known_close');
    expect(text).not.toContain('private memo');
    expect(text).not.toContain('private context');
    expect(text).not.toContain('relationship=friend');
  });
});
