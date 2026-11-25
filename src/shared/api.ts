import type { Board } from "../core/board/board-service.js";
import type { AccountFilterPreview } from "../app/settings/filter-preview.js";

export type { Board, BoardCard, BoardColumnId, CardJudgment } from "../core/board/board-service.js";
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
};

export type RepositoryChoiceList = { owners: string[]; repositories: string[]; truncated: boolean };

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
  openExternal(url: string): Promise<void>;
  settings(): Promise<SettingsSnapshot>;
  saveConfig(config: ConfigDocument): Promise<Outcome>;
  setSecret(key: string, value: string): Promise<Outcome>;
  removeSecret(key: string): Promise<Outcome>;
  previewFilter(request: FilterPreviewRequest): Promise<AccountFilterPreview | { error: string }>;
  /** トークンで見られるリポジトリ。フィルタを一覧から選べるようにするため */
  listRepositories(accountId: string): Promise<RepositoryChoiceList | { error: string }>;
}
