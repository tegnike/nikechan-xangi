import { spawn } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { formatEmotion, getEmotion, recordEmotionShift, runDbSh } from '../lib/db-helpers.js';
import {
  collectSelfTweetSourcesWithAI,
  decideMentionNickname,
  generateHashtagReactionPlan,
  generateSelfTweetDrafts,
  generateMentionReactionPlan,
  interpretMasterMentionReactionReply,
  interpretMasterSelfTweetReply,
  reviewAndReviseMentionReactionItem,
  reviewAndReviseSelfTweetDraft,
  reviseMentionReactionPlanFromMaster,
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

export interface TwitterSentReport {
  messageId?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: string;
}

export interface TwitterWorkflowOptions {
  sendReport: (text: string) => Promise<TwitterSentReport | void>;
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

interface TwitterWorkflowState {
  pendingSelfTweets: Record<string, PendingSelfTweet>;
  pendingMentionReactions: Record<string, PendingMentionReaction>;
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
    const pending = await createPendingSelfTweet(channelId, 0);
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
      source_types: pending.sourceCollection.candidates.map((candidate) => candidate.sourceType),
      draft_count: pending.drafts.length,
    });
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
    await opts.sendReport(`⚠️ 自発ツイートワークフロー失敗: ${message.slice(0, 300)}`);
  }
}

export async function handleSelfTweetApproval(
  prompt: string,
  opts: TwitterWorkflowOptions
): Promise<boolean> {
  const channelId = opts.channelId;
  if (!channelId) return false;

  const pending = await getPendingSelfTweet(channelId);
  if (!pending) return false;
  const runKey = `twitter:self-tweet:${channelId}`;

  const normalized = prompt.trim();
  if (!normalized || normalized.startsWith('/')) return false;

  const decision = await interpretMasterSelfTweetReply({
    message: normalized,
    pending: {
      sourceCollection: pending.sourceCollection,
      drafts: pending.drafts,
      revisionCount: pending.revisionCount,
    },
  }).catch((err) => {
    console.error('[twitter] master reply interpretation failed:', err);
    return fallbackMasterDecision(normalized);
  });
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
    await publishSelectedSelfTweet(draft, opts);
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
      },
    });
    await clearPendingSelfTweet(channelId);
    await setTwitterRunState('self_tweet_last_execute', {
      at: new Date().toISOString(),
      selected_draft_id: draft.id,
      topic: draft.topic,
      source_candidate_ids: draft.sourceCandidateIds,
    });
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
    await clearPendingSelfTweet(channelId);
    await setTwitterRunState('self_tweet_last_cancel', {
      at: new Date().toISOString(),
      message: normalized,
    });
    await opts.sendReport('了解です。今回は見送ります。');
    return true;
  }

  try {
    const revised = await revisePendingFromMaster(pending, decision.instruction || normalized);
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
    await opts.sendReport(formatApprovalRequest(revised, true));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] self-tweet revision failed:', err);
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
    const pending = await createPendingMentionReaction(channelId, 0);
    if (!pending) {
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
    await opts.sendReport(`⚠️ メンション反応ワークフロー失敗: ${message.slice(0, 300)}`);
  }
}

export async function handleMentionReactionApproval(
  prompt: string,
  opts: TwitterWorkflowOptions
): Promise<boolean> {
  const channelId = opts.channelId;
  if (!channelId) return false;

  const pending = await getPendingMentionReaction(channelId);
  if (!pending) return false;
  const runKey = `twitter:mention-reaction:${channelId}`;

  const normalized = prompt.trim();
  if (!normalized || normalized.startsWith('/')) return false;

  const decision = await interpretMasterMentionReactionReply({
    message: normalized,
    pending: {
      items: pending.items,
      revisionCount: pending.revisionCount,
    },
  }).catch((err) => {
    console.error('[twitter] mention reply interpretation failed:', err);
    return fallbackMentionDecision(normalized);
  });
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
    const result = await executeMentionReactions(items, pending, opts);
    await addTwitterActivityLog({
      ...activityMeta(opts, runKey),
      workflow: 'mention-reaction',
      stage: 'execute',
      raw_content: result.summary,
      parsed: result,
    });
    await clearPendingMentionReaction(channelId);
    await setTwitterRunState('mention_reaction_last_execute', {
      at: new Date().toISOString(),
      summary: result.summary,
      item_ids: items.map((item) => item.id),
    });
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
    await clearPendingMentionReaction(channelId);
    await setTwitterRunState('mention_reaction_last_cancel', {
      at: new Date().toISOString(),
      message: normalized,
    });
    await opts.sendReport('了解です。今回は見送ります。');
    return true;
  }

  try {
    const revised = await revisePendingMentionFromMaster(
      pending,
      decision.instruction || normalized
    );
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
    await opts.sendReport(formatMentionApprovalRequest(revised, true));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[twitter] mention-reaction revision failed:', err);
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
    const [emotion, candidates] = await Promise.all([
      getEmotion(),
      collectHashtagReactionCandidates(),
    ]);
    if (!candidates.length) {
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

    const items = await generateHashtagReactionPlan({ emotionText, candidates });
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

    const result = await executeHashtagReactions(items, candidates, opts);
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
  memo?: string | null;
  context?: string | null;
  traits?: string[] | null;
}

async function collectTweetAuthorContext(log: TweetLogRecord): Promise<TweetAuthorContext> {
  const username = log.username || log.user_id || 'unknown';
  const ensured = parseJsonObject<Record<string, unknown>>(
    await safeDb(['user-ensure', 'twitter', log.user_id || '', username, log.name || username])
  );
  const userId = typeof ensured?.id === 'string' ? ensured.id : '';
  const [profileRaw, episodes, thirdParties] = await Promise.all([
    userId ? safeDb(['user-get', userId]) : Promise.resolve(JSON.stringify(ensured ?? {})),
    userId ? safeDb(['ce-list', userId, '5']) : Promise.resolve('[]'),
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
      relationship: profile.relationship,
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
      async (term) => `### ${term}\n${truncateBlock(await safeDb(['user-search', term]), 700)}`
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
  pending: PendingMentionReaction,
  opts: TwitterWorkflowOptions
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
      await runDbSh(['tweet-log-action', item.tweetLogId, result.action]).catch((e) =>
        console.error('[twitter] tweet-log-action failed:', e)
      );
      await recordMentionContactEpisode(item, pending, result).catch((e) =>
        console.error('[twitter] mention contact episode failed:', e)
      );
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error('[twitter] mention publish failed:', err);
    }
    results.push(result);
  }

  if (replyCount + quoteCount > 0) {
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
  const urls = results
    .flatMap((result) => [result.reply_url, result.quote_url].filter(Boolean))
    .join('\n');
  await opts.sendReport(`メンション反応を処理しました。\n${summary}${urls ? `\n\n${urls}` : ''}`);
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
          result.url = await runTwitterPost(['retweet', item.postId, 'hashtag-reaction']);
        }
        retweetCount += 1;
        await runDbSh(['tweet-log-action', item.tweetLogId, 'retweet']).catch((e) =>
          console.error('[twitter] hashtag tweet-log-action failed:', e)
        );
        if (candidate?.authorUserId) {
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
        await runDbSh(['tweet-log-action', item.tweetLogId, 'skip']).catch((e) =>
          console.error('[twitter] hashtag skip action failed:', e)
        );
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error('[twitter] hashtag retweet failed:', err);
    }
    results.push(result);
  }

  if (retweetCount > 0) {
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
  await opts.sendReport(formatHashtagReport(items, results));
  return { summary, results };
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
    personContext,
    performanceContext: rawSources.performanceContext,
    runStateContext: rawSources.runStateContext,
    sourceCollection,
    drafts: reviewedDrafts,
  };
}

async function revisePendingFromMaster(
  pending: PendingSelfTweet,
  instruction: string
): Promise<PendingSelfTweet> {
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
  performanceContext: string;
  runStateContext: string;
  rawSourceData: string;
}> {
  const today = new Date().toISOString().slice(0, 10);
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
    safeDb(['ep-list', today]),
    safeDb(['task-list', 'in_progress']),
    safeDb(['note-list']),
    safeDb(['wiki-list', 'active']),
    safeDb(['reading-unpushed-twitter']),
    safeSupabaseGet(
      'my_tweets?order=created_at.desc&limit=8&select=text,quoted_text,url,created_at'
    ),
    safeDb(['tweet-metrics-ranking', 'engagement_rate', '8']),
    getTwitterRunStateContext(),
  ]);

  const rawSourceData = [
    '## 当日のエピソード',
    truncateBlock(episodes, 2500),
    '',
    '## 進行中タスク',
    truncateBlock(tasks, 1600),
    '',
    '## 最近のノート',
    truncateBlock(notes, 1600),
    '',
    '## ナレッジトピック',
    truncateBlock(wikiTopics, 1600),
    '',
    '## 積み記事候補',
    truncateBlock(articles, 1600),
    '',
    '## マスターの直近ツイート',
    truncateBlock(masterTweets, 2000),
  ].join('\n');

  return {
    todayTopics: truncateBlock(todayTopics, 1800),
    recentTweets: truncateBlock(recentTweets, 1800),
    performanceContext: truncateBlock(performanceContext, 2200),
    runStateContext: truncateBlock(runStateContext, 2200),
    rawSourceData,
  };
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
): Promise<void> {
  const text = draft.mechanicalCheck.checkedText || draft.text;
  if (isTwitterWorkflowDryRun()) {
    await opts.sendReport(
      `TWITTER_WORKFLOW_DRY_RUN=true のため投稿は実行しません。\n\n予定本文:\n「${text}」`
    );
    return;
  }
  const skillRunEnv = await ensureSelfTweetSkillRunForPosting(opts.channelId);
  const result = await runTwitterPost(['tweet', text, 'self-tweet'], skillRunEnv);
  await completeSelfTweetSkillRunAfterPosting(skillRunEnv);
  await runDbSh(['topics-add', draft.topic]).catch((e) =>
    console.error('[twitter] topics-add failed:', e)
  );
  await recordEmotionShift(0.05, 0.05, 0, 'self-tweet', 'ツイート投稿成功', draft.topic).catch(
    (e) => console.error('[twitter] emotion-shift failed:', e)
  );
  await opts.sendReport(`投稿しました。\n${result || '（投稿結果のURL取得なし）'}`);
}

function isTwitterWorkflowDryRun(): boolean {
  return process.env.TWITTER_WORKFLOW_DRY_RUN === 'true';
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

function fallbackMentionDecision(message: string): {
  action: 'execute' | 'revise' | 'cancel';
  selectedItemIds?: string[];
  instruction?: string;
  feedbackForFuture?: string;
} {
  const clean = normalizeDecisionText(message);
  const numbers = [...clean.matchAll(/[1-9]/g)].map((match) => `m${match[0]}`);
  if (/^(却下|見送り|やめて|だめ|ダメ|no|ng|stop|キャンセル|全部なし|全てなし)$/i.test(clean)) {
    return { action: 'cancel' as const };
  }
  if (
    isApproval(clean) ||
    /未対応|スキップ|反応しない|そのままでOK|全部OK/i.test(message) ||
    numbers.length
  ) {
    return {
      action: 'execute' as const,
      selectedItemIds: numbers.length ? [...new Set(numbers)] : undefined,
    };
  }
  return { action: 'revise' as const, instruction: message };
}

function fallbackMasterDecision(message: string): {
  action: 'post' | 'revise' | 'cancel';
  selectedDraftId?: string;
  instruction?: string;
  feedbackForFuture?: string;
} {
  const clean = normalizeDecisionText(message);
  const number = clean.match(/[1-5]/)?.[0];
  if (isRejection(clean)) return { action: 'cancel' as const };
  if (isApproval(clean) || number) {
    return { action: 'post' as const, selectedDraftId: number ? `d${number}` : undefined };
  }
  return { action: 'revise' as const, instruction: message };
}

function isApproval(text: string): boolean {
  const clean = normalizeDecisionText(text);
  return /^(ok|okです|okay|承認|投稿して|投稿していい|投稿していいです|お願いします|いいよ|よいです|良いです|どうぞ|go|yes|👍)$/i.test(
    clean
  );
}

function isRejection(text: string): boolean {
  const clean = normalizeDecisionText(text);
  return /^(却下|見送り|やめて|だめ|ダメ|no|ng|stop|キャンセル)$/i.test(clean);
}

function normalizeDecisionText(text: string): string {
  return text.replace(/[。、.!！?？\s]/g, '').trim();
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
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
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
        parsed: input.parsed ?? {},
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

async function getTwitterRunStateContext(): Promise<string> {
  return safeSupabaseGet(
    'twitter_run_state?select=key,value,updated_at&order=updated_at.desc&limit=8'
  );
}

async function setTwitterRunState(keyName: string, value: Record<string, unknown>): Promise<void> {
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
      const result = await safeDb(['user-search', term]);
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
    relationship: getString(raw.relationship) || null,
    memo: getString(raw.memo) || null,
    context: getString(raw.context) || null,
    traits: Array.isArray(raw.traits) ? raw.traits.map(String).filter(Boolean) : null,
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
  const state = await loadState();
  state.pendingSelfTweets[channelId] = pending;
  await saveState(state);
}

async function clearPendingSelfTweet(channelId: string): Promise<void> {
  const state = await loadState();
  delete state.pendingSelfTweets[channelId];
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
  const state = await loadState();
  state.pendingMentionReactions[channelId] = pending;
  await saveState(state);
}

async function clearPendingMentionReaction(channelId: string): Promise<void> {
  const state = await loadState();
  delete state.pendingMentionReactions[channelId];
  await saveState(state);
}

async function loadState(): Promise<TwitterWorkflowState> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TwitterWorkflowState>;
    return {
      pendingSelfTweets: parsed.pendingSelfTweets ?? {},
      pendingMentionReactions: parsed.pendingMentionReactions ?? {},
    };
  } catch {
    return { pendingSelfTweets: {}, pendingMentionReactions: {} };
  }
}

async function saveState(state: TwitterWorkflowState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
