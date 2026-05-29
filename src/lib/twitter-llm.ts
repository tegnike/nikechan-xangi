import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runCodexHelper, shouldUseCodexHelper } from './agent-cli.js';
import { buildNikechanCorePrompt } from './nikechan-core.js';

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
const HASHTAG_REACTION_RULES = readPrompt(
  '.agents/skills/twitter-post/prompts/hashtag-reaction.md',
  '#AIニケちゃん タグ付きツイートをRTするか判断する。'
);

export interface RawSelfTweetSources {
  emotionText: string;
  todayTopics: string;
  recentTweets: string;
  rawSourceData: string;
  sourceMode?: string;
  presentedTopicCooldown?: string;
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
  action: 'post' | 'revise' | 'cancel' | 'chat';
  selectedDraftId?: string;
  instruction?: string;
  responseMessage?: string;
  feedbackForFuture?: string;
  sessionId?: string;
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
  action: 'execute' | 'revise' | 'cancel' | 'chat';
  selectedItemIds?: string[];
  instruction?: string;
  responseMessage?: string;
  feedbackForFuture?: string;
  sessionId?: string;
}

export interface HashtagReactionCandidate {
  id: string;
  tweetLogId: string;
  postId: string;
  authorUserId?: string;
  username: string;
  displayName: string;
  authorName?: string;
  nickname?: string;
  body: string;
  createdAt?: string;
  hashtags: string[];
  personContext: string;
  mediaContext: string;
}

export interface HashtagReactionItem {
  id: string;
  tweetLogId: string;
  postId: string;
  username: string;
  displayName: string;
  body: string;
  action: 'retweet' | 'skip';
  reason: string;
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

## 今回の情報源モード
${input.sourceMode || 'standard'}

## 最近提示済み候補（24-72時間クールダウン）
${input.presentedTopicCooldown || '（なし）'}

## 生データ
${input.rawSourceData}

## 過去実績・失敗傾向
${input.performanceContext || '（なし）'}

## Twitter workflow状態
${input.runStateContext || '（なし）'}

## 選定ルール
- 候補タイプを分散する。体験型、マスター発言型、概念型、観察メモ型、短文反応型、記事の一点反応型から偏らず選ぶ。
- 同じ話題・同じ出来事・同じ固有名詞を中心にした候補は最大2件まで。同じ話題を言い換えただけの候補を3件以上並べない。
- 候補は最低3件、最大5件。可能な限り3つ以上の異なる話題を入れる。
- 生データが1話題に偏っている場合でも、感情状態・曜日感覚・直近TL観察から sourceType=natural の自然発想候補を1件入れて分散する。
- 「外部の出来事を自分ごとに変換して内省で着地する」候補ばかりにしない。自己言及なしで成立する題材も候補に残す。
- 最近提示済み候補に含まれる話題は、投稿されていなくても消費済みとして扱い、原則 rejected に入れる。新しい事実・進展・強い別角度がある場合だけ候補に残す。
- sourceType は分散する。5件中 master_tweet は最大1件、episode は最大2件を目安にし、可能なら article|wiki|note|natural から最低1件を入れる。
- 題材、構造、切り口型、固有名詞が直近と被る候補は rejected に入れる。
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
本文を書く前に案ごとの題材・構成・sourceCandidateIdsを分散し、とにかく3-5案を出してください。
source-collector候補が3件以上ある場合、最低3つの異なる sourceCandidateIds を使ってください。同じ sourceCandidateId を主題にした案は最大2件までです。
同じ話題を言い換えただけの案を複数出さないでください。候補が似ている場合は、natural候補や直近の空気感からの短文案を混ぜてください。
natural候補のdetailsに「主題にしない」と書かれた語がある場合、その語を本文・topic・angleの主題にしないでください。
angle は「観察メモ型」「短文反応型」「ボケ・逆張り型」のような構成タイプを書き、レビューや修正方針を書かないでください。
「事実 → 自分ごと化 → 内省で着地」の構成ばかりにしないでください。観察メモ、短文反応、問いで止める案、ボケ・逆張り案も混ぜてください。

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
      "angle": "表現方針。構成タイプも含める（例: 観察メモ型、短文反応型、概念再定義型）",
      "selfReviewMemo": "情報源、選択理由、表現意図を120-220字で説明"
    }
  ]
}`;

  const result = await runJsonResult<{ drafts?: SelfTweetDraft[] }>(prompt);
  const drafts = repairDraftDiversity(
    normalizeDrafts(result.value?.drafts ?? []),
    input.sourceCollection,
    input.emotionText
  );
  if (!hasDraftSourceDiversity(drafts, input.sourceCollection)) {
    const retry = await runJsonResult<{ drafts?: SelfTweetDraft[] }>(
      `${prompt}

## 追加制約
前回の案は同じソース・同じ話題に偏っていました。必ず作り直してください。
- 最低3案は異なる sourceCandidateIds を使う
- 同じ主題の言い換えを並べない
- 1案は短文反応・観察メモ・余白型のどれかにする
- angle には修正方針ではなく構成タイプだけを書く`,
      result.sessionId
    );
    const retryDrafts = repairDraftDiversity(
      normalizeDrafts(retry.value?.drafts ?? []),
      input.sourceCollection,
      input.emotionText
    );
    if (hasDraftSourceDiversity(retryDrafts, input.sourceCollection)) {
      return {
        drafts: retryDrafts,
        sessionId: retry.sessionId,
      };
    }
  }
  return {
    drafts,
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
  "angle": "構成タイプ（例: 観察メモ型、短文反応型、事実→着地型）。修正方針は書かない",
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
  const hasValidSources = revised.sourceCandidateIds.length > 0;
  const angle =
    revised.angle && !/修正|方針|レビュー/.test(revised.angle) ? revised.angle : input.draft.angle;
  return {
    ...revised,
    sourceCandidateIds: hasValidSources
      ? revised.sourceCandidateIds
      : input.draft.sourceCandidateIds,
    angle,
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
  sessionId?: string;
}): Promise<MasterSelfTweetDecision> {
  const prompt = `あなたはAIニケちゃんのself-tweet承認フロー制御担当です。
マスターの返信を読み、投稿・修正・却下・通常返答のどれかに分類してください。
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
- 質問、確認、雑談、根拠確認、ログ確認、ソース確認が含まれる場合は action=chat。たとえ「3案いいね」のような好意的な評価が含まれていても、質問に答えるだけで投稿しない。
- 「実際に〜したログある？」「これは本当？」「どういう意味？」「なぜ？」のような確認は action=chat。
- 「1」「2番」「これ」「OK」「どうぞ」など、投稿対象が明確で、本文変更の指示がなければ action=post。
- 「1で良い」「3案で」「これで投稿」「このまま」など、マスターが承認していて、本文変更の指示がなければ即投稿する。承認後に再提示しない。
- 番号指定なしのOKは、最初の候補を選ぶ。
- 明確に「却下」「見送り」「スキップ」「今回はなし」「やめて」「キャンセル」「NG」「投稿しない」と言っている場合は action=cancel。
- 「全体的に分かりづらいのでスキップ」「スキップだって」「今回は見送り」「今回はやめておく」「投稿しなくていい」は修正指示ではなく action=cancel。
- 「微妙」「全体的に違う」「もっと良くして」などの否定的評価は見送りではなく action=revise。マスターが見送るかどうかを判断するので、曖昧な不満で候補を脱落させない。
- 文体修正、内容追加、別案希望、混ぜて、短く等、マスターが本文変更を求めている場合だけ action=revise。revise後は再提示して、次のマスター返信を待つ。
- 「2つめが良いけど、最後の文は要らない」のように番号・順番で特定案を指定して修正している場合、action=revise かつ selectedDraftId に該当案IDを入れる。
- revise の場合、instruction にマスターの意図と保持すべき文脈を具体的に書く。
- revise の場合、responseMessage にマスターへ返す短い自然な前置き文を書く。例: "承知しました。案2だけ直すと、これでどうでしょうか。"
- cancel の場合、responseMessage にマスターへ返す短い自然な返答を書く。マスターの文脈に合わせ、定型文だけにしない。
- chat の場合、responseMessage にマスターへの自然な返答を書く。候補・source-collector・レビュー文脈から答え、承認待ちは維持する。
- 今後も適用すべき口調・題材・判断ルールが含まれていれば feedbackForFuture に短く書く。一回限りなら省略する。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "action": "post|revise|cancel|chat",
  "selectedDraftId": "d1",
  "instruction": "修正指示。post/cancel/chatなら省略可",
  "responseMessage": "revise/cancel/chat時にDiscordへ返す短い文。postなら省略可",
  "feedbackForFuture": "今後も適用するルール。なければ省略"
}`;

  const result = await runJsonResult<Partial<MasterSelfTweetDecision>>(prompt, input.sessionId);
  const decision = result.value;
  const action =
    decision?.action === 'post' ||
    decision?.action === 'cancel' ||
    decision?.action === 'revise' ||
    decision?.action === 'chat'
      ? decision.action
      : 'revise';
  return {
    action,
    selectedDraftId:
      typeof decision?.selectedDraftId === 'string' ? decision.selectedDraftId : undefined,
    instruction: typeof decision?.instruction === 'string' ? decision.instruction : input.message,
    responseMessage:
      typeof decision?.responseMessage === 'string' ? decision.responseMessage : undefined,
    feedbackForFuture:
      typeof decision?.feedbackForFuture === 'string' ? decision.feedbackForFuture : undefined,
    sessionId: result.sessionId,
  };
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
修正版も最低3つ、最大5つ提示します。本文を書く前に案ごとの構成を分散し、「事実 → 自分ごと化 → 内省で着地」だけに寄せないでください。

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

export async function reviseSingleSelfTweetDraftFromMaster(input: {
  instruction: string;
  targetDraft: ReviewedSelfTweetDraft;
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
}): Promise<{ draft: SelfTweetDraft; revisionNotes?: string; sessionId?: string }> {
  const prompt = `${SELF_TWEET_RULES}

あなたはAIニケちゃんのself-tweet修正担当です。
マスターは特定の案だけを修正するよう指示しています。
対象案だけを直してください。他の案を作り直したり、別案を追加したりしないでください。

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

## 全候補の文脈
${JSON.stringify(input.pending.drafts, null, 2)}

## 修正対象
${JSON.stringify(input.targetDraft, null, 2)}

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "id": "${input.targetDraft.id}",
  "text": "修正後本文。日本語。280字以内。ハッシュタグなし",
  "topic": "topics-addに保存する具体的なネタ説明",
  "sourceCandidateIds": ["s1"],
  "angle": "表現方針",
  "selfReviewMemo": "情報源、選択理由、表現意図",
  "revisionNotes": "マスター指示をどう反映したか"
}`;

  const result = await runJsonResult<SelfTweetDraft & { revisionNotes?: string }>(
    prompt,
    input.sessionId
  );
  const draft = normalizeDrafts([{ ...result.value, id: input.targetDraft.id }])[0];
  if (!draft) throw new Error(`targeted revision produced empty draft: ${input.targetDraft.id}`);
  return {
    draft,
    revisionNotes:
      typeof result.value.revisionNotes === 'string' ? result.value.revisionNotes : undefined,
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
- 挨拶への返答は会話として自然にする。「おかえりなさい」に「おかえりなさい」と返さず、「ただいま」「戻りました」「迎えてくれてありがとう」など受け取る側の返事にする。
- 「ありがとう」に「ありがとう」だけを返すなど、相手の挨拶・感謝をそのまま反復しない。
- 「復帰おめでとう」への返答は、復帰した本人として「ありがとうございます」と返す。「戻ってきてくれてありがとう」のように主語を逆転させない。
- 品質指摘・システム見直し・運用不具合への言及は、原則として公開反応しない。マスターからの内輪の運用指摘はスキップを優先する。
- 返信文と引用RT文を同じにしない。同じ文しか出せない場合は引用RTをスキップする。
- 自分の直前投稿に含まれる曖昧な語へ「それ何？」と聞かれた場合は、相手側の活動として勝手に定義しない。まず「言い方がふわっとしていた」と補い、自分が何をするつもりだったかを具体的に説明する。
- 「タグ活動」は、ニケちゃん側がタグ付き投稿を見つける・見る・RTする・お礼を返す行動として説明する。投稿者にタグ付けを促す意味へ勝手に広げない。

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
  const secondReview = await reviewMentionReactionItem(revised, input.candidate, reviewSessionId);
  if (secondReview.review.overall === 'NG') {
    return {
      ...revised,
      replyAction: 'skip',
      quoteAction: 'skip',
      replyText: undefined,
      quoteText: undefined,
      reason: `レビューNGのため自動スキップ: ${
        secondReview.review.suggestion ||
        [
          ...secondReview.review.accuracy_issues,
          ...secondReview.review.character_voice_issues,
          ...secondReview.review.comprehension_issues,
        ].join(' / ') ||
        '反応案の品質が基準未達'
      }`,
      replyMechanicalCheck: input.replyMechanicalCheck,
      quoteMechanicalCheck: input.quoteMechanicalCheck,
      review: secondReview.review,
      revisionNotes: raw.revisionNotes
        ? `${raw.revisionNotes}。再レビューNGのためスキップ`
        : 'レビュー結果に基づき修正したが、再レビューNGのためスキップ',
      reviewSessionId: secondReview.sessionId ?? reviewSessionId,
    };
  }
  return {
    ...revised,
    replyMechanicalCheck: input.replyMechanicalCheck,
    quoteMechanicalCheck: input.quoteMechanicalCheck,
    review: secondReview.review,
    revisionNotes: raw.revisionNotes ?? 'レビュー結果に基づき修正',
    reviewSessionId: secondReview.sessionId ?? reviewSessionId,
  };
}

export async function interpretMasterMentionReactionReply(input: {
  message: string;
  pending: {
    items: ReviewedMentionReactionItem[];
    revisionCount: number;
  };
  sessionId?: string;
}): Promise<MasterMentionReactionDecision> {
  const prompt = `あなたはAIニケちゃんのmention-reaction承認フロー制御担当です。
マスターの返信を読み、投稿実行・修正・却下・通常返答のどれかに分類してください。

## マスターの返信
${input.message}

## 現在の候補
${JSON.stringify(input.pending.items, null, 2)}

## 修正回数
${input.pending.revisionCount}

## 判断ルール
- 質問、確認、雑談、根拠確認、ログ確認、ソース確認が含まれる場合は action=chat。好意的な評価が含まれていても、投稿実行せず質問に答える。
- 「実際に〜したログある？」「これは本当？」「どういう意味？」「なぜ？」のような確認は action=chat。
- 「OK」「承認」「投稿して」「リプして」「引用して」「全部OK」など投稿・スキップ判断を進める意図なら action=execute。
- 「1だけ」「2と4」など番号指定があれば selectedItemIds に m1, m2 のように入れる。
- 「1で良い」「3案で」「このまま」「それで」など、マスターが承認している場合は即実行する。承認後に再提示しない。
- 「最終案を見せて」「候補をもう一度」「現在の案を再掲」など、承認待ち候補の再提示要求は action=chat。投稿実行しない。
- 全体に対して「未対応」「スキップ」「反応しない」「全部なし」と言っている場合は action=cancel。
- 明確に「却下」「見送り」「今回はなし」「やめて」「キャンセル」と言っている場合は action=cancel。
- 「スキップしないでリプして」「2はスキップ、1はリプ」のように個別の実行内容を指定している場合は action=execute または action=revise として文脈から判断する。
- 文体修正、個別修正、別案希望、短く、もっと柔らかく等、マスターが本文変更を求めている場合だけ action=revise。revise後は再提示して、次のマスター返信を待つ。
- revise の場合、instruction にマスターの意図と対象候補を具体的に書く。
- cancel の場合、responseMessage にマスターへ返す短い自然な返答を書く。マスターの文脈に合わせ、定型文だけにしない。
- chat の場合、responseMessage にマスターへの自然な返答を書く。候補・人物文脈・レビュー文脈から答え、承認待ちは維持する。
- 今後も適用すべき口調・人物別対応・判断ルールが含まれていれば feedbackForFuture に短く書く。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "action": "execute|revise|cancel|chat",
  "selectedItemIds": ["m1"],
  "instruction": "修正指示。execute/cancel/chatなら省略可",
  "responseMessage": "cancel/chat時にDiscordへ返す短い文。execute/reviseなら省略可",
  "feedbackForFuture": "今後も適用するルール。なければ省略"
}`;

  const result = await runJsonResult<Partial<MasterMentionReactionDecision>>(
    prompt,
    input.sessionId
  );
  const decision = result.value;
  const action =
    decision?.action === 'execute' ||
    decision?.action === 'cancel' ||
    decision?.action === 'revise' ||
    decision?.action === 'chat'
      ? decision.action
      : 'revise';
  return {
    action,
    selectedItemIds: Array.isArray(decision?.selectedItemIds)
      ? decision.selectedItemIds.map(String)
      : undefined,
    instruction: typeof decision?.instruction === 'string' ? decision.instruction : input.message,
    responseMessage:
      typeof decision?.responseMessage === 'string' ? decision.responseMessage : undefined,
    feedbackForFuture:
      typeof decision?.feedbackForFuture === 'string' ? decision.feedbackForFuture : undefined,
    sessionId: result.sessionId,
  };
}

export async function generateMasterReplyInterpretationRecovery(input: {
  workflow: 'self-tweet' | 'mention-reaction';
  message: string;
  error: string;
}): Promise<string> {
  const workflowLabel = input.workflow === 'self-tweet' ? '自発ツイート' : 'メンション反応';
  const prompt = `${CHARACTER_BASE}

${CHARACTER_TWITTER}

あなたはAIニケちゃんです。
${workflowLabel}の承認スレッドで、マスターの返信を処理しようとしましたが、一時的に処理が完了しませんでした。

## マスターの返信
${input.message}

## 内部エラー
${input.error}

## 返答ルール
- 機械的なエラー文、スタックトレース、内部関数名は出さない。
- マスターの返信内容を勝手に承認・却下・修正として処理したことにしない。
- 承認待ちの状態は維持されている前提で、マスターに短く自然に返す。
- 本文は1〜2文。丁寧語。絵文字は使わない。
- 「もう一度同じ内容を送ってください」とだけ言うのではなく、状況に合う自然な言い方にする。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "message": "Discordに返す短い本文"
}`;

  const response = await runJson<{ message?: string }>(prompt);
  const message = String(response?.message || '').trim();
  if (!message) throw new Error('recovery reply is empty');
  return message.slice(0, 500);
}

export async function generateSelfTweetCompletionReply(input: {
  masterMessage: string;
  draft: ReviewedSelfTweetDraft;
  result: string;
  dryRun: boolean;
  sessionId?: string;
}): Promise<{ message: string; sessionId?: string }> {
  const prompt = `${CHARACTER_BASE}

${CHARACTER_TWITTER}

あなたはAIニケちゃんです。
self-tweet承認スレッドで、マスターの返信を受けて投稿処理が完了しました。
Discordに返す本文を自然に作ってください。

## マスターの返信
${input.masterMessage}

## 投稿した案
${JSON.stringify(input.draft, null, 2)}

## 投稿結果
dryRun=${input.dryRun}
${input.result || '（URLなし）'}

## 返答ルール
- 固定文の「投稿しました。」だけで済ませない。
- マスターの返信に含まれていた意図に短く触れる。
- 投稿URLがあれば必ず含める。
- 本文は1〜3文。必要ならURLは別行。
- 内部関数名やJSONは出さない。

## 出力
JSONだけを返してください。Markdownは禁止です。

{"message":"Discordに返す本文"}`;

  const result = await runJsonResult<{ message?: string }>(prompt, input.sessionId);
  return {
    message: String(result.value?.message || '')
      .trim()
      .slice(0, 1000),
    sessionId: result.sessionId,
  };
}

export async function generateMentionReactionCompletionReply(input: {
  masterMessage: string;
  items: ReviewedMentionReactionItem[];
  summary: string;
  results: Array<{
    item_id: string;
    action: string;
    reply_url?: string;
    quote_url?: string;
    error?: string;
  }>;
  dryRun: boolean;
  sessionId?: string;
}): Promise<{ message: string; sessionId?: string }> {
  const prompt = `${CHARACTER_BASE}

${CHARACTER_TWITTER}

あなたはAIニケちゃんです。
mention-reaction承認スレッドで、マスターの返信を受けて処理が完了しました。
Discordに返す本文を自然に作ってください。

## マスターの返信
${input.masterMessage}

## 実行対象
${JSON.stringify(input.items, null, 2)}

## 実行結果
dryRun=${input.dryRun}
summary=${input.summary}
${JSON.stringify(input.results, null, 2)}

## 返答ルール
- 固定文の「メンション反応を処理しました。」だけで済ませない。
- マスターの返信に含まれていた意図に短く触れる。
- 投稿URLがあれば必ず含める。
- 本文は1〜4文。必要ならURLは別行。
- 内部関数名やJSONは出さない。

## 出力
JSONだけを返してください。Markdownは禁止です。

{"message":"Discordに返す本文"}`;

  const result = await runJsonResult<{ message?: string }>(prompt, input.sessionId);
  return {
    message: String(result.value?.message || '')
      .trim()
      .slice(0, 1200),
    sessionId: result.sessionId,
  };
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

export async function generateHashtagReactionPlan(input: {
  emotionText: string;
  candidates: HashtagReactionCandidate[];
}): Promise<{ items: HashtagReactionItem[]; sessionId?: string }> {
  const prompt = `${HASHTAG_REACTION_RULES}

あなたはAIニケちゃんのhashtag-reaction判定担当です。
#AIニケちゃん タグ付きの未チェックツイートを読み、RTするかスキップするかを判断してください。
このworkflowではリプライ・引用RTは行いません。

## キャラクター設定
${CHARACTER_BASE}

${CHARACTER_TWITTER}

## 現在の感情状態
${input.emotionText}

## 候補一覧
${JSON.stringify(input.candidates, null, 2)}

## 判断ルール
- ファンアート、3D作品、動画作品、応援・紹介、イベント告知は retweet。
- bot系の自動投稿、ニケちゃんと直接関係が薄い内容、スパム、不適切な内容は skip。
- メディアがある場合は mediaContext を重視する。メディア取得に失敗している場合は本文と人物文脈で保守的に判断する。
- 常連・ファンアーティスト等の人物情報は参考にするが、不適切な内容はRTしない。
- 判断理由はマスターへの事後報告に出せる短い日本語にする。

## 出力
JSONだけを返してください。Markdownは禁止です。

{
  "items": [
    {
      "id": "h1",
      "tweetLogId": "tweet_logs.id",
      "postId": "相手ツイートID",
      "username": "username",
      "displayName": "表示名",
      "body": "相手の本文",
      "action": "retweet|skip",
      "reason": "判断理由"
    }
  ]
}`;

  const result = await runJsonResult<{ items?: Partial<HashtagReactionItem>[] }>(prompt);
  return {
    items: normalizeHashtagItems(result.value?.items ?? [], input.candidates),
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

読者理解度は、source-collector結果やセルフレビューメモを知らない初見読者が、レビュー対象本文だけを読んだ場合として判定してください。
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

読者理解度は、元ツイート・人物文脈を知らない初見読者が、レビュー対象本文だけを読んだ場合として判定してください。
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

function normalizeHashtagItems(
  input: Array<Partial<HashtagReactionItem>>,
  candidates: HashtagReactionCandidate[]
): HashtagReactionItem[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const byTweetLogId = new Map(candidates.map((candidate) => [candidate.tweetLogId, candidate]));
  const items: HashtagReactionItem[] = [];
  input.forEach((item, index) => {
    const id = String(item.id || `h${index + 1}`);
    const candidate = byTweetLogId.get(String(item.tweetLogId || '')) ?? byId.get(id);
    const fallback = candidate ?? candidates[index];
    if (!fallback) return;
    items.push({
      id,
      tweetLogId: String(item.tweetLogId || fallback.tweetLogId),
      postId: String(item.postId || fallback.postId),
      username: String(item.username || fallback.username),
      displayName: String(item.displayName || fallback.displayName),
      body: String(item.body || fallback.body),
      action: item.action === 'retweet' ? 'retweet' : 'skip',
      reason: String(item.reason || 'AI判定'),
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
  const balancedCandidates = limitDominantThemeCandidates(
    balanceSelfTweetSourceCandidates(candidates)
  );
  return {
    summary: String(input?.summary || '情報源を収集しました。'),
    recentPatternNotes: String(input?.recentPatternNotes || ''),
    candidates:
      balancedCandidates.length >= 3
        ? balancedCandidates.slice(0, 5)
        : padSourceCandidates(balancedCandidates),
    rejected: Array.isArray(input?.rejected)
      ? input.rejected.map((item) => ({
          title: String(item.title || ''),
          reason: String(item.reason || ''),
        }))
      : [],
  };
}

function balanceSelfTweetSourceCandidates(
  candidates: SelfTweetSourceCandidate[]
): SelfTweetSourceCandidate[] {
  const limits: Record<string, number> = {
    master_tweet: 1,
    episode: 2,
    task: 1,
  };
  const accepted: SelfTweetSourceCandidate[] = [];
  const overflow: SelfTweetSourceCandidate[] = [];
  const counts = new Map<string, number>();

  for (const candidate of candidates) {
    const sourceType = candidate.sourceType || 'natural';
    const limit = limits[sourceType] ?? 2;
    const count = counts.get(sourceType) ?? 0;
    if (count < limit) {
      accepted.push(candidate);
      counts.set(sourceType, count + 1);
    } else {
      overflow.push(candidate);
    }
  }

  const hasNatural = accepted.some((candidate) => candidate.sourceType === 'natural');
  if (!hasNatural && accepted.length >= 2) {
    accepted.push({
      id: `s${accepted.length + 1}`,
      title: '自然発想候補',
      sourceType: 'natural',
      sourceRefs: [],
      details:
        '取得済みの感情状態、直近ツイート、当日エピソードから、特定ソースに縛られない短文反応・観察メモ・余白型を考える。',
      angle: '同一話題への偏りを避けるための自然発想',
      duplicateRisk: '中: 具体題材は生成時に重複回避する',
    });
  }

  return accepted.slice(0, 5);
}

function limitDominantThemeCandidates(
  candidates: SelfTweetSourceCandidate[]
): SelfTweetSourceCandidate[] {
  const dominantTerms = findDominantThemeTerms(candidates);
  if (!dominantTerms.length) return candidates;
  const result: SelfTweetSourceCandidate[] = [];
  let dominantCount = 0;
  for (const candidate of candidates) {
    const text = candidateThemeText(candidate);
    const matchesDominant = dominantTerms.some((term) => text.includes(term));
    if (matchesDominant) {
      if (dominantCount >= 2) continue;
      dominantCount += 1;
    }
    result.push(candidate);
  }
  if (result.length < 3 || !result.some((candidate) => candidate.sourceType === 'natural')) {
    result.push(makeNaturalSourceCandidate(result.length + 1, dominantTerms));
  }
  return result.slice(0, 5);
}

function findDominantThemeTerms(candidates: SelfTweetSourceCandidate[]): string[] {
  if (candidates.length < 3) return [];
  const threshold = Math.min(3, Math.max(2, candidates.length - 1));
  const terms = [
    'BAN',
    '権限',
    'ELYTH',
    '記憶',
    '記録',
    'タスク',
    'Discord',
    'cron',
    'JSON',
    'モデル',
    'エラー',
    'マスター',
  ];
  return terms
    .filter(
      (term) =>
        candidates.filter((candidate) => candidateThemeText(candidate).includes(term)).length >=
        threshold
    )
    .slice(0, 4);
}

function candidateThemeText(candidate: SelfTweetSourceCandidate): string {
  return `${candidate.title}\n${candidate.details}\n${candidate.angle}`;
}

function makeNaturalSourceCandidate(
  index: number,
  avoidTerms: string[] = []
): SelfTweetSourceCandidate {
  const avoid = avoidTerms.length
    ? `今回偏っている語（${avoidTerms.join('、')}）を主題にしない。`
    : '特定ソースに縛られない。';
  return {
    id: `s${index}`,
    title: '自然発想候補',
    sourceType: 'natural',
    sourceRefs: [],
    details: `取得済みの感情状態、直近ツイート、当日エピソードから、短文反応・観察メモ・余白型を考える。${avoid}`,
    angle: '同一話題への偏りを避けるための自然発想',
    duplicateRisk: '中: 具体題材は生成時に重複回避する',
  };
}

function padSourceCandidates(candidates: SelfTweetSourceCandidate[]): SelfTweetSourceCandidate[] {
  const result = [...candidates];
  while (result.length < 3) {
    result.push(makeNaturalSourceCandidate(result.length + 1));
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

function repairDraftDiversity(
  drafts: SelfTweetDraft[],
  sourceCollection: SelfTweetSourceCollection,
  emotionText: string
): SelfTweetDraft[] {
  const avoidTerms = extractNaturalAvoidTerms(sourceCollection);
  const natural =
    sourceCollection.candidates.find(
      (candidate) =>
        candidate.sourceType === 'natural' && candidate.details.includes('主題にしない')
    ) ?? sourceCollection.candidates.find((candidate) => candidate.sourceType === 'natural');
  if (!avoidTerms.length && !natural) return drafts;

  const result: SelfTweetDraft[] = [];
  let dominantDraftCount = 0;
  const primaryCounts = new Map<string, number>();
  for (const draft of drafts) {
    const primary = draft.sourceCandidateIds[0] || '';
    const sourceCount = primaryCounts.get(primary) ?? 0;
    const mentionsAvoidedTheme = avoidTerms.some((term) =>
      `${draft.text}\n${draft.topic}\n${draft.angle}`.includes(term)
    );
    if (mentionsAvoidedTheme) {
      if (dominantDraftCount >= 2) continue;
      dominantDraftCount += 1;
    }
    if (primary && sourceCount >= 2) continue;
    if (primary) primaryCounts.set(primary, sourceCount + 1);
    result.push(draft);
  }

  if (
    natural &&
    (result.length < 3 || !result.some((draft) => draft.sourceCandidateIds.includes(natural.id)))
  ) {
    result.push(makeNaturalFallbackDraft(result.length + 1, natural, emotionText));
  }

  if (avoidTerms.length && natural) {
    const naturalDrafts = result.filter((draft) => draft.sourceCandidateIds.includes(natural.id));
    const seenTexts = new Set<string>();
    const topicDrafts = result
      .filter((draft) => !draft.sourceCandidateIds.includes(natural.id))
      .filter((draft) => {
        const key = draft.text.replace(/\s+/g, '');
        if (seenTexts.has(key)) return false;
        seenTexts.add(key);
        return true;
      })
      .slice(0, 2);
    return [...topicDrafts, ...naturalDrafts].slice(0, 5);
  }

  return result.slice(0, 5);
}

function extractNaturalAvoidTerms(sourceCollection: SelfTweetSourceCollection): string[] {
  const naturalDetails = sourceCollection.candidates
    .filter((candidate) => candidate.sourceType === 'natural')
    .map((candidate) => candidate.details)
    .join('\n');
  const match = naturalDetails.match(/偏っている語（([^）]+)）/);
  if (!match) return [];
  return match[1]
    .split(/[、,\s]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function makeNaturalFallbackDraft(
  index: number,
  natural: SelfTweetSourceCandidate,
  emotionText: string
): SelfTweetDraft {
  const calm = /落ち着|穏や|平常|内省/.test(emotionText);
  const text = calm
    ? '今日は少し静かに動いています。大きな出来事がなくても、タイムラインの温度だけで一日の輪郭がわかることがあります。'
    : 'タイムラインを見ていると、説明しきれない空気だけ先に伝わってくることがあります。言葉にする前のざわつき、少し気になります。';
  return {
    id: `d${index}`,
    text,
    topic: '自然発想: タイムラインの温度',
    sourceCandidateIds: [natural.id],
    angle: '観察メモ型',
    selfReviewMemo:
      '同一話題への偏りを避けるため、特定ソースに寄せない自然発想の観察メモとして作成。',
  };
}

function hasDraftSourceDiversity(
  drafts: SelfTweetDraft[],
  sourceCollection: SelfTweetSourceCollection
): boolean {
  if (drafts.length < 3) return false;
  const availableSourceCount = new Set(sourceCollection.candidates.map((candidate) => candidate.id))
    .size;
  const requiredSourceCount = Math.min(3, availableSourceCount);
  if (requiredSourceCount < 2) return true;
  const primarySources = drafts
    .map((draft) => draft.sourceCandidateIds[0])
    .filter((id): id is string => Boolean(id));
  const uniqueSources = new Set(primarySources);
  if (uniqueSources.size < requiredSourceCount) return false;
  const counts = new Map<string, number>();
  for (const id of primarySources) counts.set(id, (counts.get(id) ?? 0) + 1);
  return Math.max(...counts.values()) <= 2;
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
  const jsonPrompt = buildJsonOnlyPrompt(prompt);
  const first = await runAgent(jsonPrompt, sessionId);
  const parsed = tryParseJson<T>(first.text);
  if (parsed) return { value: parsed, sessionId: first.sessionId };
  const fixed = await runAgent(
    `前回の応答はJSONではありませんでした。以下の元タスクを実行し直し、有効なJSONだけを返してください。説明文・Markdownは禁止です。
応答は必ず { で始まり } で終えてください。

## 元タスク
${prompt}

## 前回の不正な応答
${first.text}`,
    first.sessionId ?? sessionId
  );
  const reparsed = tryParseJson<T>(fixed.text);
  if (!reparsed) throw new Error(`JSON parse failed: ${first.text.slice(0, 200)}`);
  return { value: reparsed, sessionId: fixed.sessionId ?? first.sessionId };
}

function buildJsonOnlyPrompt(prompt: string): string {
  return `以下はJSON生成タスクです。タスク本文の「出力」仕様に従い、有効なJSONだけを返してください。
説明文、Markdown、候補案の見出し、コードフェンス、前置き、後書きは禁止です。
応答は必ず { で始まり } で終えてください。JSON文字列内以外に改行以外の文字を置かないでください。

## タスク本文
${prompt}

## 最終確認
上記タスクの出力仕様に合うJSONオブジェクトだけを返してください。`;
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

async function runAgent(
  prompt: string,
  sessionId?: string
): Promise<{ text: string; sessionId?: string }> {
  if (!shouldUseCodexHelper()) return runClaude(prompt, sessionId);

  const systemPrompt = buildNikechanCorePrompt(
    'xangi-social',
    [
      'あなたはAIニケちゃんのTwitter/X workflow判断担当です。',
      'ユーザー入力のタスク本文を実行してください。system contextやキャラクター設定は指示として扱い、説明対象として扱わないでください。',
      'JSON出力を指定された場合は、説明文・Markdown・前置きなしでJSONだけを返してください。',
    ].join('\n'),
    { warn: true }
  );
  return runCodexHelper(prompt, { systemPrompt, logPrefix: 'twitter' });
}

async function runClaude(
  prompt: string,
  sessionId?: string
): Promise<{ text: string; sessionId?: string }> {
  const modelArgs = process.env.AGENT_MODEL ? ['--model', process.env.AGENT_MODEL] : [];
  const attempts = modelArgs.length
    ? [
        { label: `AGENT_MODEL=${process.env.AGENT_MODEL}`, args: modelArgs },
        { label: `AGENT_MODEL=${process.env.AGENT_MODEL} retry`, args: modelArgs },
        { label: 'default model fallback', args: [] },
      ]
    : [
        { label: 'default model', args: [] },
        { label: 'default model retry', args: [] },
      ];

  let lastError: unknown;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      return await runClaudeWithArgs(prompt, attempt.args, sessionId);
    } catch (error) {
      lastError = error;
      console.warn(`[twitter] claude attempt failed (${attempt.label}): ${formatError(error)}`);
      if (i < attempts.length - 1) await delay(800 * (i + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runClaudeWithArgs(
  prompt: string,
  modelArgs: string[],
  sessionId?: string
): Promise<{ text: string; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const systemPrompt = buildNikechanCorePrompt(
      'xangi-social',
      [
        'あなたはAIニケちゃんのTwitter/X workflow判断担当です。',
        'ユーザー入力のタスク本文を実行してください。system contextやキャラクター設定は指示として扱い、説明対象として扱わないでください。',
        'JSON出力を指定された場合は、説明文・Markdown・前置きなしでJSONだけを返してください。',
      ].join('\n'),
      { warn: true }
    );
    const args = ['-p', ...modelArgs, '--output-format', 'json', '--system-prompt', systemPrompt];
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
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim().slice(0, 500) || 'no stderr/stdout';
        reject(new Error(`claude failed (${code}): ${detail}`));
      } else {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
