import { spawn } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { formatEmotion, getEmotion, recordEmotionShift, runDbSh } from '../lib/db-helpers.js';
import {
  collectSelfTweetSourcesWithAI,
  generateSelfTweetDrafts,
  interpretMasterSelfTweetReply,
  reviewAndReviseSelfTweetDraft,
  reviseSelfTweetDraftsFromMaster,
  sanitizeTweetText,
  type MechanicalCheckResult,
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
  emotionText: string;
  todayTopics: string;
  recentTweets: string;
  personContext: string;
  performanceContext: string;
  runStateContext: string;
  sourceCollection: SelfTweetSourceCollection;
  drafts: ReviewedSelfTweetDraft[];
}

interface TwitterWorkflowState {
  pendingSelfTweets: Record<string, PendingSelfTweet>;
}

export function isSelfTweetWorkflowPrompt(prompt: string): boolean {
  return /^\/self-tweet(?:\s|（|\(|$)/.test(prompt.trim());
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
    const revised = await revisePendingFromMaster(
      pending,
      decision.instruction || normalized,
      decision.selectedDraftId
    );
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
  const drafts = await generateSelfTweetDrafts({
    emotionText,
    todayTopics: rawSources.todayTopics,
    recentTweets: rawSources.recentTweets,
    sourceCollection,
    personContext,
    performanceContext: rawSources.performanceContext,
    runStateContext: rawSources.runStateContext,
  });
  const reviewedDrafts = await prepareDrafts(drafts, sourceCollection, {
    personContext,
    todayTopics: rawSources.todayTopics,
    recentTweets: rawSources.recentTweets,
  });
  return {
    kind: 'self-tweet',
    channelId,
    createdAt: new Date().toISOString(),
    revisionCount,
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
  instruction: string,
  selectedDraftId?: string
): Promise<PendingSelfTweet> {
  const selectedDraft = selectedDraftId ? selectDraft(pending, selectedDraftId) : undefined;
  const revised = await reviseSelfTweetDraftsFromMaster({
    instruction,
    sessionId: selectedDraft?.reviewSessionId,
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
    sessionIdsByDraftId:
      selectedDraft?.id && revised.sessionId ? { [selectedDraft.id]: revised.sessionId } : {},
  });
  return {
    ...pending,
    createdAt: new Date().toISOString(),
    revisionCount: pending.revisionCount + 1,
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
  feedback: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await setTwitterRunState('self_tweet_latest_feedback', {
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

async function loadState(): Promise<TwitterWorkflowState> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TwitterWorkflowState>;
    return {
      pendingSelfTweets: parsed.pendingSelfTweets ?? {},
    };
  } catch {
    return { pendingSelfTweets: {} };
  }
}

async function saveState(state: TwitterWorkflowState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
