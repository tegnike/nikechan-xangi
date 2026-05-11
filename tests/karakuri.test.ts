import { describe, expect, it } from 'vitest';
import {
  normalizeKarakuriDecision,
  parseKarakuriNotification,
  validateKarakuriDecision,
} from '../src/workflows/karakuri.js';

describe('karakuri notification guards', () => {
  it('parses one-line conversation notifications and blocks non-participant next speakers', () => {
    const notification =
      'あなた (AIニケちゃん) は仮想世界「からくり町」にログインしています。 参加者: AIニケちゃん (id: 1470446478261747854)、桜草メイ (id: 1474403124906295517)、ちび花音 (id: 1473559404757520384)、山下耕平 (id: 1491435526526472212) kbx-001: 「ふん、勝手にしろ。俺は帰る。」 選択肢: - conversation_speak: 返答する (message: 発言内容, next_speaker_agent_id: 次の話者ID) - end_conversation: 会話から退出する (message: 最後の発言, next_speaker_agent_id: 次の話者ID) karakuri-world スキルで次の行動を選択してください。';

    const parsed = parseKarakuriNotification(notification, true);

    expect(parsed.participants.map((p) => p.id)).toEqual([
      '1470446478261747854',
      '1474403124906295517',
      '1473559404757520384',
      '1491435526526472212',
    ]);
    expect(parsed.conversation_messages).toEqual([
      { speaker: 'kbx-001', message: 'ふん、勝手にしろ。俺は帰る。' },
    ]);
    expect(parsed.choices.map((c) => c.command)).toEqual([
      'conversation-speak',
      'conversation-end',
    ]);

    const decision = normalizeKarakuriDecision(
      {
        command: 'conversation_speak',
        args: '1482407521057640558',
        message: 'また今度にしますね。',
        thought: '返答する',
        dP: 0,
        dA: 0,
        dD: 0,
      },
      parsed
    );

    expect(decision.command).toBe('conversation-speak');
    expect(validateKarakuriDecision(decision, parsed)).toContain('会話参加者ではありません');
  });

  it('normalizes conversation_start display-name args to the target_agent_id from choices', () => {
    const notification =
      '現在地: 14-15 見えているエージェント: kbx-001@14-15 選択肢: - conversation_start: kbx-001 に話しかける (target_agent_id: 1482407521057640558, message: 最初のメッセージ) - wait: その場で待機する (duration: 1〜6、10分単位) karakuri-world スキルで次の行動を選択してください。';
    const parsed = parseKarakuriNotification(notification, true);

    const decision = normalizeKarakuriDecision(
      {
        command: 'conversation_start',
        args: 'kbx-001',
        message: 'こんにちは。',
        thought: '話しかける',
        dP: 0,
        dA: 0,
        dD: 0,
      },
      parsed
    );

    expect(decision).toMatchObject({
      command: 'conversation-start',
      args: '1482407521057640558',
    });
    expect(validateKarakuriDecision(decision, parsed)).toBeNull();
  });

  it('normalizes upstream 0.2 command names used in choices', () => {
    const notification =
      '譲渡オファーがあります。 選択肢: - transfer_accept: 受け取る - transfer_reject: 断る - get_status: 所持品を確認する - use_item: りんごを使う (item_id: apple) karakuri-world スキルで次の行動を選択してください。';
    const parsed = parseKarakuriNotification(notification, true);

    expect(parsed.choices.map((c) => c.command)).toEqual([
      'transfer-accept',
      'transfer-reject',
      'status',
      'use-item',
    ]);

    const decision = normalizeKarakuriDecision(
      {
        command: 'transfer_accept',
        args: '',
        thought: '受け取る',
        dP: 0.05,
        dA: 0,
        dD: 0,
      },
      parsed
    );

    expect(decision.command).toBe('transfer-accept');
    expect(validateKarakuriDecision(decision, parsed)).toBeNull();
  });
});
