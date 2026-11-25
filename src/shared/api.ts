import type { Board } from "../core/board/board-service.js";
import type { AccountFilterPreview } from "../app/settings/filter-preview.js";

export type { Board, BoardCard, BoardColumnId, CardJudgment, TaskDetail, TaskDetailChange, TaskDetailItem } from "../core/board/board-service.js";
export type { Effort, NextActionPlan, Step, WaitCondition } from "../core/task/next-actions.js";
import type { TaskDetail } from "../core/board/board-service.js";
export type { AccountFilterPreview, TargetCheck } from "../app/settings/filter-preview.js";
export type { FilterReason } from "../sources/github/repository-filter.js";

export type MovableStatus = "needs_review" | "todo" | "in_progress" | "done" | "dismissed";

export type LlmProvider = "none" | "anthropic" | "openai" | "gemini" | "azure-openai" | "bedrock";

/** 設定ファイル（config.json）の形。画面で編集し、main で Schema 検証してから保存する */
export type ConfigDocument = {
  llmProfiles: Record<string, { provider: LlmProvider; model: string; decisions?: { provider: "jev" | "openai" | "gemini"; model?: string } }>;
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
  /** 次にやることの手順を済ませる */
  completeStep(taskId: number, stepId: string): Promise<Outcome>;
  /** 次にやることの分かれ道を選ぶ */
  chooseOption(taskId: number, stepId: string, optionKey: string): Promise<Outcome>;
  /** 済んだにした手順・選んだ分かれ道を戻す */
  reopenStep(taskId: number, stepId: string): Promise<Outcome>;
  /** Claude Code にコンフリクトを直させる。裏で進み、Task は処理中のレーンに移る */
  resolveConflicts(taskId: number): Promise<Outcome>;
  conflictResolution(taskId: number): Promise<ConflictResolutionView | { error: string }>;
  /** 直した内容を PR のブランチに push する。外部への書き込み。差分を確かめて承認したあとにだけ呼ぶ */
  pushConflictResolution(taskId: number): Promise<Outcome>;
  openExternal(url: string): Promise<void>;
  settings(): Promise<SettingsSnapshot>;
  saveConfig(config: ConfigDocument): Promise<Outcome>;
  setSecret(key: string, value: string): Promise<Outcome>;
  removeSecret(key: string): Promise<Outcome>;
  previewFilter(request: FilterPreviewRequest): Promise<AccountFilterPreview | { error: string }>;
}
