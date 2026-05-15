import { spawn } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { formatEmotion, getEmotion, recordEmotionShift, runDbSh } from '../lib/db-helpers.js';
import { getNikechanCoreAudit } from '../lib/nikechan-core.js';
import { assertPublicEgressAllowed, assertPublicOutputAllowed } from '../lib/public-safety.js';
import { formatWorkflowReportForDiscord, resolveWorkflowControl } from '../lib/workflow-manager.js';
import { createWorkflowReport, type WorkflowReportStatus } from '../lib/workflow-report.js';
import {
  collectSelfTweetSourcesWithAI,
  decideMentionNickname,
  generateHashtagReactionPlan,
  generateMentionReactionCompletionReply,
  generateSelfTweetDrafts,
  generateSelfTweetCompletionReply,
  generateMentionReactionPlan,
  generateMasterReplyInterpretationRecovery,
  interpretMasterMentionReactionReply,
  interpretMasterSelfTweetReply,
  reviewAndReviseMentionReactionItem,
  reviewAndReviseSelfTweetDraft,
  reviseMentionReactionPlanFromMaster,
  reviseSingleSelfTweetDraftFromMaster,
  reviseSelfTweetDraftsFromMaster,
  sanitizeTweetText,
  type HashtagReactionCandidate,
  type HashtagReactionItem,
  type MentionReactionCandidate,
  type MentionReactionItem,
  type MechanicalCheckResult,
  type ReviewedMentionReactionItem,
  type ReviewedSelfTweetDraft,
  type SelfTweetDraft,
  type SelfTweetSourceCollection,
} from '../lib/twitter-llm.js';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();
const DATA_DIR = process.env.DATA_DIR || process.env.XANGI_DATA_DIR || join(WORKDIR, '.xangi');
const STATE_PATH = join(DATA_DIR, 'twitter-workflow-state.json');
const FORBIDDEN_TEXT_PATTERNS = [/!discord/i, /!schedule/i, /<#\d+>/];
const SELF_TWEET_SOURCE_MODES = ['daily_life', 'tech', 'memory', 'random'] as const;
const PRESENTED_TOPIC_COOLDOWN_HOURS = 72;
const PRESENTED_TOPIC_COOLDOWN_LIMIT = 40;

type SelfTweetSourceMode = (typeof SELF_TWEET_SOURCE_MODES)[number];

interface PresentedSelfTweetTopic {
  at: string;
  topic: string;
  titles: string[];
  sourceTypes: string[];
  angle?: string;
  textPreview: string;
}

export interface TwitterSentReport {
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: string;
}

export interface TwitterWorkflowOptions {
  sendReport: (text: string) => Promise<TwitterSentReport | void>;
  bindSession?: (sessionId: string, reason: string) => Promise<void> | void;
  setPhase?: (phase: 'thinking' | 'tool_use' | 'text') => Promise<void> | void;
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  messageCreatedAt?: string;
}

interface PendingSelfTweet {
  kind: 'self-tweet';
  channelId: string;
  createdAt: string;
  revisionCount: number;
  draftGenerationSessionId?: string;
  emotionText: string;
  todayTopics: string;
  recentTweets: string;
  sourceMode: SelfTweetSourceMode;
  personContext: string;
  performanceContext: string;
  runStateContext: string;
  sourceCollection: SelfTweetSourceCollection;
  drafts: ReviewedSelfTweetDraft[];
}

interface PendingMentionReaction {
  kind: 'mention-reaction';
  channelId: string;
  createdAt: string;
  revisionCount: number;
  planGenerationSessionId?: string;
  emotionText: string;
  candidates: MentionReactionCandidate[];
  items: ReviewedMentionReactionItem[];
  checkedTweetLogIds: string[];
}

interface ClosedWorkflowChannel {
  closedAt: string;
  reason: 'executed' | 'cancelled' | 'manual';
}

interface TwitterWorkflowState {
  pendingSelfTweets: Record<string, PendingSelfTweet>;
  pendingMentionReactions: Record<string, PendingMentionReaction>;
  closedSelfTweets: Record<string, ClosedWorkflowChannel>;
  closedMentionReactions: Record<string, ClosedWorkflowChannel>;
}

export function isSelfTweetWorkflowPrompt(prompt: string): boolean {
  return /^\/self-tweet(?:\s|（|\(|$)/.test(prompt.trim());
}

export function isMentionReactionWorkflowPrompt(prompt: string): boolean {
  return /^\/mention-reaction(?:\s|（|\(|$)|^メンションチェック$|^リプライチェック$|^リプ反応$/.test(
    prompt.trim()
  );
}

export function isHashtagReactionWorkflowPrompt(prompt: string): boolean {
  return /^\/hashtag-reaction(?:\s|（|\(|$)|^ハッシュタグチェック$|^ハッシュタグ反応$/.test(
    prompt.trim()
  );
}

export async function runSelfTweetWorkflow(opts: TwitterWorkflowOptions): Promise<void> {
  const channelId = opts.channelId;
  if (!channelId) throw new Error('channelId is required for self-tweet workflow');
  const runKey = opts.messageId
    ? `twitter:self-tweet:${opts.messageId}`
    : `twitter:self-tweet:${Date.now()}`;

  try {
    await opts.setPhase?.('thinking');
    const pending = await createPendingSelfTweet(channelId, 0);
    await bindWorkflowSession(opts, pending.draftGenerationSessionId, 'self-tweet:draft');
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'source_collect',
      raw_content: pending.sourceCollection.summary,
      parsed: {
        source_collection: pending.sourceCollection,
        person_context: pending.personContext,
        performance_context: pending.performanceContext,
        run_state_context: pending.runStateContext,
        source_mode: pending.sourceMode,
      },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'draft',
      raw_content: pending.drafts.map((draft) => draft.text).join('\n---\n'),
      parsed: {
        drafts: pending.drafts.map((draft) => ({
          id: draft.id,
          text: draft.text,
          topic: draft.topic,
          source_candidate_ids: draft.sourceCandidateIds,
          angle: draft.angle,
          self_review_memo: draft.selfReviewMemo,
        })),
      },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'mechanical_check',
      raw_content: 'self-tweet mechanical checks',
      parsed: {
        checks: pending.drafts.map((draft) => ({
          id: draft.id,
          mechanical_check: draft.mechanicalCheck,
        })),
      },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'review',
      raw_content: 'self-tweet AI reviews',
      parsed: {
        reviews: pending.drafts.map((draft) => ({
          id: draft.id,
          review: draft.review,
          revision_notes: draft.revisionNotes,
          review_session_id: draft.reviewSessionId,
        })),
      },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'plan',
      raw_content: pending.drafts.map((draft) => draft.text).join('\n---\n'),
      parsed: {
        source_collection: pending.sourceCollection,
        person_context: pending.personContext,
        performance_context: pending.performanceContext,
        run_state_context: pending.runStateContext,
        source_mode: pending.sourceMode,
        drafts: pending.drafts,
      },
    });
    await savePendingSelfTweet(channelId, pending);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'present',
      raw_content: pending.drafts.map((draft) => draft.text).join('\n---\n'),
      parsed: { draft_ids: pending.drafts.map((draft) => draft.id) },
    });
    await setTwitterRunState('self_tweet_last_plan', {
      at: pending.createdAt,
      source_mode: pending.sourceMode,
      source_types: pending.sourceCollection.candidates.map((candidate) => candidate.sourceType),
      draft_count: pending.drafts.length,
    });
    await appendPresentedSelfTweetTopics(pending);
    await setTwitterRunState('self_tweet_last_source_mode', {
      at: pending.createdAt,
      mode: pending.sourceMode,
    });
    await opts.setPhase?.('text');
    await opts.sendReport(formatApprovalRequest(pending));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] self-tweet workflow failed:', err);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'error',
      raw_content: message,
      parsed: { error: message },
    });
    await opts.setPhase?.('text');
    await opts.sendReport(`⚠️ 自発ツイートワークフロー失敗: ${message.slice(0, 300)}`);
  }
}

export async function handleSelfTweetApproval(
  prompt: string,
  opts: TwitterWorkflowOptions
): Promise<boolean> {
  const channelId = opts.channelId;
  if (!channelId) return false;

  let pending = await getPendingSelfTweet(channelId);
  if (!pending) {
    return false;
  }
  const runKey = `twitter:self-tweet:${channelId}`;

  const normalized = prompt.trim();
  if (!normalized || normalized.startsWith('/')) return false;

  await opts.setPhase?.('thinking');
  const decision = await interpretMasterSelfTweetReply({
    message: normalized,
    pending: {
      sourceCollection: pending.sourceCollection,
      drafts: pending.drafts,
      revisionCount: pending.revisionCount,
    },
    sessionId: pending.draftGenerationSessionId,
  }).catch(async (err) => {
    console.error('[twitter] master reply interpretation failed:', err);
    const message = formatErrorMessage(err);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'error',
      raw_content: normalized,
      parsed: { phase: 'interpret', error: message },
    }).catch((logErr) => console.error('[twitter] interpretation error log failed:', logErr));
    await opts.setPhase?.('text');
    const recoveryReply = await generateMasterReplyInterpretationRecovery({
      workflow: 'self-tweet',
      message: normalized,
      error: message,
    }).catch((recoveryErr) => {
      console.error('[twitter] interpretation recovery reply failed:', recoveryErr);
      return null;
    });
    await opts.sendReport(recoveryReply || `⚠️ エラー: ${message.slice(0, 250)}`);
    return null;
  });
  if (!decision) return true;
  if (decision.sessionId) {
    pending = { ...pending, draftGenerationSessionId: decision.sessionId };
    await bindWorkflowSession(opts, decision.sessionId, 'self-tweet:interpret');
  }
  await addTwitterActivityLog({
    ...activityMeta(opts, runKey),
    workflow: 'self-tweet',
    stage: 'interpret',
    raw_content: normalized,
    parsed: { decision },
  });
  if (decision.feedbackForFuture) {
    await recordTwitterFeedback(decision.feedbackForFuture, {
      channel_id: channelId,
      message: normalized,
      decision,
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'feedback',
      raw_content: decision.feedbackForFuture,
      parsed: { message: normalized, decision },
    });
  }

  if (decision.action === 'post') {
    const draft = selectDraft(pending, decision.selectedDraftId);
    await opts.setPhase?.('tool_use');
    const postResult = await publishSelectedSelfTweet(draft, opts);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'execute',
      raw_content: draft.text,
      parsed: {
        action: 'tweet',
        dry_run: isTwitterWorkflowDryRun(),
        selected_draft_id: draft.id,
        topic: draft.topic,
        result: postResult,
      },
    });
    if (!isTwitterWorkflowDryRun()) {
      await recordTwitterLocalEpisode(
        `self-tweetで案${draftLabel(pending, draft.id)}を投稿。ネタ: ${truncateInline(draft.topic, 80)}。本文「${truncateInline(draft.text, 80)}」`
      );
    }
    await clearPendingSelfTweet(channelId, 'executed');
    await setTwitterRunState('self_tweet_last_execute', {
      at: new Date().toISOString(),
      selected_draft_id: draft.id,
      topic: draft.topic,
      source_candidate_ids: draft.sourceCandidateIds,
    });
    await opts.setPhase?.('text');
    const completion = await generateSelfTweetCompletionReply({
      masterMessage: normalized,
      draft,
      result: postResult,
      dryRun: isTwitterWorkflowDryRun(),
      sessionId: pending.draftGenerationSessionId,
    }).catch((err) => {
      console.error('[twitter] self-tweet completion reply failed:', err);
      return null;
    });
    if (completion?.sessionId) {
      await bindWorkflowSession(opts, completion.sessionId, 'self-tweet:completion');
    }
    const detail =
      completion?.message ||
      `${isTwitterWorkflowDryRun() ? '投稿予定を確認しました。' : '投稿まで完了しました。'}\n${postResult || '（投稿結果のURL取得なし）'}`;
    await opts.sendReport(
      formatWorkflowReportForDiscord(
        buildTwitterManagerReport({
          workflow: 'self-tweet',
          status: isTwitterWorkflowDryRun() ? 'dry-run' : 'success',
          summary: isTwitterWorkflowDryRun() ? 'self tweet planned' : 'self tweet posted',
          runKey,
          actions: [{ type: 'tweet', label: `tweet ${draft.id}` }],
          nextAction: isTwitterWorkflowDryRun()
            ? 'review dry-run result before live posting'
            : undefined,
        }),
        detail
      )
    );
    return true;
  }

  if (decision.action === 'chat') {
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'chat',
      raw_content: normalized,
      parsed: { response: decision.responseMessage, drafts: pending.drafts },
    });
    await savePendingSelfTweet(channelId, pending);
    await opts.setPhase?.('text');
    await opts.sendReport(
      decision.responseMessage ||
        'はい、確認です。承認待ちはそのまま残しているので、投稿する場合はあらためて番号を指定してください。'
    );
    return true;
  }

  if (decision.action === 'cancel') {
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'cancel',
      raw_content: normalized,
      parsed: { drafts: pending.drafts },
    });
    await clearPendingSelfTweet(channelId, 'cancelled');
    await setTwitterRunState('self_tweet_last_cancel', {
      at: new Date().toISOString(),
      message: normalized,
    });
    await recordTwitterLocalEpisode(
      `self-tweetで${pending.drafts.length}案を提示し、マスター判断で見送り。返信「${truncateInline(normalized, 80)}」`
    );
    await opts.setPhase?.('text');
    await opts.sendReport(decision.responseMessage || '了解です。今回は見送ります。');
    return true;
  }

  try {
    await opts.setPhase?.('thinking');
    const revised = await revisePendingFromMaster(
      pending,
      decision.instruction || normalized,
      decision.selectedDraftId
    );
    await bindWorkflowSession(opts, revised.draftGenerationSessionId, 'self-tweet:revise');
    await savePendingSelfTweet(channelId, revised);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'self-tweet',
      stage: 'revise',
      raw_content: revised.drafts.map((draft) => draft.text).join('\n---\n'),
      parsed: {
        instruction: decision.instruction || normalized,
        revision_count: revised.revisionCount,
        drafts: revised.drafts,
      },
    });
    await opts.setPhase?.('text');
    if (decision.selectedDraftId) {
      await opts.sendReport(
        formatTargetedSelfTweetRevisionRequest(
          revised,
          decision.selectedDraftId,
          decision.responseMessage
        )
      );
    } else {
      await opts.sendReport(formatApprovalRequest(revised, true));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] self-tweet revision failed:', err);
    await opts.setPhase?.('text');
    await opts.sendReport(`⚠️ 修正版の生成に失敗しました: ${message.slice(0, 250)}`);
  }

  return true;
}

export async function runMentionReactionWorkflow(opts: TwitterWorkflowOptions): Promise<void> {
  const channelId = opts.channelId;
  if (!channelId) throw new Error('channelId is required for mention-reaction workflow');
  const runKey = opts.messageId
    ? `twitter:mention-reaction:${opts.messageId}`
    : `twitter:mention-reaction:${Date.now()}`;

  try {
    await opts.setPhase?.('thinking');
    const pending = await createPendingMentionReaction(channelId, 0);
    if (!pending) {
      await opts.setPhase?.('text');
      await opts.sendReport('未チェックのリプライ/引用RT/メンションはありませんでした。');
      await addTwitterActivityLog({
        ...activityMeta(opts, runKey),
        workflow: 'mention-reaction',
        stage: 'source_collect',
        raw_content: 'no unchecked mention/reply/quote tweets',
        parsed: { count: 0 },
      });
      return;
    }
    await bindWorkflowSession(opts, pending.planGenerationSessionId, 'mention-reaction:plan');

    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'source_collect',
      raw_content: pending.candidates.map((candidate) => candidate.body).join('\n---\n'),
      parsed: {
        candidates: pending.candidates,
        emotion_text: pending.emotionText,
      },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'draft',
      raw_content: pending.items.map((item) => mentionItemTextForLog(item)).join('\n---\n'),
      parsed: { items: pending.items },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'mechanical_check',
      raw_content: 'mention-reaction mechanical checks',
      parsed: {
        checks: pending.items.map((item) => ({
          id: item.id,
          reply: item.replyMechanicalCheck,
          quote: item.quoteMechanicalCheck,
        })),
      },
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'review',
      raw_content: 'mention-reaction AI reviews',
      parsed: {
        reviews: pending.items.map((item) => ({
          id: item.id,
          review: item.review,
          revision_notes: item.revisionNotes,
          review_session_id: item.reviewSessionId,
        })),
      },
    });
    await markTweetLogsChecked(pending.checkedTweetLogIds);
    await savePendingMentionReaction(channelId, pending);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'present',
      raw_content: pending.items.map((item) => mentionItemTextForLog(item)).join('\n---\n'),
      parsed: { item_ids: pending.items.map((item) => item.id) },
    });
    await opts.setPhase?.('text');
    await opts.sendReport(formatMentionApprovalRequest(pending));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] mention-reaction workflow failed:', err);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'error',
      raw_content: message,
      parsed: { error: message },
    });
    await opts.setPhase?.('text');
    await opts.sendReport(`⚠️ メンション反応ワークフロー失敗: ${message.slice(0, 300)}`);
  }
}

export async function handleMentionReactionApproval(
  prompt: string,
  opts: TwitterWorkflowOptions
): Promise<boolean> {
  const channelId = opts.channelId;
  if (!channelId) return false;

  let pending = await getPendingMentionReaction(channelId);
  if (!pending) {
    return false;
  }
  const runKey = `twitter:mention-reaction:${channelId}`;

  const normalized = prompt.trim();
  if (!normalized || normalized.startsWith('/')) return false;

  await opts.setPhase?.('thinking');
  const decision = await interpretMasterMentionReactionReply({
    message: normalized,
    pending: {
      items: pending.items,
      revisionCount: pending.revisionCount,
    },
    sessionId: pending.planGenerationSessionId,
  }).catch(async (err) => {
    console.error('[twitter] mention reply interpretation failed:', err);
    const message = formatErrorMessage(err);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'error',
      raw_content: normalized,
      parsed: { phase: 'interpret', error: message },
    }).catch((logErr) => console.error('[twitter] interpretation error log failed:', logErr));
    await opts.setPhase?.('text');
    const recoveryReply = await generateMasterReplyInterpretationRecovery({
      workflow: 'mention-reaction',
      message: normalized,
      error: message,
    }).catch((recoveryErr) => {
      console.error('[twitter] interpretation recovery reply failed:', recoveryErr);
      return null;
    });
    await opts.sendReport(recoveryReply || `⚠️ エラー: ${message.slice(0, 250)}`);
    return null;
  });
  if (!decision) return true;
  if (decision.sessionId) {
    pending = { ...pending, planGenerationSessionId: decision.sessionId };
    await bindWorkflowSession(opts, decision.sessionId, 'mention-reaction:interpret');
  }
  await addTwitterActivityLog({
    ...activityMeta(opts, runKey),
    workflow: 'mention-reaction',
    stage: 'interpret',
    raw_content: normalized,
    parsed: { decision },
  });
  if (decision.feedbackForFuture) {
    await recordTwitterFeedback('mention_reaction_latest_feedback', decision.feedbackForFuture, {
      channel_id: channelId,
      message: normalized,
      decision,
    });
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'feedback',
      raw_content: decision.feedbackForFuture,
      parsed: { message: normalized, decision },
    });
  }

  if (decision.action === 'execute') {
    const items = selectMentionItems(pending, decision.selectedItemIds);
    await opts.setPhase?.('tool_use');
    const result = await executeMentionReactions(items, pending);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'execute',
      raw_content: result.summary,
      parsed: result,
    });
    await clearPendingMentionReaction(channelId, 'executed');
    await setTwitterRunState('mention_reaction_last_execute', {
      at: new Date().toISOString(),
      summary: result.summary,
      item_ids: items.map((item) => item.id),
    });
    await opts.setPhase?.('text');
    const completion = await generateMentionReactionCompletionReply({
      masterMessage: normalized,
      items,
      summary: result.summary,
      results: result.results,
      dryRun: isTwitterWorkflowDryRun(),
      sessionId: pending.planGenerationSessionId,
    }).catch((err) => {
      console.error('[twitter] mention completion reply failed:', err);
      return null;
    });
    if (completion?.sessionId) {
      await bindWorkflowSession(opts, completion.sessionId, 'mention-reaction:completion');
    }
    const urls = result.results
      .flatMap((entry) => [entry.reply_url, entry.quote_url].filter(Boolean))
      .join('\n');
    const detail =
      completion?.message || `処理しました。\n${result.summary}${urls ? `\n\n${urls}` : ''}`;
    await opts.sendReport(
      formatWorkflowReportForDiscord(
        buildTwitterManagerReport({
          workflow: 'mention-reaction',
          status: mentionResultStatus(result.results),
          summary: result.summary,
          runKey,
          actions: result.results.map((entry) => ({
            type: entry.action,
            label: `${entry.item_id} ${entry.action}`,
            status: entry.error ? 'failed' : isTwitterWorkflowDryRun() ? 'dry-run' : 'success',
          })),
          nextAction: result.results.some((entry) => entry.error)
            ? 'inspect failed mention action(s)'
            : undefined,
          error: result.results
            .map((entry) => entry.error)
            .filter(Boolean)
            .join(' / '),
        }),
        detail
      )
    );
    return true;
  }

  if (decision.action === 'chat') {
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'chat',
      raw_content: normalized,
      parsed: { response: decision.responseMessage, items: pending.items },
    });
    await savePendingMentionReaction(channelId, pending);
    await opts.setPhase?.('text');
    await opts.sendReport(
      decision.responseMessage ||
        'はい、確認です。承認待ちはそのまま残しているので、実行する場合はあらためて指示してください。'
    );
    return true;
  }

  if (decision.action === 'cancel') {
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'cancel',
      raw_content: normalized,
      parsed: { items: pending.items },
    });
    await clearPendingMentionReaction(channelId, 'cancelled');
    await setTwitterRunState('mention_reaction_last_cancel', {
      at: new Date().toISOString(),
      message: normalized,
    });
    await opts.setPhase?.('text');
    await opts.sendReport(decision.responseMessage || '了解です。今回は見送ります。');
    return true;
  }

  try {
    await opts.setPhase?.('thinking');
    const revised = await revisePendingMentionFromMaster(
      pending,
      decision.instruction || normalized
    );
    await bindWorkflowSession(opts, revised.planGenerationSessionId, 'mention-reaction:revise');
    await savePendingMentionReaction(channelId, revised);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'revise',
      raw_content: revised.items.map((item) => mentionItemTextForLog(item)).join('\n---\n'),
      parsed: {
        instruction: decision.instruction || normalized,
        revision_count: revised.revisionCount,
        items: revised.items,
      },
    });
    await opts.setPhase?.('text');
    await opts.sendReport(formatMentionApprovalRequest(revised, true));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] mention-reaction revision failed:', err);
    await opts.setPhase?.('text');
    await opts.sendReport(`⚠️ 修正版の生成に失敗しました: ${message.slice(0, 250)}`);
  }

  return true;
}

export async function runHashtagReactionWorkflow(opts: TwitterWorkflowOptions): Promise<void> {
  const channelId = opts.channelId;
  if (!channelId) throw new Error('channelId is required for hashtag-reaction workflow');
  const runKey = opts.messageId
    ? `twitter:hashtag-reaction:${opts.messageId}`
    : `twitter:hashtag-reaction:${Date.now()}`;

  try {
    await opts.setPhase?.('thinking');
    const [emotion, candidates] = await Promise.all([
      getEmotion(),
      collectHashtagReactionCandidates(),
    ]);
    if (!candidates.length) {
      await opts.setPhase?.('text');
      await opts.sendReport('未チェックのハッシュタグツイートはありませんでした。');
      await addTwitterActivityLog({
        ...activityMeta(opts, runKey),
        workflow: 'hashtag-reaction',
        stage: 'source_collect',
        raw_content: 'no unchecked hashtag tweets',
        parsed: { count: 0 },
      });
      return;
    }

    const emotionText = formatEmotion(emotion);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'hashtag-reaction',
      stage: 'source_collect',
      raw_content: candidates.map((candidate) => candidate.body).join('\n---\n'),
      parsed: { candidates, emotion_text: emotionText },
    });

    const planned = await generateHashtagReactionPlan({ emotionText, candidates });
    const items = planned.items;
    await bindWorkflowSession(opts, planned.sessionId, 'hashtag-reaction:plan');
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'hashtag-reaction',
      stage: 'plan',
      raw_content: items.map((item) => `${item.action}: ${item.body}`).join('\n---\n'),
      parsed: { items },
    });

    await markTweetLogsChecked(candidates.map((candidate) => candidate.tweetLogId));
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'hashtag-reaction',
      stage: 'mechanical_check',
      raw_content: 'hashtag checked_by_nikechan updated',
      parsed: { checked_tweet_log_ids: candidates.map((candidate) => candidate.tweetLogId) },
    });

    await opts.setPhase?.('tool_use');
    const result = await executeHashtagReactions(items, candidates, opts);
    await opts.setPhase?.('text');
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'hashtag-reaction',
      stage: 'execute',
      raw_content: result.summary,
      parsed: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] hashtag-reaction workflow failed:', err);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'hashtag-reaction',
      stage: 'error',
      raw_content: message,
      parsed: { error: message },
    });
    await opts.setPhase?.('text');
    await opts.sendReport(`⚠️ ハッシュタグ反応ワークフロー失敗: ${message.slice(0, 300)}`);
  }
}

async function createPendingMentionReaction(
  channelId: string,
  revisionCount: number
): Promise<PendingMentionReaction | null> {
  const [emotion, candidates] = await Promise.all([
    getEmotion(),
    collectMentionReactionCandidates(),
  ]);
  if (!candidates.length) return null;
  const emotionText = formatEmotion(emotion);
  const planned = await generateMentionReactionPlan({
    emotionText,
    candidates,
  });
  const reviewedItems = await prepareMentionItems(planned.items, candidates);
  return {
    kind: 'mention-reaction',
    channelId,
    createdAt: new Date().toISOString(),
    revisionCount,
    planGenerationSessionId: planned.sessionId,
    emotionText,
    candidates,
    items: reviewedItems,
    checkedTweetLogIds: candidates.map((candidate) => candidate.tweetLogId),
  };
}

async function collectMentionReactionCandidates(): Promise<MentionReactionCandidate[]> {
  const [rawReplies, rawMentions] = await Promise.all([
    safeDb(['tweet-log-unchecked-replies']),
    safeDb(['tweet-log-unchecked-mentions']),
  ]);
  const logs = [
    ...parseJsonArray<TweetLogRecord>(rawReplies),
    ...parseJsonArray<TweetLogRecord>(rawMentions),
  ];
  const deduped = [...new Map(logs.map((log) => [log.post_id, log])).values()]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(0, 10);

  const candidates = await Promise.all(
    deduped.map(async (log, index) => {
      const authorContext = await collectTweetAuthorContext(log);
      const originalTweet = log.original_tweet_id
        ? parseJsonArray<OriginalTweetRecord>(await safeDb(['tweet-get', log.original_tweet_id]))[0]
        : undefined;
      return {
        id: `m${index + 1}`,
        tweetLogId: log.id,
        postId: log.post_id,
        authorUserId: authorContext.userId || undefined,
        username: log.username || '',
        displayName: log.name || log.username || '',
        authorName: authorContext.authorName || undefined,
        nickname: authorContext.nickname || undefined,
        type: log.type || 'mention',
        body: log.body || '',
        createdAt: log.created_at,
        originalTweetId: log.original_tweet_id || undefined,
        originalTweetText: originalTweet?.content,
        originalTweetUrl: originalTweet?.url || log.original_tweet_url || undefined,
        personContext: authorContext.text,
      };
    })
  );
  return candidates.filter((candidate) => candidate.tweetLogId && candidate.postId);
}

async function collectHashtagReactionCandidates(): Promise<HashtagReactionCandidate[]> {
  const raw = await safeDb(['tweet-log-unchecked-hashtag']);
  const logs = parseJsonArray<HashtagTweetLogRecord>(raw)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(0, 10);

  const candidates = await Promise.all(
    logs.map(async (log, index) => {
      const authorContext = await collectTweetAuthorContext(log);
      const mediaContext = await collectHashtagMediaContext(log.post_id);
      return {
        id: `h${index + 1}`,
        tweetLogId: log.id,
        postId: log.post_id,
        authorUserId: authorContext.userId || undefined,
        username: log.username || '',
        displayName: log.name || log.username || '',
        authorName: authorContext.authorName || undefined,
        nickname: authorContext.nickname || undefined,
        body: log.body || '',
        createdAt: log.created_at,
        hashtags: Array.isArray(log.hashtags) ? log.hashtags.map(String) : [],
        personContext: authorContext.text,
        mediaContext,
      };
    })
  );
  return candidates.filter((candidate) => candidate.tweetLogId && candidate.postId);
}

interface TweetLogRecord {
  id: string;
  post_id: string;
  user_id?: string;
  username?: string;
  name?: string;
  body?: string;
  type?: string;
  original_tweet_id?: string | null;
  original_tweet_url?: string | null;
  created_at?: string;
}

interface HashtagTweetLogRecord extends TweetLogRecord {
  hashtags?: string[];
}

interface OriginalTweetRecord {
  tweet_id: string;
  content?: string;
  url?: string;
  created_at?: string;
}

interface TweetAuthorContext {
  userId: string;
  authorName: string;
  nickname: string;
  text: string;
}

interface UserProfileRecord {
  id?: string;
  name?: string | null;
  nickname?: string | null;
  bio?: string | null;
  relationship?: string | null;
  relationship_public?: string | null;
}

async function collectTweetAuthorContext(log: TweetLogRecord): Promise<TweetAuthorContext> {
  const username = log.username || log.user_id || 'unknown';
  const ensured = parseJsonObject<Record<string, unknown>>(
    await safeDb(['user-ensure', 'twitter', log.user_id || '', username, log.name || username])
  );
  const userId = typeof ensured?.id === 'string' ? ensured.id : '';
  const [profileRaw, episodes, thirdParties] = await Promise.all([
    userId
      ? safeDb(['user-get-public', 'twitter', username, 'x'])
      : Promise.resolve(JSON.stringify(ensured ?? {})),
    userId ? safeDb(['ce-list-public', userId, 'x', '5']) : Promise.resolve('[]'),
    collectThirdPartyContext(log.body || ''),
  ]);
  const profile = parseUserProfile(profileRaw);
  let nickname = profile.nickname?.trim() || getString(ensured?.nickname);
  const authorName = profile.name?.trim() || log.name || username;

  if (userId && !nickname) {
    nickname = await decideMentionNickname({
      name: authorName,
      displayName: log.name || authorName,
      username,
      bio: profile.bio,
      relationship: profile.relationship_public,
      episodes,
    }).catch((err) => {
      console.error(`[twitter] mention nickname generation failed for @${username}:`, err);
      return '';
    });
    if (nickname) {
      await runDbSh(['user-update', userId, 'nickname', nickname]).catch((err) =>
        console.error(`[twitter] mention nickname save failed for @${username}:`, err)
      );
      profile.nickname = nickname;
    }
  }

  const profileForPrompt = {
    ...profile,
    id: profile.id || userId || undefined,
    name: authorName,
    nickname: nickname || null,
    required_call_name: nickname || '未設定（名前呼び禁止）',
  };
  const text = [
    `## 投稿者 @${username}`,
    `必ず使う呼称: ${nickname || '未設定（名前呼び禁止）'}`,
    truncateBlock(JSON.stringify(profileForPrompt, null, 2), 1600),
    '',
    '## 直近エピソード',
    truncateBlock(episodes, 1200),
    thirdParties ? `\n## 本文に出る第三者候補\n${thirdParties}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    text,
    userId,
    authorName,
    nickname,
  };
}

async function collectThirdPartyContext(text: string): Promise<string> {
  const terms = extractMentionPersonTerms(text).slice(0, 4);
  if (!terms.length) return '';
  const results = await Promise.all(
    terms.map(
      async (term) =>
        `### ${term}\n${truncateBlock(await safeDb(['user-search-public', term, 'x']), 700)}`
    )
  );
  return results.join('\n\n');
}

async function collectHashtagMediaContext(postId: string): Promise<string> {
  if (!postId) return '（post_idなし）';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://api.fxtwitter.com/status/${postId}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return `（fxtwitter取得失敗: ${res.status}）`;
    const parsed = (await res.json()) as Record<string, unknown>;
    const tweet = parsed.tweet && typeof parsed.tweet === 'object' ? parsed.tweet : parsed;
    const media = (tweet as Record<string, unknown>).media;
    if (!media) return '（メディアなし）';
    return truncateBlock(JSON.stringify(media, null, 2), 2000);
  } catch (err) {
    return `（メディア取得失敗: ${err instanceof Error ? err.message : String(err)}）`;
  }
}

function extractMentionPersonTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9_]{2,20})/g)) terms.add(match[1]);
  for (const match of text.matchAll(
    /([一-龯ぁ-んァ-ヶA-Za-z0-9_]{2,16}(?:ちゃん|さん|氏|くん|たん|先生))/g
  )) {
    terms.add(match[1]);
  }
  return [...terms].filter((term) => !['ai_nikechan', 'AIニケちゃん', 'ニケちゃん'].includes(term));
}

async function prepareMentionItems(
  items: MentionReactionItem[],
  candidates: MentionReactionCandidate[],
  options: {
    sessionIdsByItemId?: Record<string, string | undefined>;
    skipAiReview?: boolean;
  } = {}
): Promise<ReviewedMentionReactionItem[]> {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateByLogId = new Map(
    candidates.map((candidate) => [candidate.tweetLogId, candidate])
  );
  const checked = await Promise.all(
    items.map(async (item) => ({
      item,
      candidate: candidateByLogId.get(item.tweetLogId) ?? candidateById.get(item.id),
      replyMechanicalCheck:
        item.replyAction === 'reply' && item.replyText
          ? await runMechanicalChecks(item.replyText)
          : undefined,
      quoteMechanicalCheck:
        item.quoteAction === 'quote' && item.quoteText
          ? await runMechanicalChecks(item.quoteText)
          : undefined,
    }))
  );
  if (options.skipAiReview) {
    const guarded = checked
      .filter((entry): entry is typeof entry & { candidate: MentionReactionCandidate } =>
        Boolean(entry.candidate)
      )
      .map((entry) =>
        enforceMentionNicknameGuardrail(
          {
            ...entry.item,
            replyMechanicalCheck: entry.replyMechanicalCheck,
            quoteMechanicalCheck: entry.quoteMechanicalCheck,
            review: okTweetReview(),
            revisionNotes: 'マスター修正後のためAI再レビューなし',
          },
          entry.candidate
        )
      );
    return Promise.all(
      guarded.map(async (item) => ({
        ...item,
        replyMechanicalCheck:
          item.replyAction === 'reply' && item.replyText
            ? await runMechanicalChecks(item.replyText)
            : undefined,
        quoteMechanicalCheck:
          item.quoteAction === 'quote' && item.quoteText
            ? await runMechanicalChecks(item.quoteText)
            : undefined,
      }))
    );
  }
  const reviewed = await Promise.all(
    checked
      .filter((entry): entry is typeof entry & { candidate: MentionReactionCandidate } =>
        Boolean(entry.candidate)
      )
      .map((entry) =>
        reviewAndReviseMentionReactionItem({
          item: entry.item,
          candidate: entry.candidate,
          replyMechanicalCheck: entry.replyMechanicalCheck,
          quoteMechanicalCheck: entry.quoteMechanicalCheck,
          sessionId: options.sessionIdsByItemId?.[entry.item.id],
        })
      )
  );
  const guarded = reviewed.map((item) =>
    enforceMentionNicknameGuardrail(
      item,
      candidateByLogId.get(item.tweetLogId) ?? candidateById.get(item.id)
    )
  );
  const finalChecked = await Promise.all(
    guarded.map(async (item) => ({
      ...item,
      replyMechanicalCheck:
        item.replyAction === 'reply' && item.replyText
          ? await runMechanicalChecks(item.replyText)
          : undefined,
      quoteMechanicalCheck:
        item.quoteAction === 'quote' && item.quoteText
          ? await runMechanicalChecks(item.quoteText)
          : undefined,
    }))
  );
  return finalChecked;
}

function enforceMentionNicknameGuardrail<T extends MentionReactionItem>(
  item: T,
  candidate?: MentionReactionCandidate
): T {
  if (!candidate) return item;
  const replyText = guardMentionText(item.replyText, candidate);
  const quoteText = guardMentionText(item.quoteText, candidate);
  if (replyText === item.replyText && quoteText === item.quoteText) return item;
  return {
    ...item,
    replyText,
    quoteText,
  };
}

function guardMentionText(
  text: string | undefined,
  candidate: MentionReactionCandidate
): string | undefined {
  if (!text) return text;
  const nickname = candidate.nickname?.trim();
  const aliases = [
    candidate.username ? `@${candidate.username.replace(/^@/, '')}` : '',
    candidate.displayName,
    candidate.authorName,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => value !== nickname)
    .filter((value) => value.startsWith('@') || value.length >= 2)
    .sort((a, b) => b.length - a.length);

  let guarded = text;
  for (const alias of [...new Set(aliases)]) {
    guarded = guarded.replace(new RegExp(escapeRegExp(alias), 'g'), nickname || 'そちら');
  }
  if (nickname) {
    guarded = guarded.replace(
      new RegExp(`${escapeRegExp(nickname)}(さん|ちゃん|くん|様|さま)`, 'g'),
      nickname
    );
  }
  return sanitizeTweetText(guarded.replace(/\s{2,}/g, ' '));
}

function okTweetReview() {
  return {
    accuracy: 'OK' as const,
    accuracy_issues: [],
    character_voice: 'OK' as const,
    character_voice_issues: [],
    comprehension: 'OK' as const,
    comprehension_issues: [],
    overall: 'OK' as const,
    suggestion: null,
  };
}

async function revisePendingMentionFromMaster(
  pending: PendingMentionReaction,
  instruction: string
): Promise<PendingMentionReaction> {
  const revised = await reviseMentionReactionPlanFromMaster({
    instruction,
    sessionId: pending.planGenerationSessionId,
    pending: {
      items: pending.items,
      candidates: pending.candidates,
    },
  });
  const reviewedItems = await prepareMentionItems(revised.items, pending.candidates, {
    skipAiReview: true,
  });
  return {
    ...pending,
    createdAt: new Date().toISOString(),
    revisionCount: pending.revisionCount + 1,
    planGenerationSessionId: revised.sessionId ?? pending.planGenerationSessionId,
    items: reviewedItems,
  };
}

function selectMentionItems(
  pending: PendingMentionReaction,
  selectedItemIds?: string[]
): ReviewedMentionReactionItem[] {
  if (!selectedItemIds?.length) return pending.items;
  const selected = selectedItemIds
    .map((id) => {
      const normalized = id.startsWith('m') ? id : `m${id.replace(/\D/g, '')}`;
      return pending.items.find((item) => item.id === normalized);
    })
    .filter((item): item is ReviewedMentionReactionItem => Boolean(item));
  return selected.length ? selected : pending.items;
}

async function executeMentionReactions(
  items: ReviewedMentionReactionItem[],
  pending: PendingMentionReaction
): Promise<{
  summary: string;
  results: Array<{
    item_id: string;
    action: string;
    reply_url?: string;
    quote_url?: string;
    error?: string;
  }>;
}> {
  const results: Array<{
    item_id: string;
    action: string;
    reply_url?: string;
    quote_url?: string;
    error?: string;
  }> = [];
  let replyCount = 0;
  let quoteCount = 0;
  let skipCount = 0;

  for (const item of items) {
    const actions: string[] = [];
    const result: {
      item_id: string;
      action: string;
      reply_url?: string;
      quote_url?: string;
      error?: string;
    } = {
      item_id: item.id,
      action: 'skip',
    };
    try {
      if (item.replyAction === 'reply' && item.replyText) {
        if (isTwitterWorkflowDryRun()) {
          result.reply_url = `dry-run reply: ${item.replyText}`;
        } else {
          await assertPublicEgressAllowed(
            'x',
            item.replyMechanicalCheck?.checkedText || item.replyText
          );
          result.reply_url = await runTwitterPost([
            'reply',
            item.replyMechanicalCheck?.checkedText || item.replyText,
            item.postId,
            'mention-reaction',
          ]);
        }
        actions.push('reply');
        replyCount += 1;
      }
      if (item.quoteAction === 'quote' && item.quoteText) {
        if (isTwitterWorkflowDryRun()) {
          result.quote_url = `dry-run quote: ${item.quoteText}`;
        } else {
          await assertPublicEgressAllowed(
            'x',
            item.quoteMechanicalCheck?.checkedText || item.quoteText
          );
          result.quote_url = await runTwitterPost([
            'quote',
            item.quoteMechanicalCheck?.checkedText || item.quoteText,
            item.postId,
            'mention-reaction',
          ]);
        }
        actions.push('quote');
        quoteCount += 1;
      }
      if (!actions.length) {
        actions.push('skip');
        skipCount += 1;
      }
      result.action = actions.join('+');
      if (shouldPersistTwitterWorkflow()) {
        await runDbSh(['tweet-log-action', item.tweetLogId, result.action]).catch((e) =>
          console.error('[twitter] tweet-log-action failed:', e)
        );
        await recordMentionContactEpisode(item, pending, result).catch((e) =>
          console.error('[twitter] mention contact episode failed:', e)
        );
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error('[twitter] mention publish failed:', err);
    }
    results.push(result);
  }

  if (replyCount + quoteCount > 0 && shouldPersistTwitterWorkflow()) {
    await recordEmotionShift(
      0.05,
      0.03,
      0,
      'mention-reaction',
      `${items.length}件チェックし、返信${replyCount}件・引用${quoteCount}件を実行`,
      '交流できた'
    ).catch((e) => console.error('[twitter] emotion-shift failed:', e));
  }

  const summary = `${items.length}件チェック: 返信${replyCount}件、引用RT${quoteCount}件、スキップ${skipCount}件`;
  await recordTwitterLocalEpisode(`mention-reactionを実行。${summary}`);
  return { summary, results };
}

async function recordMentionContactEpisode(
  item: ReviewedMentionReactionItem,
  pending: PendingMentionReaction,
  result: { action: string; reply_url?: string; quote_url?: string }
): Promise<void> {
  if (result.action === 'skip') return;
  const candidate = pending.candidates.find((entry) => entry.tweetLogId === item.tweetLogId);
  if (!candidate) return;
  const ensured = parseJsonObject<{ id?: string }>(
    await safeDb(['user-ensure', 'twitter', '', item.username, item.displayName])
  );
  if (!ensured?.id) return;
  const content = `@${item.username} の「${item.body.slice(0, 60)}」に ${result.action} で反応`;
  await runDbSh([
    'ce-add-ref',
    ensured.id,
    content,
    'twitter',
    result.action.includes('reply') ? 'reply' : 'quote',
    'tweet_logs',
    item.tweetLogId,
  ]);
  await runDbSh(['user-touch', ensured.id]);
}

function mentionResultStatus(
  results: Array<{ action: string; reply_url?: string; quote_url?: string; error?: string }>
): WorkflowReportStatus {
  if (isTwitterWorkflowDryRun()) return 'dry-run';
  if (results.some((entry) => entry.error)) return 'partial';
  if (results.every((entry) => entry.action === 'skip')) return 'skipped';
  return 'success';
}

async function executeHashtagReactions(
  items: HashtagReactionItem[],
  candidates: HashtagReactionCandidate[],
  opts: TwitterWorkflowOptions
): Promise<{
  summary: string;
  results: Array<{ item_id: string; action: string; url?: string; error?: string; reason: string }>;
}> {
  const candidateByLogId = new Map(
    candidates.map((candidate) => [candidate.tweetLogId, candidate])
  );
  const results: Array<{
    item_id: string;
    action: string;
    url?: string;
    error?: string;
    reason: string;
  }> = [];
  let retweetCount = 0;
  let skipCount = 0;

  for (const item of items) {
    const candidate = candidateByLogId.get(item.tweetLogId);
    const result = {
      item_id: item.id,
      action: item.action,
      reason: item.reason,
      url: undefined as string | undefined,
      error: undefined as string | undefined,
    };
    try {
      if (item.action === 'retweet') {
        if (isTwitterWorkflowDryRun()) {
          result.url = `dry-run retweet: ${item.postId}`;
        } else {
          await assertPublicOutputAllowed('x');
          result.url = await runTwitterPost(['retweet', item.postId, 'hashtag-reaction']);
        }
        retweetCount += 1;
        if (shouldPersistTwitterWorkflow()) {
          await runDbSh(['tweet-log-action', item.tweetLogId, 'retweet']).catch((e) =>
            console.error('[twitter] hashtag tweet-log-action failed:', e)
          );
        }
        if (candidate?.authorUserId && shouldPersistTwitterWorkflow()) {
          await runDbSh([
            'ce-add-ref',
            candidate.authorUserId,
            `@${item.username} の #AIニケちゃん ツイート「${item.body.slice(0, 60)}」をRT`,
            'twitter',
            'rt',
            'tweet_logs',
            item.tweetLogId,
          ]).catch((e) => console.error('[twitter] hashtag ce-add-ref failed:', e));
          await runDbSh(['user-touch', candidate.authorUserId]).catch((e) =>
            console.error('[twitter] hashtag user-touch failed:', e)
          );
        }
      } else {
        skipCount += 1;
        if (shouldPersistTwitterWorkflow()) {
          await runDbSh(['tweet-log-action', item.tweetLogId, 'skip']).catch((e) =>
            console.error('[twitter] hashtag skip action failed:', e)
          );
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error('[twitter] hashtag retweet failed:', err);
    }
    results.push(result);
  }

  if (retweetCount > 0 && shouldPersistTwitterWorkflow()) {
    await recordEmotionShift(
      0.1,
      0.05,
      0,
      'hashtag-reaction',
      `#AIニケちゃん ツイート${retweetCount}件をRT`,
      '自分のために投稿してくれた嬉しさ'
    ).catch((e) => console.error('[twitter] hashtag emotion-shift failed:', e));
  }

  const summary = `${items.length}件チェック: RT${retweetCount}件、スキップ${skipCount}件`;
  if (items.length > 0) {
    await recordTwitterLocalEpisode(`hashtag-reactionを実行。${summary}`);
  }
  await opts.setPhase?.('text');
  await opts.sendReport(
    formatWorkflowReportForDiscord(
      buildTwitterManagerReport({
        workflow: 'hashtag-reaction',
        status: hashtagResultStatus(results),
        summary,
        runKey: opts.messageId
          ? `twitter:hashtag-reaction:${opts.messageId}`
          : 'twitter:hashtag-reaction',
        actions: results.map((entry) => ({
          type: entry.action,
          label: `${entry.item_id} ${entry.action}`,
          status: entry.error ? 'failed' : isTwitterWorkflowDryRun() ? 'dry-run' : 'success',
        })),
        nextAction: results.some((entry) => entry.error)
          ? 'inspect failed hashtag action(s)'
          : undefined,
        error: results
          .map((entry) => entry.error)
          .filter(Boolean)
          .join(' / '),
      }),
      formatHashtagReport(items, results)
    )
  );
  return { summary, results };
}

function hashtagResultStatus(
  results: Array<{ item_id: string; action: string; url?: string; error?: string; reason: string }>
): WorkflowReportStatus {
  if (isTwitterWorkflowDryRun()) return 'dry-run';
  if (results.some((entry) => entry.error)) return 'partial';
  if (results.every((entry) => entry.action !== 'retweet')) return 'skipped';
  return 'success';
}

function formatHashtagReport(
  items: HashtagReactionItem[],
  results: Array<{ item_id: string; action: string; url?: string; error?: string; reason: string }>
): string {
  const resultById = new Map(results.map((result) => [result.item_id, result]));
  const retweets = items.filter((item) => resultById.get(item.id)?.action === 'retweet');
  const skips = items.filter((item) => resultById.get(item.id)?.action !== 'retweet');
  const lines = ['🎨 ハッシュタグ反応レポート', ''];
  lines.push(`🔄 RT（${retweets.length}件）:`);
  if (retweets.length) {
    retweets.forEach((item, index) => {
      const result = resultById.get(item.id);
      lines.push(`${index + 1}. @${item.username} - 「${truncateInline(item.body, 90)}」`);
      lines.push(`   → 理由: ${item.reason}`);
      if (result?.error) lines.push(`   → エラー: ${truncateInline(result.error, 120)}`);
      else if (result?.url) lines.push(`   → ${result.url}`);
    });
  } else {
    lines.push('なし');
  }
  lines.push('');
  lines.push(`⏭️ スキップ（${skips.length}件）:`);
  if (skips.length) {
    skips.forEach((item, index) => {
      lines.push(`${index + 1}. @${item.username} - 「${truncateInline(item.body, 90)}」`);
      lines.push(`   → 理由: ${item.reason}`);
    });
  } else {
    lines.push('なし');
  }
  return lines.join('\n');
}

async function markTweetLogsChecked(ids: string[]): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  await runDbSh(['tweet-log-check', unique.join(',')]);
}

async function createPendingSelfTweet(
  channelId: string,
  revisionCount: number
): Promise<PendingSelfTweet> {
  const [emotion, rawSources] = await Promise.all([getEmotion(), collectRawSelfTweetSources()]);
  const emotionText = formatEmotion(emotion);
  const sourceCollection = await collectSelfTweetSourcesWithAI({
    emotionText,
    todayTopics: rawSources.todayTopics,
    recentTweets: rawSources.recentTweets,
    rawSourceData: rawSources.rawSourceData,
    sourceMode: rawSources.sourceMode,
    presentedTopicCooldown: rawSources.presentedTopicCooldown,
    performanceContext: rawSources.performanceContext,
    runStateContext: rawSources.runStateContext,
  });
  const personContext = await collectPersonContext(sourceCollection);
  const generated = await generateSelfTweetDrafts({
    emotionText,
    todayTopics: rawSources.todayTopics,
    recentTweets: rawSources.recentTweets,
    sourceCollection,
    personContext,
    performanceContext: rawSources.performanceContext,
    runStateContext: rawSources.runStateContext,
  });
  const reviewedDrafts = await prepareDrafts(generated.drafts, sourceCollection, {
    personContext,
    todayTopics: rawSources.todayTopics,
    recentTweets: rawSources.recentTweets,
  });
  return {
    kind: 'self-tweet',
    channelId,
    createdAt: new Date().toISOString(),
    revisionCount,
    draftGenerationSessionId: generated.sessionId,
    emotionText,
    todayTopics: rawSources.todayTopics,
    recentTweets: rawSources.recentTweets,
    sourceMode: rawSources.sourceMode,
    personContext,
    performanceContext: rawSources.performanceContext,
    runStateContext: rawSources.runStateContext,
    sourceCollection,
    drafts: reviewedDrafts,
  };
}

async function revisePendingFromMaster(
  pending: PendingSelfTweet,
  instruction: string,
  selectedDraftId?: string
): Promise<PendingSelfTweet> {
  if (selectedDraftId) {
    const target = selectDraft(pending, selectedDraftId);
    const revised = await reviseSingleSelfTweetDraftFromMaster({
      instruction,
      targetDraft: target,
      sessionId: pending.draftGenerationSessionId,
      pending: {
        emotionText: pending.emotionText,
        todayTopics: pending.todayTopics,
        recentTweets: pending.recentTweets,
        sourceCollection: pending.sourceCollection,
        drafts: pending.drafts,
        personContext: pending.personContext,
        performanceContext: pending.performanceContext,
        runStateContext: pending.runStateContext,
      },
    });
    const revisedDraft = validateDraftShape(revised.draft);
    const mechanicalCheck = await runMechanicalChecks(revisedDraft.text, {
      topic: revisedDraft.topic,
      todayTopics: pending.todayTopics,
      recentTweets: pending.recentTweets,
    });
    const reviewedDraft: ReviewedSelfTweetDraft = {
      ...revisedDraft,
      mechanicalCheck,
      review: okTweetReview(),
      revisionNotes:
        revised.revisionNotes || `マスター指示により${draftLabel(pending, target.id)}を修正`,
    };
    return {
      ...pending,
      createdAt: new Date().toISOString(),
      revisionCount: pending.revisionCount + 1,
      draftGenerationSessionId: revised.sessionId ?? pending.draftGenerationSessionId,
      drafts: pending.drafts.map((draft) => (draft.id === target.id ? reviewedDraft : draft)),
    };
  }

  const revised = await reviseSelfTweetDraftsFromMaster({
    instruction,
    sessionId: pending.draftGenerationSessionId,
    pending: {
      emotionText: pending.emotionText,
      todayTopics: pending.todayTopics,
      recentTweets: pending.recentTweets,
      sourceCollection: pending.sourceCollection,
      drafts: pending.drafts,
      personContext: pending.personContext,
      performanceContext: pending.performanceContext,
      runStateContext: pending.runStateContext,
    },
  });
  const reviewedDrafts = await prepareDrafts(revised.drafts, pending.sourceCollection, {
    personContext: pending.personContext,
    todayTopics: pending.todayTopics,
    recentTweets: pending.recentTweets,
    skipAiReview: true,
  });
  return {
    ...pending,
    createdAt: new Date().toISOString(),
    revisionCount: pending.revisionCount + 1,
    draftGenerationSessionId: revised.sessionId ?? pending.draftGenerationSessionId,
    drafts: reviewedDrafts,
  };
}

async function prepareDrafts(
  drafts: SelfTweetDraft[],
  sourceCollection: SelfTweetSourceCollection,
  options: {
    personContext?: string;
    todayTopics?: string;
    recentTweets?: string;
    sessionIdsByDraftId?: Record<string, string | undefined>;
    skipAiReview?: boolean;
  } = {}
): Promise<ReviewedSelfTweetDraft[]> {
  const normalized = ensureDraftCount(drafts).map(validateDraftShape);
  const checked = await Promise.all(
    normalized.map(async (draft) => ({
      draft,
      mechanicalCheck: await runMechanicalChecks(draft.text, {
        topic: draft.topic,
        todayTopics: options.todayTopics,
        recentTweets: options.recentTweets,
      }),
    }))
  );
  if (options.skipAiReview) {
    return Promise.all(
      checked.map(async ({ draft }) => ({
        ...draft,
        mechanicalCheck: await runMechanicalChecks(draft.text, {
          topic: draft.topic,
          todayTopics: options.todayTopics,
          recentTweets: options.recentTweets,
        }),
        review: okTweetReview(),
        revisionNotes: 'マスター修正後のためAI再レビューなし',
      }))
    );
  }
  const reviewed = await Promise.all(
    checked.map(({ draft, mechanicalCheck }) =>
      reviewAndReviseSelfTweetDraft({
        draft,
        sourceCollection,
        mechanicalCheck,
        personContext: options.personContext,
        sessionId: options.sessionIdsByDraftId?.[draft.id],
      })
    )
  );
  const finalChecked = await Promise.all(
    reviewed.map(async (draft) => ({
      ...draft,
      mechanicalCheck: await runMechanicalChecks(draft.text, {
        topic: draft.topic,
        todayTopics: options.todayTopics,
        recentTweets: options.recentTweets,
      }),
    }))
  );
  return finalChecked.slice(0, 5);
}

async function collectRawSelfTweetSources(): Promise<{
  todayTopics: string;
  recentTweets: string;
  sourceMode: SelfTweetSourceMode;
  presentedTopicCooldown: string;
  performanceContext: string;
  runStateContext: string;
  rawSourceData: string;
}> {
  const [lastSourceModeState, presentedTopicCooldown] = await Promise.all([
    getTwitterRunStateValue('self_tweet_last_source_mode'),
    getRecentPresentedTopicCooldown(),
  ]);
  const sourceMode = chooseSelfTweetSourceMode(lastSourceModeState);
  const [
    todayTopics,
    recentTweets,
    episodes,
    tasks,
    notes,
    wikiTopics,
    articles,
    masterTweets,
    performanceContext,
    runStateContext,
  ] = await Promise.all([
    safeDb(['topics-get']),
    safeRecentTweets(),
    safeDb(['public-episodes', 'x', '30']),
    Promise.resolve('公開系workflowではraw taskを利用しない'),
    safeDb(['public-notes', 'x', '10']),
    safeDb(['public-wiki', 'x', '10']),
    safeDb(['reading-unpushed-twitter']),
    safeSupabaseGet(
      'my_tweets?order=created_at.desc&limit=8&select=text,quoted_text,url,created_at'
    ),
    safeDb(['tweet-metrics-ranking', 'engagement_rate', '8']),
    getTwitterRunStateContext(),
  ]);

  const rawSourceData = buildSelfTweetRawSourceData(sourceMode, {
    episodes,
    tasks,
    notes,
    wikiTopics,
    articles,
    masterTweets,
  });

  return {
    todayTopics: truncateBlock(todayTopics, 1800),
    recentTweets: truncateBlock(recentTweets, 1800),
    sourceMode,
    presentedTopicCooldown,
    performanceContext: truncateBlock(performanceContext, 2200),
    runStateContext: truncateBlock(runStateContext, 2200),
    rawSourceData,
  };
}

function chooseSelfTweetSourceMode(state: Record<string, unknown> | null): SelfTweetSourceMode {
  const requestedMode = process.env.SELF_TWEET_SOURCE_MODE;
  if (SELF_TWEET_SOURCE_MODES.some((mode) => mode === requestedMode)) {
    return requestedMode as SelfTweetSourceMode;
  }
  const lastMode = typeof state?.mode === 'string' ? state.mode : '';
  const lastIndex = SELF_TWEET_SOURCE_MODES.findIndex((mode) => mode === lastMode);
  if (lastIndex >= 0) {
    return SELF_TWEET_SOURCE_MODES[(lastIndex + 1) % SELF_TWEET_SOURCE_MODES.length];
  }
  const nowHour = new Date().getUTCHours();
  return SELF_TWEET_SOURCE_MODES[nowHour % SELF_TWEET_SOURCE_MODES.length];
}

function buildSelfTweetRawSourceData(
  sourceMode: SelfTweetSourceMode,
  sources: {
    episodes: string;
    tasks: string;
    notes: string;
    wikiTopics: string;
    articles: string;
    masterTweets: string;
  }
): string {
  const section = (title: string, body: string, max: number) =>
    [`## ${title}`, truncateBlock(body, max), ''].join('\n');

  switch (sourceMode) {
    case 'tech':
      return [
        '## 今回の収集方針',
        'tech: 積み記事、ナレッジ、ノートを優先する。マスター近況や当日エピソードは補助情報として扱う。',
        '',
        section('積み記事候補', sources.articles, 2600),
        section('ナレッジトピック', sources.wikiTopics, 2000),
        section('最近のノート', sources.notes, 1400),
        section('マスターの直近ツイート（補助）', sources.masterTweets, 700),
      ].join('\n');
    case 'memory':
      return [
        '## 今回の収集方針',
        'memory: 記憶、関係性、過去作業の変化を優先する。単なる当日近況には寄せすぎない。',
        '',
        section('当日のエピソード', sources.episodes, 2400),
        section('ナレッジトピック', sources.wikiTopics, 2000),
        section('最近のノート', sources.notes, 1200),
        section('進行中タスク（補助）', sources.tasks, 900),
      ].join('\n');
    case 'random':
      return [
        '## 今回の収集方針',
        'random: 特定ソースに縛られない自然発想を優先する。記事・ニュース解説ではなく、短い観察、ボケ、問い、日常の一点反応を作る。',
        '',
        section('最近のノート', sources.notes, 1100),
        section('ナレッジトピック', sources.wikiTopics, 900),
        section('当日のエピソード（短いきっかけ）', sources.episodes, 800),
      ].join('\n');
    case 'daily_life':
    default:
      return [
        '## 今回の収集方針',
        'daily_life: 日々の出来事を扱う。ただしマスター近況だけに偏らず、ノートやタスクも混ぜる。',
        '',
        section('当日のエピソード', sources.episodes, 1800),
        section('マスターの直近ツイート', sources.masterTweets, 1300),
        section('進行中タスク', sources.tasks, 1000),
        section('最近のノート', sources.notes, 900),
      ].join('\n');
  }
}

async function runMechanicalChecks(
  text: string,
  context: { topic?: string; todayTopics?: string; recentTweets?: string } = {}
): Promise<MechanicalCheckResult> {
  const issues: string[] = [];
  let checkedText = text;
  if (FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    issues.push('Discordコマンド文字列またはチャンネルメンションを含む');
  }
  if (text.length > 280) {
    issues.push(`280字超過: ${text.length}字`);
  }
  if (looksPrivate(text)) {
    issues.push('私的情報・相談・DM内容に見える表現を含む可能性');
  }
  if (looksLikeArticlePost(text, context.recentTweets)) {
    issues.push('記事起点投稿の頻度が高い可能性');
  }
  if (hasTopicOverlap(text, context.topic, context.todayTopics)) {
    issues.push('今日/直近の使用済みtopicsと題材または切り口が重なる可能性');
  }
  try {
    const filtered = await runTwitterPost(['check-text', text]);
    if (filtered && filtered !== text) {
      checkedText = filtered;
      issues.push('中国語フィルターで本文が自動補正された');
    }
  } catch (err) {
    issues.push(`中国語チェック失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    ok: issues.length === 0,
    checkedText,
    issues,
  };
}

async function publishSelectedSelfTweet(
  draft: ReviewedSelfTweetDraft,
  opts: TwitterWorkflowOptions
): Promise<string> {
  const text = draft.mechanicalCheck.checkedText || draft.text;
  if (isTwitterWorkflowDryRun()) {
    return `TWITTER_WORKFLOW_DRY_RUN=true のため投稿は実行しません。\n\n予定本文:\n「${text}」`;
  }
  await assertPublicEgressAllowed('x', text);
  const skillRunEnv = await ensureSelfTweetSkillRunForPosting(opts.channelId);
  const result = await runTwitterPost(['tweet', text, 'self-tweet'], skillRunEnv);
  await completeSelfTweetSkillRunAfterPosting(skillRunEnv);
  await runDbSh(['topics-add', draft.topic]).catch((e) =>
    console.error('[twitter] topics-add failed:', e)
  );
  await recordEmotionShift(0.05, 0.05, 0, 'self-tweet', 'ツイート投稿成功', draft.topic).catch(
    (e) => console.error('[twitter] emotion-shift failed:', e)
  );
  return result || '（投稿結果のURL取得なし）';
}

function isTwitterWorkflowDryRun(): boolean {
  return resolveWorkflowControl('x', process.env.TWITTER_WORKFLOW_DRY_RUN === 'true').dryRun;
}

function shouldPersistTwitterWorkflow(): boolean {
  return !isTwitterWorkflowDryRun();
}

function validateDraftShape(draft: SelfTweetDraft): SelfTweetDraft {
  const text = sanitizeTweetText(draft.text);
  if (!text) throw new Error('tweet draft is empty');
  return {
    ...draft,
    text,
    topic: draft.topic.trim() || `自発ツイート:${text.slice(0, 80)}`,
    selfReviewMemo: draft.selfReviewMemo.trim(),
  };
}

function ensureDraftCount(drafts: SelfTweetDraft[]): SelfTweetDraft[] {
  const valid = drafts.filter((draft) => draft.text).slice(0, 5);
  if (valid.length < 3) {
    throw new Error(`self-tweet draft count must be 3-5, got ${valid.length}`);
  }
  return valid;
}

function selectDraft(pending: PendingSelfTweet, selectedDraftId?: string): ReviewedSelfTweetDraft {
  if (selectedDraftId) {
    const found = pending.drafts.find((draft) => draft.id === selectedDraftId);
    if (found) return found;
    const byNumber = pending.drafts[Number(selectedDraftId.replace(/\D/g, '')) - 1];
    if (byNumber) return byNumber;
  }
  return pending.drafts[0];
}

function formatApprovalRequest(pending: PendingSelfTweet, revised = false): string {
  const heading = revised ? '📝 ツイート修正版:' : '📝 ツイート案:';
  const lines = [heading, ''];
  pending.drafts.forEach((draft, index) => {
    lines.push(`${index + 1}. 「${draft.text}」`);
    const sourceTitles = draft.sourceCandidateIds
      .map(
        (id) => pending.sourceCollection.candidates.find((candidate) => candidate.id === id)?.title
      )
      .filter(Boolean)
      .join(' / ');
    if (sourceTitles || draft.angle) {
      lines.push(`   元ソース: ${sourceTitles || '自然発想'} / 切り口: ${draft.angle || '未指定'}`);
    }
    if (draft.revisionNotes) lines.push(`   修正: ${draft.revisionNotes}`);
    lines.push('');
  });
  lines.push('投稿する番号、修正指示、または見送りを返信してください。');
  return lines.join('\n').trim();
}

function formatTargetedSelfTweetRevisionRequest(
  pending: PendingSelfTweet,
  selectedDraftId: string,
  responseMessage?: string
): string {
  const draft = selectDraft(pending, selectedDraftId);
  const label = draftLabel(pending, draft.id);
  const lines = [
    responseMessage?.trim() || `承知しました。${label}だけ直すと、これでどうでしょうか。`,
    '',
    `📝 ${label}の修正版:`,
    '',
    `「${draft.text}」`,
  ];
  const sourceTitles = draft.sourceCandidateIds
    .map(
      (id) => pending.sourceCollection.candidates.find((candidate) => candidate.id === id)?.title
    )
    .filter(Boolean)
    .join(' / ');
  if (sourceTitles || draft.angle) {
    lines.push(`元ソース: ${sourceTitles || '自然発想'} / 切り口: ${draft.angle || '未指定'}`);
  }
  if (draft.revisionNotes) lines.push(`修正: ${draft.revisionNotes}`);
  lines.push('', 'これで投稿する場合は「これで」「投稿して」などと返信してください。');
  return lines.join('\n').trim();
}

function draftLabel(pending: PendingSelfTweet, draftId: string): string {
  const index = pending.drafts.findIndex((draft) => draft.id === draftId);
  return index >= 0 ? `案${index + 1}` : draftId;
}

function formatMentionApprovalRequest(pending: PendingMentionReaction, revised = false): string {
  const heading = revised ? '💬 メンション反応修正版:' : '💬 メンション反応チェック:';
  const lines = [heading, `${pending.items.length}件`, ''];
  pending.items.forEach((item, index) => {
    const actionLabel =
      [item.replyAction === 'reply' ? '返信' : '', item.quoteAction === 'quote' ? '引用RT' : '']
        .filter(Boolean)
        .join('+') || 'スキップ';
    lines.push(`${index + 1}. [@${item.username}] ${item.type} → ${actionLabel}`);
    if (item.originalTweetText)
      lines.push(`   🐦 ニケ: 「${truncateInline(item.originalTweetText, 120)}」`);
    lines.push(`   💬 相手: 「${truncateInline(item.body, 140)}」`);
    if (item.replyAction === 'reply' && item.replyText) {
      lines.push(`   ✉️ 返信案: 「${item.replyText}」`);
    }
    if (item.quoteAction === 'quote' && item.quoteText) {
      lines.push(`   🔄 引用RT案: 「${item.quoteText}」`);
    }
    if (actionLabel === 'スキップ') lines.push(`   理由: ${item.reason}`);
    if (item.revisionNotes) lines.push(`   修正: ${item.revisionNotes}`);
    lines.push('');
  });
  lines.push('承認する番号、全体OK、個別修正指示、または明示的な見送りを返信してください。');
  return lines.join('\n').trim();
}

function mentionItemTextForLog(item: MentionReactionItem): string {
  return [
    `@${item.username} ${item.type}`,
    `相手: ${item.body}`,
    item.originalTweetText ? `元: ${item.originalTweetText}` : '',
    item.replyAction === 'reply' && item.replyText ? `返信: ${item.replyText}` : '',
    item.quoteAction === 'quote' && item.quoteText ? `引用: ${item.quoteText}` : '',
    `判定: ${item.reason}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function truncateInline(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

async function recordTwitterLocalEpisode(content: string): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const date = new Date().toISOString().slice(0, 10);
  await runDbSh(['ep-add', date, content.slice(0, 150), 'twitter']).catch((err) =>
    console.error('[twitter] local episode record failed:', err)
  );
}

async function bindWorkflowSession(
  opts: TwitterWorkflowOptions,
  sessionId: string | undefined,
  reason: string
): Promise<void> {
  if (!sessionId) return;
  await opts.bindSession?.(sessionId, reason);
}

interface TwitterActivityLogInput {
  discord_message_id?: string;
  channel_id?: string;
  author_id?: string;
  author_name?: string;
  message_created_at?: string;
  run_key: string;
  workflow: 'self-tweet' | 'mention-reaction' | 'hashtag-reaction';
  stage:
    | 'source_collect'
    | 'draft'
    | 'mechanical_check'
    | 'review'
    | 'present'
    | 'interpret'
    | 'plan'
    | 'revise'
    | 'execute'
    | 'cancel'
    | 'chat'
    | 'feedback'
    | 'error';
  raw_content: string;
  parsed?: Record<string, unknown>;
}

function activityMeta(opts: TwitterWorkflowOptions, runKey: string) {
  return {
    discord_message_id: opts.messageId,
    channel_id: opts.channelId,
    author_id: opts.authorId,
    author_name: opts.authorName,
    message_created_at: opts.messageCreatedAt,
    run_key: runKey,
  };
}

async function addTwitterActivityLog(input: TwitterActivityLogInput): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const requestedDryRun = process.env.TWITTER_WORKFLOW_DRY_RUN === 'true';
  const control = resolveWorkflowControl('x', requestedDryRun);
  const coreAudit = getNikechanCoreAudit('xangi-social');
  try {
    const res = await fetch(`${url}/rest/v1/twitter_activity_logs`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        ...input,
        parsed: {
          nikechan_core: coreAudit,
          release_mode: control.releaseMode,
          workflow_report: createWorkflowReport({
            surface: 'x',
            workflow: input.workflow,
            status: twitterReportStatus(input.stage, input.parsed),
            summary: input.raw_content,
            sourceRefs: [input.run_key ? `run:${input.run_key}` : null].filter(
              (ref): ref is string => Boolean(ref)
            ),
            audit: {
              releaseMode: control.releaseMode,
              dryRun: control.dryRun,
              coreProfile: stringField(coreAudit, 'profileId'),
              coreStatus: stringField(coreAudit, 'status'),
            },
            nextAction: twitterNextAction(input.stage),
            error: input.stage === 'error' ? stringField(input.parsed, 'error') : undefined,
          }),
          ...(input.parsed ?? {}),
        },
        created_by: 'xangi',
      }),
    });
    if (!res.ok) {
      console.error(`[twitter] activity log insert failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('[twitter] activity log insert failed:', err);
  }
}

function buildTwitterManagerReport(input: {
  workflow: TwitterActivityLogInput['workflow'];
  status: WorkflowReportStatus;
  summary: string;
  runKey: string;
  actions?: Array<{ type: string; label: string; status?: WorkflowReportStatus }>;
  nextAction?: string;
  error?: string;
}) {
  const control = resolveWorkflowControl('x', process.env.TWITTER_WORKFLOW_DRY_RUN === 'true');
  return createWorkflowReport({
    surface: 'x',
    workflow: input.workflow,
    status: input.status,
    summary: input.summary,
    actions: input.actions ?? [],
    sourceRefs: [`run:${input.runKey}`],
    audit: {
      releaseMode: control.releaseMode,
      dryRun: control.dryRun,
      coreProfile: 'xangi-social',
    },
    nextAction: input.nextAction,
    error: input.error || undefined,
  });
}

function twitterReportStatus(
  stage: TwitterActivityLogInput['stage'],
  parsed?: Record<string, unknown>
): WorkflowReportStatus {
  if (stage === 'error') return 'failed';
  if (stage === 'cancel') return 'skipped';
  if (stage === 'present') return 'blocked';
  if (stage === 'execute' && hasTwitterExecutionErrors(parsed)) return 'partial';
  return 'success';
}

function hasTwitterExecutionErrors(parsed?: Record<string, unknown>): boolean {
  const results = parsed?.results;
  if (!Array.isArray(results)) return false;
  return results.some((result) => {
    if (!result || typeof result !== 'object') return false;
    const value = result as Record<string, unknown>;
    return typeof value.error === 'string' || value.ok === false;
  });
}

function twitterNextAction(stage: TwitterActivityLogInput['stage']): string | undefined {
  if (stage === 'present') return 'wait for master approval';
  if (stage === 'error') return 'inspect twitter workflow failure';
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

async function recordTwitterFeedback(
  keyOrFeedback: string,
  feedbackOrMetadata: string | Record<string, unknown>,
  maybeMetadata?: Record<string, unknown>
): Promise<void> {
  const stateKey =
    typeof feedbackOrMetadata === 'string' ? keyOrFeedback : 'self_tweet_latest_feedback';
  const feedback = typeof feedbackOrMetadata === 'string' ? feedbackOrMetadata : keyOrFeedback;
  const metadata =
    typeof feedbackOrMetadata === 'string' ? (maybeMetadata ?? {}) : feedbackOrMetadata;
  await setTwitterRunState(stateKey, {
    at: new Date().toISOString(),
    feedback,
    metadata,
  });
}

async function appendPresentedSelfTweetTopics(pending: PendingSelfTweet): Promise<void> {
  const state = await getTwitterRunStateValue('self_tweet_recent_presented_topics');
  const previous = normalizePresentedSelfTweetTopics(state?.topics);
  const now = pending.createdAt || new Date().toISOString();
  const additions = pending.drafts.map((draft): PresentedSelfTweetTopic => {
    const candidates = draft.sourceCandidateIds
      .map((id) => pending.sourceCollection.candidates.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    return {
      at: now,
      topic: draft.topic,
      titles: candidates.map((candidate) => candidate.title).filter(Boolean),
      sourceTypes: [
        ...new Set(candidates.map((candidate) => candidate.sourceType).filter(Boolean)),
      ],
      angle: draft.angle || undefined,
      textPreview: truncateInline(draft.text, 120),
    };
  });
  const cutoff = Date.now() - PRESENTED_TOPIC_COOLDOWN_HOURS * 60 * 60 * 1000;
  const topics = [...additions, ...previous]
    .filter((topic) => Date.parse(topic.at) >= cutoff)
    .slice(0, PRESENTED_TOPIC_COOLDOWN_LIMIT);
  await setTwitterRunState('self_tweet_recent_presented_topics', {
    at: now,
    cooldown_hours: PRESENTED_TOPIC_COOLDOWN_HOURS,
    topics,
  });
}

async function getRecentPresentedTopicCooldown(): Promise<string> {
  const state = await getTwitterRunStateValue('self_tweet_recent_presented_topics');
  const topics = normalizePresentedSelfTweetTopics(state?.topics);
  if (!topics.length) return '（なし）';
  const cutoff = Date.now() - PRESENTED_TOPIC_COOLDOWN_HOURS * 60 * 60 * 1000;
  const recent = topics.filter((topic) => Date.parse(topic.at) >= cutoff).slice(0, 20);
  if (!recent.length) return '（なし）';
  return recent
    .map((topic, index) => {
      const labels = [topic.topic, ...topic.titles].filter(Boolean).join(' / ');
      const sourceTypes = topic.sourceTypes.length ? ` [${topic.sourceTypes.join(', ')}]` : '';
      return `${index + 1}. ${topic.at}${sourceTypes}: ${truncateInline(labels, 180)}`;
    })
    .join('\n');
}

function normalizePresentedSelfTweetTopics(value: unknown): PresentedSelfTweetTopic[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PresentedSelfTweetTopic | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const at = getString(raw.at);
      const topic = getString(raw.topic);
      const textPreview = getString(raw.textPreview);
      if (!at || !topic) return null;
      return {
        at,
        topic,
        titles: Array.isArray(raw.titles) ? raw.titles.map(String).filter(Boolean) : [],
        sourceTypes: Array.isArray(raw.sourceTypes)
          ? raw.sourceTypes.map(String).filter(Boolean)
          : [],
        angle: getString(raw.angle) || undefined,
        textPreview,
      };
    })
    .filter((topic): topic is PresentedSelfTweetTopic => Boolean(topic));
}

async function getTwitterRunStateValue(keyName: string): Promise<Record<string, unknown> | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const encodedKey = encodeURIComponent(keyName);
    const res = await fetch(
      `${url}/rest/v1/twitter_run_state?key=eq.${encodedKey}&select=value&limit=1`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ value?: unknown }>;
    const value = rows[0]?.value;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function getTwitterRunStateContext(): Promise<string> {
  return safeSupabaseGet(
    'twitter_run_state?select=key,value,updated_at&order=updated_at.desc&limit=12'
  );
}

async function setTwitterRunState(keyName: string, value: Record<string, unknown>): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/twitter_run_state?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        key: keyName,
        value,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[twitter] run_state upsert failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('[twitter] run_state upsert failed:', err);
  }
}

async function collectPersonContext(sourceCollection: SelfTweetSourceCollection): Promise<string> {
  const terms = extractPersonSearchTerms(sourceCollection);
  if (!terms.length) return '（なし）';
  const results = await Promise.all(
    terms.slice(0, 8).map(async (term) => {
      const result = await safeDb(['user-search-public', term, 'x']);
      return `## ${term}\n${truncateBlock(result, 900)}`;
    })
  );
  return results.join('\n\n');
}

function extractPersonSearchTerms(sourceCollection: SelfTweetSourceCollection): string[] {
  const text = JSON.stringify(sourceCollection);
  const terms = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9_]{2,20})/g)) {
    terms.add(match[1]);
  }
  for (const match of text.matchAll(
    /([一-龯ぁ-んァ-ヶA-Za-z0-9_]{2,16}(?:ちゃん|さん|氏|くん|たん|先生))/g
  )) {
    terms.add(match[1]);
  }
  return [...terms].filter((term) => !['AIニケちゃん', 'ニケちゃん', 'マスター'].includes(term));
}

function looksPrivate(text: string): boolean {
  return /(DM|ダイレクトメッセージ|個人情報|住所|電話番号|メールアドレス|ライセンス相談|問い合わせ内容|相談内容|秘密|内緒)/i.test(
    text
  );
}

function looksLikeArticlePost(text: string, recentTweets?: string): boolean {
  const currentArticleLike = /(https?:\/\/|記事|ニュース|論文|ブログ|読んで)/.test(text);
  if (!currentArticleLike) return false;
  const recent = recentTweets || '';
  const recentArticleCount = [...recent.matchAll(/https?:\/\/|記事|ニュース|論文|ブログ|読んで/g)]
    .length;
  return recentArticleCount >= 2;
}

function hasTopicOverlap(text: string, topic?: string, todayTopics?: string): boolean {
  const base = `${text}\n${topic || ''}`;
  const history = todayTopics || '';
  if (!history.trim()) return false;
  const terms = extractSignificantTerms(base);
  if (!terms.length) return false;
  const hits = terms.filter((term) => history.includes(term));
  return hits.length >= Math.min(2, terms.length);
}

function extractSignificantTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}|[一-龯ァ-ヶぁ-ん]{3,}/g)) {
    const term = match[0];
    if (isNoisyTopicTerm(term)) continue;
    terms.add(term);
  }
  return [...terms].slice(0, 10);
}

function isNoisyTopicTerm(term: string): boolean {
  return ['ます', 'です', 'こと', 'もの', 'ツイート', '自発ツイート', 'AI', 'Claude'].includes(
    term
  );
}

async function safeDb(args: string[]): Promise<string> {
  try {
    const raw = await runDbSh(args);
    return raw || '（なし）';
  } catch (err) {
    return `（取得失敗: ${err instanceof Error ? err.message : String(err)}）`;
  }
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function parseUserProfile(raw: string): UserProfileRecord {
  const object = parseJsonObject<Record<string, unknown>>(raw);
  if (object) return normalizeUserProfile(object);
  const array = parseJsonArray<Record<string, unknown>>(raw);
  return array[0] ? normalizeUserProfile(array[0]) : {};
}

function normalizeUserProfile(raw: Record<string, unknown>): UserProfileRecord {
  return {
    id: getString(raw.id) || undefined,
    name: getString(raw.name) || null,
    nickname: getString(raw.nickname) || null,
    bio: getString(raw.bio) || null,
    relationship: null,
    relationship_public: getString(raw.relationship_public) || null,
  };
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function safeRecentTweets(): Promise<string> {
  const fromTweetsTable = await safeSupabaseGet(
    'tweets?action_type=in.(tweet,quote)&order=created_at.desc&limit=8&select=content,url,created_at,action_type'
  );
  if (!fromTweetsTable.startsWith('（取得失敗:')) return fromTweetsTable;
  return safeDb(['tweet-metrics-ranking', 'created_at', '8']);
}

async function safeSupabaseGet(path: string): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return '（取得失敗: Supabase env missing）';
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) return `（取得失敗: ${res.status} ${await res.text()}）`;
    return JSON.stringify(await res.json(), null, 2);
  } catch (err) {
    return `（取得失敗: ${err instanceof Error ? err.message : String(err)}）`;
  }
}

function truncateBlock(text: string, max: number): string {
  const trimmed = (text || '（なし）').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n...（省略）` : trimmed;
}

async function ensureSelfTweetSkillRunForPosting(channelId?: string): Promise<NodeJS.ProcessEnv> {
  const env = {
    ...process.env,
    XANGI_DATA_DIR: DATA_DIR,
    XANGI_CONVERSATION_KEY: channelId || process.env.XANGI_CONVERSATION_KEY || '',
    XANGI_CHANNEL_ID: channelId || process.env.XANGI_CHANNEL_ID || '',
    XANGI_ENTRYPOINT: 'twitter-workflow',
    XANGI_PLATFORM: 'discord',
  };
  await runSkillRun(['ensure', 'self-tweet'], env);
  const completedSteps: Array<[string, string]> = [
    ['1', '新self-tweetワークフローで情報収集完了'],
    ['2', '新self-tweetワークフローで案生成完了'],
    ['3', '新self-tweetワークフローでセルフレビュー相当を完了'],
    ['4', '新self-tweetワークフローでAIレビュー完了'],
    ['5', 'Discord承認フロー完了'],
  ];
  for (const [step, note] of completedSteps) {
    await runSkillRun(['step-complete', step, note], env);
  }
  return env;
}

async function completeSelfTweetSkillRunAfterPosting(env: NodeJS.ProcessEnv): Promise<void> {
  await runSkillRun(['step-complete', '6', '投稿完了'], env).catch((e) =>
    console.error('[twitter] skill-run step 6 completion failed:', e)
  );
  await runSkillRun(['complete', 'self-tweet完了'], env).catch((e) =>
    console.error('[twitter] skill-run completion failed:', e)
  );
}

function runSkillRun(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [join(WORKDIR, 'scripts/skill-run.sh'), ...args], {
      env,
      cwd: WORKDIR,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      if (code !== 0) reject(new Error(`skill-run.sh failed (${code}): ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
    proc.on('error', reject);
  });
}

function runTwitterPost(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'bash',
      [join(WORKDIR, '.agents/skills/twitter-post/scripts/twitter-post.sh'), ...args],
      {
        env,
        cwd: WORKDIR,
      }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      if (code !== 0) reject(new Error(`twitter-post.sh failed (${code}): ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
    proc.on('error', reject);
  });
}

async function getPendingSelfTweet(channelId: string): Promise<PendingSelfTweet | null> {
  const state = await loadState();
  return state.pendingSelfTweets[channelId] ?? null;
}

async function savePendingSelfTweet(channelId: string, pending: PendingSelfTweet): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const state = await loadState();
  state.pendingSelfTweets[channelId] = pending;
  delete state.closedSelfTweets[channelId];
  await saveState(state);
}

async function clearPendingSelfTweet(
  channelId: string,
  reason: ClosedWorkflowChannel['reason']
): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const state = await loadState();
  delete state.pendingSelfTweets[channelId];
  state.closedSelfTweets[channelId] = {
    closedAt: new Date().toISOString(),
    reason,
  };
  await saveState(state);
}

async function getPendingMentionReaction(
  channelId: string
): Promise<PendingMentionReaction | null> {
  const state = await loadState();
  return state.pendingMentionReactions[channelId] ?? null;
}

async function savePendingMentionReaction(
  channelId: string,
  pending: PendingMentionReaction
): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const state = await loadState();
  state.pendingMentionReactions[channelId] = pending;
  delete state.closedMentionReactions[channelId];
  await saveState(state);
}

async function clearPendingMentionReaction(
  channelId: string,
  reason: ClosedWorkflowChannel['reason']
): Promise<void> {
  if (!shouldPersistTwitterWorkflow()) return;
  const state = await loadState();
  delete state.pendingMentionReactions[channelId];
  state.closedMentionReactions[channelId] = {
    closedAt: new Date().toISOString(),
    reason,
  };
  await saveState(state);
}

async function loadState(): Promise<TwitterWorkflowState> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TwitterWorkflowState>;
    return {
      pendingSelfTweets: parsed.pendingSelfTweets ?? {},
      pendingMentionReactions: parsed.pendingMentionReactions ?? {},
      closedSelfTweets: parsed.closedSelfTweets ?? {},
      closedMentionReactions: parsed.closedMentionReactions ?? {},
    };
  } catch {
    return {
      pendingSelfTweets: {},
      pendingMentionReactions: {},
      closedSelfTweets: {},
      closedMentionReactions: {},
    };
  }
}

async function saveState(state: TwitterWorkflowState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
