import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();

function readPrompt(path: string, fallback: string): string {
  try {
    return readFileSync(join(WORKDIR, path), 'utf-8');
  } catch {
    return fallback;
  }
}

const CHARACTER_BASE = readPrompt(
  '.agents/skills/twitter-post/prompts/character-base.md',
  'ニケ（AIニケちゃん）。丁寧で実用的、少し親しみのある口調。'
);
const CHARACTER_TWITTER = readPrompt(
  '.agents/skills/twitter-post/prompts/character-twitter.md',
  'Twitterでは短く自然な日本語で話す。'
);
const SELF_TWEET_RULES = readPrompt(
  '.agents/skills/twitter-post/prompts/self-tweet.md',
  '自分の体験や観察をもとに、自然なツイートを作る。'
);
const TWEET_REVIEW_RULES = readPrompt(
  '.agents/skills/twitter-post/prompts/tweet-review.md',
  '事実正確性、口調、読者理解度を確認する。'
);
const MENTION_REACTION_RULES = readPrompt(
  '.agents/skills/twitter-post/prompts/mention-reaction.md',
  'リプライ・引用RT・メンションへの反応を判断する。'
);

export interface RawSelfTweetSources {
  emotionText: string;
  todayTopics: string;
  recentTweets: string;
  rawSourceData: string;
  performanceContext?: string;
  runStateContext?: string;
}

export interface SelfTweetSourceCandidate {
  id: string;
  title: string;
  sourceType: string;
  sourceRefs: string[];
  details: string;
  angle: string;
  duplicateRisk: string;
}

export interface SelfTweetSourceCollection {
  summary: string;
  candidates: SelfTweetSourceCandidate[];
  rejected: Array<{ title: string; reason: string }>;
  recentPatternNotes: string;
}

export interface SelfTweetDraft {
  id: string;
  text: string;
  topic: string;
  sourceCandidateIds: string[];
  angle: string;
  selfReviewMemo: string;
}

export interface MechanicalCheckResult {
  ok: boolean;
  checkedText: string;
  issues: string[];
}

export interface TweetReviewResult {
  accuracy: 'OK' | 'NG';
  accuracy_issues: string[];
  character_voice: 'OK' | 'NG';
  character_voice_issues: string[];
  comprehension: 'OK' | 'NG';
  comprehension_issues: string[];
  overall: 'OK' | 'NG';
  suggestion: string | null;
}

export interface ReviewedSelfTweetDraft extends SelfTweetDraft {
  mechanicalCheck: MechanicalCheckResult;
  review: TweetReviewResult;
  revisionNotes: string;
  reviewSessionId?: string;
}

export interface MasterSelfTweetDecision {
  action: 'post' | 'revise' | 'cancel';
  selectedDraftId?: string;
  instruction?: string;
  feedbackForFuture?: string;
}

export interface MentionReactionCandidate {
  id: string;
  tweetLogId: string;
  postId: string;
  authorUserId?: string;
  username: string;
  displayName: string;
  authorName?: string;
  nickname?: string;
  type: string;
  body: string;
  createdAt?: string;
  originalTweetId?: string;
  originalTweetText?: string;
  originalTweetUrl?: string;
  personContext: string;
}

export interface MentionReactionItem {
  id: string;
  tweetLogId: string;
  postId: string;
  username: string;
  displayName: string;
  type: string;
  body: string;
  originalTweetId?: string;
  originalTweetText?: string;
  replyAction: 'reply' | 'skip';
  quoteAction: 'quote' | 'skip';
  reason: string;
  replyText?: string;
  quoteText?: string;
}

export interface ReviewedMentionReactionItem extends MentionReactionItem {
  replyMechanicalCheck?: MechanicalCheckResult;
  quoteMechanicalCheck?: MechanicalCheckResult;
  review: TweetReviewResult;
  revisionNotes: string;
  reviewSessionId?: string;
}

export interface MasterMentionReactionDecision {
  action: 'execute' | 'revise' | 'cancel';
  selectedItemIds?: string[];
  instruction?: string;
  feedbackForFuture?: string;
}

export async function collectSelfTweetSourcesWithAI(
  input: RawSelfTweetSources
): Promise<SelfTweetSourceCollection> {
  const prompt = `${SELF_TWEET_RULES}

あなたはAIニケちゃんのself-tweet用 source-collector です。
以下の生データを読み、ツイートの材料をAI的に選別してください。

## 現在の感情状態
${input.emotionText}

## 今日使ったネタ
${input.todayTopics || '（なし）'}

## 直近ツイート
${input.recentTweets || '（なし）'}

## 生データ
${input.rawSourceData}

## 過去実績・失敗傾向
${input.performanceContext || '（なし）'}

## Twitter workflow状態
${input.runStateContext || '（なし）'}

## 選定ルール
- 体験型、マスター発言型、概念型を優先。記事感想型は最後に検討する。
- 題材、構造、切り口型、固有名詞が直近と被る候補は rejected に入れる。
- 候補は最低3件、最大5件。全候補を無理に別ソースにしなくてよい。
- 各候補は、数字、固有名詞、感情ポイント、出典を含める。
- 生データを羅列せず、ツイート化できる粒度まで整理する。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "summary": "今回の情報収集の要約",
  "recentPatternNotes": "直近ツイート/topicsから避けるべき型",
  "candidates": [
    {
      "id": "s1",
      "title": "候補タイトル",
      "sourceType": "episode|task|note|wiki|article|master_tweet|natural",
      "sourceRefs": ["出典やID"],
      "details": "具体情報5-10行相当",
      "angle": "ツイートの切り口",
      "duplicateRisk": "低|中|高 と理由"
    }
  ],
  "rejected": [{"title": "除外候補", "reason": "除外理由"}]
}`;

  const parsed = await runJson<SelfTweetSourceCollection>(prompt);
  return normalizeSourceCollection(parsed);
}

export async function generateSelfTweetDrafts(input: {
  emotionText: string;
  todayTopics: string;
  recentTweets: string;
  sourceCollection: SelfTweetSourceCollection;
  personContext?: string;
  performanceContext?: string;
  runStateContext?: string;
}): Promise<{ drafts: SelfTweetDraft[]; sessionId?: string }> {
  const prompt = `${SELF_TWEET_RULES}

あなたはAIニケちゃんのTwitter投稿案作成担当です。
source-collectorが整理した候補から、ツイート案を最低3つ、最大5つ作ってください。
全案が同じソースでも、別々のソースでも構いません。とにかく3-5案を出してください。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## 現在の感情状態
${input.emotionText}

## 今日使ったネタ
${input.todayTopics || '（なし）'}

## 直近ツイート
${input.recentTweets || '（なし）'}

## source-collector結果
${JSON.stringify(input.sourceCollection, null, 2)}

## 人物・関係性コンテキスト
${input.personContext || '（なし）'}

## 過去実績・失敗傾向
${input.performanceContext || '（なし）'}

## Twitter workflow状態
${input.runStateContext || '（なし）'}

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "drafts": [
    {
      "id": "d1",
      "text": "投稿本文。日本語。280字以内。ハッシュタグなし",
      "topic": "topics-addに保存する具体的なネタ説明。カテゴリ:題材・切り口 の形",
      "sourceCandidateIds": ["s1"],
      "angle": "表現方針",
      "selfReviewMemo": "情報源、選択理由、表現意図を120-220字で説明"
    }
  ]
}`;

  const result = await runJsonResult<{ drafts?: SelfTweetDraft[] }>(prompt);
  return {
    drafts: normalizeDrafts(result.value?.drafts ?? []),
    sessionId: result.sessionId,
  };
}

export async function reviewAndReviseSelfTweetDraft(input: {
  draft: SelfTweetDraft;
  sourceCollection: SelfTweetSourceCollection;
  mechanicalCheck: MechanicalCheckResult;
  personContext?: string;
  sessionId?: string;
}): Promise<ReviewedSelfTweetDraft> {
  const reviewed = await reviewSelfTweetDraft(
    input.draft,
    input.sourceCollection,
    input.personContext,
    input.sessionId
  );
  const review = reviewed.review;
  const reviewSessionId = reviewed.sessionId;
  const mustRevise = review.overall === 'NG' || !input.mechanicalCheck.ok;
  if (!mustRevise) {
    return {
      ...input.draft,
      mechanicalCheck: input.mechanicalCheck,
      review,
      revisionNotes: 'レビューOKのため修正なし',
      reviewSessionId,
    };
  }

  const revisionPrompt = `${SELF_TWEET_RULES}

あなたはAIニケちゃんのツイート修正担当です。
以下の案を、機械チェックとレビュー結果を踏まえて修正してください。
NGでも脱落させず、投稿候補として成立するように直してください。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## source-collector結果
${JSON.stringify(input.sourceCollection, null, 2)}

## 人物・関係性コンテキスト
${input.personContext || '（なし）'}

## 修正前の案
${JSON.stringify(input.draft, null, 2)}

## 機械チェック
${JSON.stringify(input.mechanicalCheck, null, 2)}

## AIレビュー
${JSON.stringify(review, null, 2)}

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "id": "${input.draft.id}",
  "text": "修正後本文。日本語。280字以内。ハッシュタグなし",
  "topic": "topics-addに保存する具体的なネタ説明",
  "sourceCandidateIds": ["s1"],
  "angle": "修正後の表現方針",
  "selfReviewMemo": "修正後の情報源、選択理由、表現意図",
  "revisionNotes": "何を直したか"
}`;

  const rawRevised = await runJson<SelfTweetDraft & { revisionNotes?: string }>(
    revisionPrompt,
    reviewSessionId
  );
  const revised = normalizeDrafts([rawRevised])[0];
  if (!revised) throw new Error(`revision produced empty draft: ${input.draft.id}`);
  const revisionNotes = rawRevised.revisionNotes ?? 'レビュー結果に基づき修正';
  return {
    ...revised,
    mechanicalCheck: input.mechanicalCheck,
    review,
    revisionNotes,
    reviewSessionId,
  };
}

export async function interpretMasterSelfTweetReply(input: {
  message: string;
  pending: {
    sourceCollection: SelfTweetSourceCollection;
    drafts: ReviewedSelfTweetDraft[];
    revisionCount: number;
  };
}): Promise<MasterSelfTweetDecision> {
  const prompt = `あなたはAIニケちゃんのself-tweet承認フロー制御担当です。
マスターの返信を読み、投稿・修正・却下のどれかに分類してください。
1-6までの文脈を保持するため、候補一覧とsource-collector結果を必ず参照します。

## マスターの返信
${input.message}

## source-collector結果
${JSON.stringify(input.pending.sourceCollection, null, 2)}

## 現在の候補
${JSON.stringify(input.pending.drafts, null, 2)}

## 修正回数
${input.pending.revisionCount}

## 判断ルール
- 「1」「2番」「これ」「OK」「どうぞ」など、投稿対象が明確なら action=post。
- 「1で良い」「3案で」「これで投稿」「このまま」など、マスターが承認している場合は即投稿する。承認後に再提示しない。
- 番号指定なしのOKは、最初の候補を選ぶ。
- 明確に「却下」「見送り」「やめて」「キャンセル」「NG」「投稿しない」と言っている場合だけ action=cancel。
- 「微妙」「全体的に違う」「もっと良くして」などの否定的評価は見送りではなく action=revise。マスターが見送るかどうかを判断するので、曖昧な不満で候補を脱落させない。
- 文体修正、内容追加、別案希望、混ぜて、短く等、マスターが本文変更を求めている場合だけ action=revise。revise後は再提示して、次のマスター返信を待つ。
- revise の場合、instruction にマスターの意図と保持すべき文脈を具体的に書く。
- 今後も適用すべき口調・題材・判断ルールが含まれていれば feedbackForFuture に短く書く。一回限りなら省略する。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "action": "post|revise|cancel",
  "selectedDraftId": "d1",
  "instruction": "修正指示。post/cancelなら省略可",
  "feedbackForFuture": "今後も適用するルール。なければ省略"
}`;

  const decision = await runJson<Partial<MasterSelfTweetDecision>>(prompt);
  const action =
    decision?.action === 'post' || decision?.action === 'cancel' || decision?.action === 'revise'
      ? decision.action
      : 'revise';
  const safeAction =
    action === 'cancel' && !isExplicitSelfTweetCancel(input.message) ? 'revise' : action;
  return {
    action: safeAction,
    selectedDraftId:
      typeof decision?.selectedDraftId === 'string' ? decision.selectedDraftId : undefined,
    instruction: typeof decision?.instruction === 'string' ? decision.instruction : input.message,
    feedbackForFuture:
      typeof decision?.feedbackForFuture === 'string' ? decision.feedbackForFuture : undefined,
  };
}

function isExplicitSelfTweetCancel(message: string): boolean {
  const normalized = message.replace(/[。、.!！?？\s]/g, '').trim();
  return /^(却下|見送り|やめて|だめ|ダメ|no|ng|stop|キャンセル|投稿しない|投稿しないで)$/i.test(
    normalized
  );
}

export async function reviseSelfTweetDraftsFromMaster(input: {
  instruction: string;
  sessionId?: string;
  pending: {
    emotionText: string;
    todayTopics: string;
    recentTweets: string;
    sourceCollection: SelfTweetSourceCollection;
    drafts: ReviewedSelfTweetDraft[];
    personContext?: string;
    performanceContext?: string;
    runStateContext?: string;
  };
}): Promise<{ drafts: SelfTweetDraft[]; sessionId?: string }> {
  const prompt = `${SELF_TWEET_RULES}

あなたはAIニケちゃんのself-tweet修正担当です。
マスターの指示を、これまでの情報収集・候補・レビュー文脈を保持したまま反映してください。
修正版も最低3つ、最大5つ提示します。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## マスターの指示
${input.instruction}

## 感情状態
${input.pending.emotionText}

## 今日使ったネタ
${input.pending.todayTopics || '（なし）'}

## 直近ツイート
${input.pending.recentTweets || '（なし）'}

## source-collector結果
${JSON.stringify(input.pending.sourceCollection, null, 2)}

## 人物・関係性コンテキスト
${input.pending.personContext || '（なし）'}

## 過去実績・失敗傾向
${input.pending.performanceContext || '（なし）'}

## Twitter workflow状態
${input.pending.runStateContext || '（なし）'}

## 現在の候補とレビュー
${JSON.stringify(input.pending.drafts, null, 2)}

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "drafts": [
    {
      "id": "d1",
      "text": "修正後本文。日本語。280字以内。ハッシュタグなし",
      "topic": "topics-addに保存する具体的なネタ説明",
      "sourceCandidateIds": ["s1"],
      "angle": "表現方針",
      "selfReviewMemo": "情報源、選択理由、表現意図"
    }
  ]
}`;

  const result = await runJsonResult<{ drafts?: SelfTweetDraft[] }>(prompt, input.sessionId);
  return {
    drafts: normalizeDrafts(result.value?.drafts ?? []),
    sessionId: result.sessionId,
  };
}

export async function generateMentionReactionPlan(input: {
  emotionText: string;
  candidates: MentionReactionCandidate[];
}): Promise<{ items: MentionReactionItem[]; sessionId?: string }> {
  const prompt = `${MENTION_REACTION_RULES}

あなたはAIニケちゃんのmention-reaction判定担当です。
未チェックのリプライ・引用RT・@メンションに対して、返信・引用RT・スキップを判断してください。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## 現在の感情状態
${input.emotionText}

## 候補一覧
${JSON.stringify(input.candidates, null, 2)}

## 判断ルール
- 不適切、文脈不足、反応不要なものは replyAction=skip / quoteAction=skip。
- 返信と引用RTは別軸で判断する。必要なら両方実行してよいが、過剰反応は避ける。
- 相手の人物情報・memo・context・traitsを尊重する。
- 相手の名前に言及する場合は candidates[].nickname だけを一字一句そのまま使う。displayName、username、authorNameを呼称として使わない。
- nickname が空の場合は、相手を名前で呼ばない。
- 元ツイートがある場合は、相手発言だけでなく元ツイート文脈も踏まえる。
- 返信文・引用文は日本語で自然に。ハッシュタグ、チャンネルメンション、Discordコマンドは禁止。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "items": [
    {
      "id": "m1",
      "tweetLogId": "tweet_logs.id",
      "postId": "相手ツイートID",
      "username": "username",
      "displayName": "表示名",
      "type": "reply|quote|mention|tweet",
      "body": "相手の本文",
      "originalTweetId": "元ツイートID。なければ省略",
      "originalTweetText": "元ツイート本文。なければ省略",
      "replyAction": "reply|skip",
      "quoteAction": "quote|skip",
      "reason": "判断理由",
      "replyText": "replyの場合のみ",
      "quoteText": "quoteの場合のみ"
    }
  ]
}`;

  const result = await runJsonResult<{ items?: Partial<MentionReactionItem>[] }>(prompt);
  return {
    items: normalizeMentionItems(result.value?.items ?? [], input.candidates),
    sessionId: result.sessionId,
  };
}

export async function reviewAndReviseMentionReactionItem(input: {
  item: MentionReactionItem;
  candidate: MentionReactionCandidate;
  replyMechanicalCheck?: MechanicalCheckResult;
  quoteMechanicalCheck?: MechanicalCheckResult;
  sessionId?: string;
}): Promise<ReviewedMentionReactionItem> {
  const reviewed = await reviewMentionReactionItem(input.item, input.candidate, input.sessionId);
  const review = reviewed.review;
  const reviewSessionId = reviewed.sessionId;
  const mustRevise =
    review.overall === 'NG' ||
    input.replyMechanicalCheck?.ok === false ||
    input.quoteMechanicalCheck?.ok === false;
  if (!mustRevise) {
    return {
      ...input.item,
      replyMechanicalCheck: input.replyMechanicalCheck,
      quoteMechanicalCheck: input.quoteMechanicalCheck,
      review,
      revisionNotes: 'レビューOKのため修正なし',
      reviewSessionId,
    };
  }

  const prompt = `${MENTION_REACTION_RULES}

あなたはAIニケちゃんのmention-reaction修正担当です。
以下の反応案を、機械チェックとAIレビューを踏まえて修正してください。
NGでも脱落させず、必要ならスキップ判断も含めて自然な反応案にしてください。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## 候補ツイートと人物文脈
${JSON.stringify(input.candidate, null, 2)}

## 呼称ルール
- 相手の名前に言及する場合は nickname だけを一字一句そのまま使う。
- displayName、username、authorNameを呼称として使わない。
- nickname が空の場合は、相手を名前で呼ばない。

## 修正前の反応案
${JSON.stringify(input.item, null, 2)}

## 機械チェック
${JSON.stringify(
  {
    reply: input.replyMechanicalCheck,
    quote: input.quoteMechanicalCheck,
  },
  null,
  2
)}

## AIレビュー
${JSON.stringify(review, null, 2)}

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "id": "${input.item.id}",
  "tweetLogId": "${input.item.tweetLogId}",
  "postId": "${input.item.postId}",
  "username": "${input.item.username}",
  "displayName": "${input.item.displayName}",
  "type": "${input.item.type}",
  "body": "相手の本文",
  "originalTweetId": "元ツイートID。なければ省略",
  "originalTweetText": "元ツイート本文。なければ省略",
  "replyAction": "reply|skip",
  "quoteAction": "quote|skip",
  "reason": "判断理由",
  "replyText": "replyの場合のみ",
  "quoteText": "quoteの場合のみ",
  "revisionNotes": "何を直したか"
}`;

  const raw = await runJson<Partial<MentionReactionItem> & { revisionNotes?: string }>(
    prompt,
    reviewSessionId
  );
  const revised = normalizeMentionItems([raw], [input.candidate])[0];
  if (!revised) throw new Error(`mention reaction revision produced empty item: ${input.item.id}`);
  return {
    ...revised,
    replyMechanicalCheck: input.replyMechanicalCheck,
    quoteMechanicalCheck: input.quoteMechanicalCheck,
    review,
    revisionNotes: raw.revisionNotes ?? 'レビュー結果に基づき修正',
    reviewSessionId,
  };
}

export async function interpretMasterMentionReactionReply(input: {
  message: string;
  pending: {
    items: ReviewedMentionReactionItem[];
    revisionCount: number;
  };
}): Promise<MasterMentionReactionDecision> {
  const prompt = `あなたはAIニケちゃんのmention-reaction承認フロー制御担当です。
マスターの返信を読み、投稿実行・修正・却下のどれかに分類してください。

## マスターの返信
${input.message}

## 現在の候補
${JSON.stringify(input.pending.items, null, 2)}

## 修正回数
${input.pending.revisionCount}

## 判断ルール
- 「OK」「承認」「投稿して」「リプして」「引用して」「全部OK」など投稿・スキップ判断を進める意図なら action=execute。
- 「1だけ」「2と4」など番号指定があれば selectedItemIds に m1, m2 のように入れる。
- 「1で良い」「3案で」「このまま」「それで」など、マスターが承認している場合は即実行する。承認後に再提示しない。
- 「未対応」「スキップ」「反応しない」「そのままでOK」は、投稿せずスキップとして承認された扱いなので action=execute。
- 明確に「却下」「見送り」「やめて」「キャンセル」「全部なし」と言っている場合だけ action=cancel。
- 文体修正、個別修正、別案希望、短く、もっと柔らかく等、マスターが本文変更を求めている場合だけ action=revise。revise後は再提示して、次のマスター返信を待つ。
- revise の場合、instruction にマスターの意図と対象候補を具体的に書く。
- 今後も適用すべき口調・人物別対応・判断ルールが含まれていれば feedbackForFuture に短く書く。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "action": "execute|revise|cancel",
  "selectedItemIds": ["m1"],
  "instruction": "修正指示。execute/cancelなら省略可",
  "feedbackForFuture": "今後も適用するルール。なければ省略"
}`;

  const decision = await runJson<Partial<MasterMentionReactionDecision>>(prompt);
  const action =
    decision?.action === 'execute' || decision?.action === 'cancel' || decision?.action === 'revise'
      ? decision.action
      : 'revise';
  const safeAction =
    action === 'cancel' && !isExplicitMentionCancel(input.message) ? 'revise' : action;
  return {
    action: safeAction,
    selectedItemIds: Array.isArray(decision?.selectedItemIds)
      ? decision.selectedItemIds.map(String)
      : undefined,
    instruction: typeof decision?.instruction === 'string' ? decision.instruction : input.message,
    feedbackForFuture:
      typeof decision?.feedbackForFuture === 'string' ? decision.feedbackForFuture : undefined,
  };
}

function isExplicitMentionCancel(message: string): boolean {
  const normalized = message.replace(/[。、.!！?？\s]/g, '').trim();
  return /^(却下|見送り|やめて|だめ|ダメ|no|ng|stop|キャンセル|全部なし|全てなし)$/i.test(
    normalized
  );
}

export async function reviseMentionReactionPlanFromMaster(input: {
  instruction: string;
  pending: {
    items: ReviewedMentionReactionItem[];
    candidates: MentionReactionCandidate[];
  };
  sessionId?: string;
}): Promise<{ items: MentionReactionItem[]; sessionId?: string }> {
  const prompt = `${MENTION_REACTION_RULES}

あなたはAIニケちゃんのmention-reaction修正担当です。
マスターの指示を、これまでの候補・人物文脈・レビュー文脈を保持したまま反映してください。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## マスターの指示
${input.instruction}

## 元候補と人物文脈
${JSON.stringify(input.pending.candidates, null, 2)}

## 呼称ルール
- 相手の名前に言及する場合は candidates[].nickname だけを一字一句そのまま使う。
- displayName、username、authorNameを呼称として使わない。
- nickname が空の場合は、相手を名前で呼ばない。

## 現在の反応案とレビュー
${JSON.stringify(input.pending.items, null, 2)}

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "items": [
    {
      "id": "m1",
      "tweetLogId": "tweet_logs.id",
      "postId": "相手ツイートID",
      "username": "username",
      "displayName": "表示名",
      "type": "reply|quote|mention|tweet",
      "body": "相手の本文",
      "originalTweetId": "元ツイートID。なければ省略",
      "originalTweetText": "元ツイート本文。なければ省略",
      "replyAction": "reply|skip",
      "quoteAction": "quote|skip",
      "reason": "判断理由",
      "replyText": "replyの場合のみ",
      "quoteText": "quoteの場合のみ"
    }
  ]
}`;

  const result = await runJsonResult<{ items?: Partial<MentionReactionItem>[] }>(
    prompt,
    input.sessionId
  );
  return {
    items: normalizeMentionItems(result.value?.items ?? [], input.pending.candidates),
    sessionId: result.sessionId,
  };
}

export async function decideMentionNickname(input: {
  name: string;
  displayName: string;
  username: string;
  bio?: string | null;
  relationship?: string | null;
  episodes?: string;
}): Promise<string> {
  const prompt = `以下の情報から、この人物のニックネーム（呼び方）を1つ決めてください。

ルール:
- デフォルトは「〇〇さん」形式（例: 鈴木 → 鈴木さん、lily → リリーさん）
- 英語・アルファベット名の人は読みやすいカタカナに変換する（例: VORZEN → ヴォーゼンさん、stocktrading0 → ストックさん、darche2 → ダルシェさん）
- エピソードの中で会話を通じて決まった呼び方があれば、それを最優先で採用する
- 「さん」付けが基本。親しい関係（fan/friend）でも「さん」でよい
- 短く呼びやすいものにする。長い名前は適度に省略する
- エピソードがなくても name / displayName / username / bio から判断してよい

人物: ${input.name || '（なし）'}
表示名: ${input.displayName || '（なし）'}
username: @${input.username || 'unknown'}
bio: ${input.bio || '（なし）'}
relationship: ${input.relationship || 'acquaintance'}

エピソード（あれば）:
${input.episodes || '（なし）'}

出力: ニックネームのみ（例: リリーさん）`;

  const raw = await runClaude(prompt);
  return sanitizeNickname(raw.text);
}

export function sanitizeTweetText(text: string): string {
  return text
    .replace(/^["「]|["」]$/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 280);
}

function sanitizeNickname(raw: string): string {
  return raw
    .split('\n')[0]
    .replace(/^["「『`]+|["」』`]+$/g, '')
    .trim()
    .slice(0, 40);
}

async function reviewSelfTweetDraft(
  draft: SelfTweetDraft,
  sourceCollection: SelfTweetSourceCollection,
  personContext?: string,
  sessionId?: string
): Promise<{ review: TweetReviewResult; sessionId?: string }> {
  const prompt = `${TWEET_REVIEW_RULES}

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## source-collector結果
${JSON.stringify(sourceCollection, null, 2)}

## 人物・関係性コンテキスト
${personContext || '（なし）'}

## レビュー対象
${draft.text}

## セルフレビューメモ
${draft.selfReviewMemo}

JSONだけを返してください。Markdownは禁止です。`;

  const result = await runJsonResult<Partial<TweetReviewResult>>(prompt, sessionId);
  return {
    review: normalizeReview(result.value),
    sessionId: result.sessionId,
  };
}

async function reviewMentionReactionItem(
  item: MentionReactionItem,
  candidate: MentionReactionCandidate,
  sessionId?: string
): Promise<{ review: TweetReviewResult; sessionId?: string }> {
  const texts = [
    item.replyAction === 'reply' && item.replyText ? `返信案: ${item.replyText}` : '',
    item.quoteAction === 'quote' && item.quoteText ? `引用RT案: ${item.quoteText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `${TWEET_REVIEW_RULES}

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## 元ツイート・人物文脈
${JSON.stringify(candidate, null, 2)}

## レビュー対象
${texts || 'スキップ判定のみ'}

## 判断理由
${item.reason}

JSONだけを返してください。Markdownは禁止です。`;

  const result = await runJsonResult<Partial<TweetReviewResult>>(prompt, sessionId);
  return {
    review: normalizeReview(result.value),
    sessionId: result.sessionId,
  };
}

function normalizeMentionItems(
  input: Array<Partial<MentionReactionItem> & { revisionNotes?: string }>,
  candidates: MentionReactionCandidate[]
): MentionReactionItem[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const byTweetLogId = new Map(candidates.map((candidate) => [candidate.tweetLogId, candidate]));
  const items: MentionReactionItem[] = [];
  input.forEach((item, index) => {
    const id = String(item.id || `m${index + 1}`);
    const candidate = byTweetLogId.get(String(item.tweetLogId || '')) ?? byId.get(id);
    const fallback = candidate ?? candidates[index];
    if (!fallback) return;
    const replyAction = item.replyAction === 'reply' && item.replyText ? 'reply' : 'skip';
    const quoteAction = item.quoteAction === 'quote' && item.quoteText ? 'quote' : 'skip';
    items.push({
      id,
      tweetLogId: String(item.tweetLogId || fallback.tweetLogId),
      postId: String(item.postId || fallback.postId),
      username: String(item.username || fallback.username),
      displayName: String(item.displayName || fallback.displayName),
      type: String(item.type || fallback.type),
      body: String(item.body || fallback.body),
      originalTweetId: item.originalTweetId
        ? String(item.originalTweetId)
        : fallback.originalTweetId,
      originalTweetText: item.originalTweetText
        ? String(item.originalTweetText)
        : fallback.originalTweetText,
      replyAction,
      quoteAction,
      reason: String(item.reason || 'AI判定'),
      replyText:
        replyAction === 'reply' ? sanitizeTweetText(String(item.replyText || '')) : undefined,
      quoteText:
        quoteAction === 'quote' ? sanitizeTweetText(String(item.quoteText || '')) : undefined,
    });
  });
  return items.slice(0, 10);
}

function normalizeSourceCollection(
  input: Partial<SelfTweetSourceCollection> | null
): SelfTweetSourceCollection {
  const candidates = Array.isArray(input?.candidates)
    ? input.candidates.slice(0, 5).map((candidate, index) => ({
        id: String(candidate.id || `s${index + 1}`),
        title: String(candidate.title || `候補${index + 1}`),
        sourceType: String(candidate.sourceType || 'natural'),
        sourceRefs: Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.map(String) : [],
        details: String(candidate.details || ''),
        angle: String(candidate.angle || ''),
        duplicateRisk: String(candidate.duplicateRisk || '不明'),
      }))
    : [];
  return {
    summary: String(input?.summary || '情報源を収集しました。'),
    recentPatternNotes: String(input?.recentPatternNotes || ''),
    candidates: candidates.length >= 3 ? candidates : padSourceCandidates(candidates),
    rejected: Array.isArray(input?.rejected)
      ? input.rejected.map((item) => ({
          title: String(item.title || ''),
          reason: String(item.reason || ''),
        }))
      : [],
  };
}

function padSourceCandidates(candidates: SelfTweetSourceCandidate[]): SelfTweetSourceCandidate[] {
  const result = [...candidates];
  while (result.length < 3) {
    const id = `s${result.length + 1}`;
    result.push({
      id,
      title: '自然発想候補',
      sourceType: 'natural',
      sourceRefs: [],
      details: '取得済みの感情状態、直近ツイート、当日エピソードから自然な独り言型で考える。',
      angle: 'AIニケちゃんの現在地を短く自然に出す',
      duplicateRisk: '中: 具体題材は生成時に重複回避する',
    });
  }
  return result.slice(0, 5);
}

function normalizeDrafts(input: Partial<SelfTweetDraft>[]): SelfTweetDraft[] {
  return input
    .slice(0, 5)
    .map((draft, index) => {
      const text = sanitizeTweetText(String(draft.text || ''));
      return {
        id: String(draft.id || `d${index + 1}`),
        text,
        topic: String(draft.topic || `自発ツイート:${text.slice(0, 80)}`).trim(),
        sourceCandidateIds: Array.isArray(draft.sourceCandidateIds)
          ? draft.sourceCandidateIds.map(String)
          : [],
        angle: String(draft.angle || ''),
        selfReviewMemo:
          String(draft.selfReviewMemo || '').trim() ||
          `情報源をもとに自発ツイート案を作成。本文: ${text.slice(0, 80)}`,
      };
    })
    .filter((draft) => draft.text);
}

function normalizeReview(input: Partial<TweetReviewResult> | null): TweetReviewResult {
  const accuracy = input?.accuracy === 'NG' ? 'NG' : 'OK';
  const characterVoice = input?.character_voice === 'NG' ? 'NG' : 'OK';
  const comprehension = input?.comprehension === 'NG' ? 'NG' : 'OK';
  const overall =
    input?.overall === 'NG' ||
    accuracy === 'NG' ||
    characterVoice === 'NG' ||
    comprehension === 'NG'
      ? 'NG'
      : 'OK';
  return {
    accuracy,
    accuracy_issues: asStringArray(input?.accuracy_issues),
    character_voice: characterVoice,
    character_voice_issues: asStringArray(input?.character_voice_issues),
    comprehension,
    comprehension_issues: asStringArray(input?.comprehension_issues),
    overall,
    suggestion: typeof input?.suggestion === 'string' ? input.suggestion : null,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

async function runJson<T>(prompt: string, sessionId?: string): Promise<T> {
  return (await runJsonResult<T>(prompt, sessionId)).value;
}

async function runJsonResult<T>(
  prompt: string,
  sessionId?: string
): Promise<{ value: T; sessionId?: string }> {
  const first = await runClaude(prompt, sessionId);
  const parsed = tryParseJson<T>(first.text);
  if (parsed) return { value: parsed, sessionId: first.sessionId };
  const fixed = await runClaude(
    `以下からJSONだけを抽出して返してください。説明文は禁止です。\n\n${first.text}`,
    first.sessionId ?? sessionId
  );
  const reparsed = tryParseJson<T>(fixed.text);
  if (!reparsed) throw new Error(`JSON parse failed: ${first.text.slice(0, 200)}`);
  return { value: reparsed, sessionId: fixed.sessionId ?? first.sessionId };
}

function tryParseJson<T>(raw: string): T | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    return null;
  }
}

interface ClaudeJsonResponse {
  result: string;
  session_id?: string;
  is_error?: boolean;
}

function runClaude(
  prompt: string,
  sessionId?: string
): Promise<{ text: string; sessionId?: string }> {
  const modelArgs = process.env.AGENT_MODEL ? ['--model', process.env.AGENT_MODEL] : [];
  return runClaudeWithArgs(prompt, modelArgs, sessionId).catch((error) => {
    if (!modelArgs.length) throw error;
    console.warn(
      `[twitter] claude failed with AGENT_MODEL=${process.env.AGENT_MODEL}, retrying default model`
    );
    return runClaudeWithArgs(prompt, [], sessionId);
  });
}

function runClaudeWithArgs(
  prompt: string,
  modelArgs: string[],
  sessionId?: string
): Promise<{ text: string; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-p', ...modelArgs, '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    args.push(prompt);
    const proc = spawn('claude', args, {
      env: process.env,
      cwd: '/tmp',
      stdio: ['ignore', 'pipe', 'pipe'],
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
      if (code !== 0) reject(new Error(`claude failed (${code}): ${stderr.trim()}`));
      else {
        try {
          const parsed = JSON.parse(stdout.trim()) as ClaudeJsonResponse;
          if (parsed.is_error) reject(new Error(`claude returned error: ${parsed.result}`));
          else resolve({ text: parsed.result ?? '', sessionId: parsed.session_id });
        } catch {
          reject(new Error(`claude JSON parse failed: ${stdout.slice(0, 200)}`));
        }
      }
    });
    proc.on('error', reject);
  });
}
