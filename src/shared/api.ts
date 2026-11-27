import type { Board } from "../core/board/board-service.js";
import type { AccountFilterPreview } from "../app/settings/filter-preview.js";

export type { Board, BoardCard, BoardColumnId, CardJudgment, TaskDetail, TaskDetailChange, TaskDetailItem } from "../core/board/board-service.js";
export type { Effort, NextActionPlan, Step, WaitCondition } from "../core/task/next-actions.js";
import type { TaskDetail } from "../core/board/board-service.js";
export type { AccountFilterPreview, TargetCheck } from "../app/settings/filter-preview.js";
export type { FilterReason } from "../sources/github/repository-filter.js";

export type TaskQuestionView = {
  id: number;
  question: string;
  status: "running" | "answered" | "failed";
  answer: string | null;
  sources: ReadonlyArray<string>;
  error: string | null;
  askedAt: string;
  answeredAt: string | null;
  /** Claude Code が提案した、この Task とは別の Task */
  suggestions: ReadonlyArray<{ title: string; brief: string; reason: string; status: "proposed" | "accepted" | "dismissed"; taskId?: number }>;
};

export type GmailMailTargetView = {
  kind: "senders" | "threads";
  messages: ReadonlyArray<{ messageId: string; subject: string; senderName: string; receivedAt: number; pastInvite: boolean }>;
};

export type MovableStatus = "needs_review" | "todo" | "in_progress" | "done" | "dismissed";

export type LlmProvider = "none" | "anthropic" | "openai" | "gemini" | "azure-openai" | "bedrock";

/** 設定ファイル（config.json）の形。画面で編集し、main で Schema 検証してから保存する */
export type ConfigDocument = {
  llmProfiles: Record<
    string,
    { provider: LlmProvider; model: string; azure?: { endpoint: string }; decisions?: { provider: "jev" | "openai" | "azure-openai" | "microsoft-decision" | "gemini"; model?: string } }
  >;
  defaultLlmProfile: string;
  accounts: Array<{
    kind: "github";
    id: string;
    llmProfile?: string;
    initialLookbackDays?: number;
    repositories?: { include?: string[]; exclude?: string[] };
    reviewDependencyPrs?: boolean;
    planNextActions?: boolean;
  }>;
  /** Slack のワークスペース（ADR-0010）。トークンと Cookie は秘密情報として別に保存する */
  slackAccounts?: Array<{
    kind: "slack";
    id: string;
    workspace: string;
    userAgent: string;
    llmProfile?: string;
    planNextActions?: boolean;
  }>;
  /** Gmail のアカウント（認証は gws に任せる） */
  gmailAccounts?: Array<{
    kind: "gmail";
    id: string;
    llmProfile?: string;
    planNextActions?: boolean;
    /** 同じ Google アカウントの Calendar も見る（ADR-0016） */
    calendar?: boolean;
  }>;
  /** Microsoft の職場のアカウント（ADR-0017）。リフレッシュトークンは秘密情報として別に保存する */
  microsoftAccounts?: Array<{
    kind: "microsoft";
    id: string;
    tenantId: string;
    clientId: string;
    llmProfile?: string;
    calendar?: boolean;
  }>;
  /** Notion のアカウント（ADR-0015）。token_v2 は秘密情報として別に保存する */
  notionAccounts?: Array<{
    kind: "notion";
    id: string;
    userId: string;
    userAgent: string;
    origin?: "https://www.notion.so" | "https://app.notion.com";
    llmProfile?: string;
  }>;
  /** 利用者が決めたルール（ADR-0014）。条件は言葉で書き、操作は Source ごとに持つ */
  rules?: Array<RuleDraft>;
};

export type RuleActions = { gmail?: { labels?: string[]; markRead?: boolean; archive?: boolean } };

export type RuleDraft = {
  id: string;
  name: string;
  enabled?: boolean;
  createdAt: string;
  /** どういう時（言葉で書く） */
  when: string;
  /** 何をする（言葉で書く） */
  then: string;
  /** then から読み取った操作 */
  actions: RuleActions;
  /** actions を読み取った then の文 */
  interpretedFrom: string;
};

/** saved: アプリに暗号化して保存済み / env: 環境変数から読んでいる / missing: ない */
export type SecretStatus = "saved" | "env" | "missing";

export type SettingsSnapshot = {
  configPath: string;
  /** 設定ファイルがなければ null */
  config: unknown;
  /** 設定や同期の問題。画面の上に出す */
  problems: string[];
  secrets: Record<string, SecretStatus>;
  /** OS の暗号化（キーチェーン）が使えるか。使えなければ秘密情報を保存できない */
  encryptionAvailable: boolean;
  /** アカウントごとの、保存したときに確かめた GitHub トークンの情報 */
  githubTokens: Record<string, GitHubTokenSummary>;
};

export type GitHubTokenSummary = {
  login: string;
  scopes: readonly string[];
  expiresAt?: string;
  verifiedAt: string;
  /** 期限が近い（または過ぎた）ときだけ、残りの日数 */
  expiryWarning?: { daysLeft: number };
  /** なくても同期はできるが、足りない権限（workflow がないと .github/workflows を変える PR を merge できない） */
  missingRecommendedScopes: readonly string[];
};

export type MergeMethod = "squash" | "merge" | "rebase";
export type MergePlanView = { repository: string; number: number; sha: string; method: MergeMethod; reason: string };

/** Claude Code がコンフリクトを直した結果。push の確認に出す */
export type ConflictResolutionView = {
  repository: string;
  headRef: string;
  baseRef: string;
  summary: string;
  files: ReadonlyArray<{ path: string; resolution: string }>;
  concerns: string;
  diff: string;
  commitSha: string;
};

export type RecurrenceScheduleView = { kind: "monthly"; day: number; leadDays: number };
/** 定期の Task の決まり */
export type RecurringTaskView = { id: number; title: string; note: string; schedule: RecurrenceScheduleView; active: boolean; lastPeriod: string | null };

/** 作る日が近い定期の Task の予告（Todo にゴーストとして出す） */
export type RecurringGhost = { ruleId: number; title: string; period: string; date: { year: number; month: number; day: number }; daysLeft: number };

/** Claude Code が PR を修正した結果。push の確認に出す */
export type PullRequestFixView = { repository: string; headRef: string; step: string; summary: string; verification: string; concerns: string; diff: string; commitSha: string };

export type Outcome = { ok: true; detail?: string } | { ok: false; message: string };

export type FilterPreviewRequest = {
  accountId: string;
  filter: { include?: string[]; exclude?: string[] };
  targets: string[];
};

/** preload が renderer に公開する API。秘密情報は書けるが、値を読み出す口はない */
export interface LiveTodoApi {
  board(): Promise<Board>;
  moveTask(taskId: number, status: MovableStatus): Promise<void>;
  markSeen(taskId: number): Promise<void>;
  taskDetail(taskId: number): Promise<TaskDetail>;
  /** merge の確認に出す内容（merge 先・方法と理由・調べたときの commit） */
  mergePlan(taskId: number): Promise<MergePlanView | { error: string }>;
  /** 確認で承認した内容（方法と commit）で merge を始める。外部への書き込み。merge は裏で進む */
  merge(taskId: number, approved: { method: MergeMethod; sha: string }): Promise<Outcome>;
  /** AI にもう一度調べてもらう（調査待ちに入れ直す） */
  requestReview(taskId: number): Promise<Outcome>;
  completeStep(taskId: number, stepId: string): Promise<Outcome>;
  chooseOption(taskId: number, stepId: string, optionKey: string): Promise<Outcome>;
  /** 済んだにした手順・選んだ分かれ道を戻す */
  reopenStep(taskId: number, stepId: string): Promise<Outcome>;
  /** 次にやることを考え直させる。済んだ手順は残し、残りだけを AI が考える。request はユーザーの希望で、あればそれに合わせる */
  replanNextActions(taskId: number, request?: string): Promise<Outcome>;
  /** Claude Code に PR を修正させる（コマンドも使うが、push はしない）。裏で進み、Task は処理中のレーンに移る */
  fixPullRequest(taskId: number): Promise<Outcome>;
  pullRequestFix(taskId: number): Promise<PullRequestFixView | { error: string }>;
  /** 修正した commit を PR のブランチに push する。外部への書き込み。差分を確かめて承認したあとにだけ呼ぶ */
  pushPullRequestFix(taskId: number, commitSha: string): Promise<Outcome>;
  /** Claude Code にコンフリクトを直させる。裏で進み、Task は処理中のレーンに移る */
  resolveConflicts(taskId: number): Promise<Outcome>;
  conflictResolution(taskId: number): Promise<ConflictResolutionView | { error: string }>;
  /** 直した内容を PR のブランチに push する。外部への書き込み。差分を確かめて承認したあとにだけ呼ぶ */
  pushConflictResolution(taskId: number, commitSha: string): Promise<Outcome>;
  addTask(input: { title: string; brief?: string }): Promise<Outcome>;
  recurringList(): Promise<RecurringTaskView[]>;
  recurringGhosts(): Promise<RecurringGhost[]>;
  /** 予告している月の分を、作る日を待たずに今すぐ作る */
  recurringCreateNow(ruleId: number): Promise<Outcome>;
  /** 定期の Task の決まりを登録する。includeCurrent なら、時期を過ぎた今月の分もすぐに作る */
  recurringCreate(input: { title: string; note: string; schedule: RecurrenceScheduleView; includeCurrent: boolean }): Promise<Outcome>;
  /** Task をもとに定期の Task を作る（タイトルと次にやることをひな形にする） */
  recurringFromTask(input: { taskId: number; title?: string; note: string; schedule: RecurrenceScheduleView; includeCurrent: boolean }): Promise<Outcome>;
  recurringUpdate(input: { id: number; title?: string; note?: string; schedule?: RecurrenceScheduleView; active?: boolean }): Promise<Outcome>;
  /** Slack の To-do を完了にする・To-do から外す。外部への書き込み。確認で承認したあとにだけ呼ぶ */
  slackAction(taskId: number, action: "complete" | "remove"): Promise<Outcome>;
  /** 手順の開く先（公式のサイトなど）を外部のブラウザで開く。開く先は main が Task の手順から取り出す */
  openStepLink(taskId: number, stepId: string): Promise<void>;
  /** 保存したルールを、今あるもの（今は Gmail の受信トレイに残っているメール）にも当てる（外部への書き込み。利用者が押したときだけ） */
  applyRuleToExisting(ruleId: string): Promise<{ ok: true; applied: number; alreadyApplied: number; notMatched: number } | { ok: false; reason: string }>;
  /** ルールの「何をする」を、Decisions でアプリの操作に読み取る */
  interpretRule(then: string): Promise<{ ok: true; actions: RuleActions } | { ok: false; reason: string }>;
  /** Task についての質問と回答（古い順） */
  taskQuestions(taskId: number): Promise<TaskQuestionView[]>;
  /** 手順を Claude Code に頼む（調べて報告するだけ。外への書き込みはさせない） */
  runStepWithClaude(taskId: number, stepId: string): Promise<Outcome>;
  /** 質問の回答で提案された Task を作る（OK を押したとき） */
  acceptSuggestion(questionId: number, index: number): Promise<Outcome>;
  dismissSuggestion(questionId: number, index: number): Promise<Outcome>;
  /** Task について質問し、Claude Code に調べさせる（調べ終わると taskQuestions に回答が載る） */
  askTask(taskId: number, question: string): Promise<Outcome>;
  /** 確認済みにする・ゴミ箱に入れる候補のメール（確認に見せる） */
  gmailMailTarget(taskId: number): Promise<GmailMailTargetView | { error: string }>;
  /** 確認で見せたメールを、Gmail で確認済みにする（アーカイブして既読）かゴミ箱に入れる。外部への書き込み。承認したあとにだけ呼ぶ */
  gmailProcess(taskId: number, action: "archive" | "trash", messageIds: ReadonlyArray<string>): Promise<Outcome>;
  /** Gmail の操作の手順（ラベル・既読・アーカイブ）を、確認で見せたメールに行う。外部への書き込み。押して承認したあとにだけ呼ぶ */
  gmailRunStep(taskId: number, stepId: string, messageIds: ReadonlyArray<string>): Promise<Outcome>;
  /** Slack のセッションでつながるかを確かめる（auth.test）。誰のどのワークスペースか */
  testSlack(accountId: string): Promise<{ user: string; team: string } | { error: string }>;
  /** Slack のログイン画面を開き、ログインが済んだらセッションと User-Agent を読み取って保存する。workspace が空ならログインしたワークスペースを使う */
  connectSlack(accountId: string, workspace: string): Promise<{ workspace: string; team: string } | { error: string }>;
  /** Notion のセッションでつながるかを確かめる。誰で、どのワークスペースが見えるか */
  testNotion(accountId: string): Promise<{ user: string; spaces: string[] } | { error: string }>;
  /** Notion のログイン画面を開き、ログインが済んだらセッションと User-Agent を読み取って保存する */
  connectNotion(accountId: string): Promise<{ user: string } | { error: string }>;
  /** device code 認証を始める。サインインの画面を外部のブラウザで開き、打ち込むコードを返す（保存済みの設定のアカウントだけ） */
  startMicrosoftSignIn(accountId: string): Promise<{ userCode: string; verificationUri: string; expiresInSeconds: number } | { error: string }>;
  /** サインインが済むまで待ち、済んだらリフレッシュトークンを保存して同期をやり直す */
  finishMicrosoftSignIn(accountId: string): Promise<{ user: string } | { error: string }>;
  testMicrosoft(accountId: string): Promise<{ user: string } | { error: string }>;
  openExternal(url: string): Promise<void>;
  settings(): Promise<SettingsSnapshot>;
  saveConfig(config: ConfigDocument): Promise<Outcome>;
  setSecret(key: string, value: string): Promise<Outcome>;
  removeSecret(key: string): Promise<Outcome>;
  previewFilter(request: FilterPreviewRequest): Promise<AccountFilterPreview | { error: string }>;
}
