> **Stability**: 🌊 living
> **最終更新**: 2026-11-25
> **直近の変更 ADR**: [ADR-0008](decisions/0008-watchers.md)

# Architecture — live-todo

このプロジェクトの技術構成と設計判断。実装に合わせて自由に更新する。重要な設計判断は `decisions/` に ADR として記録する。

## 全体構成

macOS 向けの Electron アプリ。main プロセスがポーリングして Source から取得し、ローカル DB に保存する。推論だけを外部の LLM API に投げる。renderer は UI だけを担い、トークンや API キーには触れない。

```
[Slack] [Gmail] [GitHub] [Calendar] [Docs] [Notion] [Outlook] [Teams]
    │       │       │        │        │       │        │        │
    └───────┴───────┴── Source Adapter（取得・正規化・差分検知）──┘
                               │
                         Sync（ポーリング）
                               │
                     ローカル DB（Source Item / Task / Agent Thread）
                          │                    │
              Labeling / Priority        AI Agent ── LLM Provider 抽象 ──> Claude / OpenAI / Gemini / Azure / Bedrock
                          │                    │
                    カンバン UI  <── Approval（外部への書き込みの承認）
```

## ドメインモデル

経緯は [ADR-0007](decisions/0007-separate-source-items-from-tasks.md)。

```
Source Item ──(Link: tracks / context)──▶ Task
  └ Activity（出来事）  ── 解釈 ──▶  └ Task Change（更新マーク）
```

同期の流れ（`src/core/sync/sync-source.ts`）:

1. Adapter から SourceChange を取得し、triage が pending の Item を判定する（トランザクションの外）
2. Source Item を保存し、前回との差から Activity を記録する
3. pending の Item は判定に従って Task を作り tracks で紐づける（not_todo なら ignored）
4. linked の Item に resolved / reopened / removed が起きたら、tracks の Item の状態から Task の status を導き直す
5. Task の項目が実際に変わったときだけ Task Change を記録する
6. カーソルを保存する（2〜6 は 1 つのトランザクション）

### 見張り（Watcher）

経緯は [ADR-0008](decisions/0008-watchers.md)。`src/core/watch/` が Source を知らない共通部分、Source 側は WatchProvider（見張る対象の一覧）と固有の Condition を持つ。

```
WatchProvider（対象の一覧）× Condition（holds / clear / unknown）
  → Watcher が前回の結果（カーソル）と比べて Condition Item を作る
  → watchBinding で "<source>:watch" として既存の Sync に流す
```

| テーブル | 中身 |
|------|------|
| `source_items` | Source Item。`(source, external_id)` で一意 |
| `activities` | Activity |
| `tasks` | Task（title / brief / status） |
| `task_links` | Link。`source_item_id` で一意 |
| `task_changes` | Task Change。`seen_at` が NULL のものが更新マーク |
| `sync_cursors` | Source ごとのカーソル |

## 設定と秘密情報

| 種類 | 置き場所 | 読み込み |
|------|------|------|
| アカウント・LLM Profile・フィルター | PC ごとの `config.json`（形式は `config.example.json`） | `src/app/config/app-config.ts`。読み込み時に項目同士の整合性まで検証する |
| トークン・API キー | 今は環境変数 `LIVE_TODO_SECRET_<キー>`（`.env.local`）。Electron に載せるときに safeStorage に差し替える | `src/core/config/secret-store.ts`（`SecretStore`）。値は `Redacted` で持つ |

- アカウントごとに Source 名を分ける（`github:<id>`、見張りは `github:<id>:watch`）
- アカウントが LLM Profile を省略したら `defaultLlmProfile` を使う。当面は PC 単位の 1 つで運用し、データ構造だけ先にアカウント単位にしてある（charter の前提と制約）

## GitHub API の呼び出し

`src/sources/github/github-client-live.ts`（`effect/http` の HttpClient）。

- **トークン（アカウント）ごとに 1 本のキュー**で、リクエストを 1 つずつ順番に送る。GitHub は同じユーザーからのリクエストを順番に送ることを推奨しており、並行に送ると secondary rate limit にかかりやすいため。通知の同期と見張りの同期は、同じアカウントなら同じクライアント（同じキュー）を共有する
- レート制限を受けたら解除時刻を覚え、それまではキューに並んでいるものも含めて API に送らず、その場で `GitHubRateLimitedError` を返す（ブレーカー）
- Adapter や見張りの側では並行数を指定しない（流量はキューで決まる）
- `Link` ヘッダーの next をたどって全ページを取る（1 回の取得で最大 10 ページ）
- 404 / 410 は「ない」として `Option.none`。レート制限（403 / 429 で残り 0、または `retry-after`）は解除時刻つきの `GitHubRateLimitedError`。それ以外は `GitHubRequestError`
- クライアントの中では待たず、再試行もしない。いつまで休むか・いつやり直すかは定期実行の側で決める（待ち時間は最大 1 時間あり、クライアントの中で待つとアカウントの同期全体が止まるため）
- 応答に含まれる URL を取りに行くとき、宛先が `api.github.com` でなければトークンを付けずにエラーにする
- エラーの `cause` に HttpClient のエラーを入れない（送ったリクエストの `authorization` ヘッダーがログに出るため）

## 定期実行

- `src/core/sync/scheduler.ts`（`runJobs`）: ジョブごとに「実行 → 間隔だけ待つ」を止まらずに繰り返す。失敗（defect も含む）はログに残して次の間隔でやり直す。ジョブが休む時刻（レート制限の解除時刻など）を示したら、少なくともその時刻まで待つ。1 つのジョブが休んだり失敗したりしても、ほかのジョブは止まらない
- `src/app/github-jobs.ts`: アカウントごとに GitHubClient を 1 つ作り、通知の同期（1 分ごと）と見張り（5 分ごと）の 2 つのジョブで共有する
- LLM による判定を入れるまでは、`ConservativeClassifier`（常に `uncertain`）を使う。規則で決まらない項目はすべて要確認に入り、対象外として捨てることはない

## 技術スタック

決定の経緯は [ADR-0002](decisions/0002-desktop-app-stack.md) と [ADR-0005](decisions/0005-adopt-effect.md) を参照。

| 領域 | 採用技術 | 採用理由 / 関連 ADR |
|------|----------|---------------------|
| アプリ基盤 | Electron（macOS のみ） | 常駐・キーチェーン・Node SDK をまとめて満たす。[ADR-0002](decisions/0002-desktop-app-stack.md) |
| 言語 | TypeScript | main と renderer を 1 言語にそろえる |
| 実装の基盤 | Effect 4（`effect`） | エラーの型付け・依存の注入・Schema による検証・スケジュール。[ADR-0005](decisions/0005-adopt-effect.md) |
| UI | React + Vite | |
| カンバン | dnd-kit | |
| データストア | SQLite（`@effect/sql-sqlite-node`）+ Drizzle ORM 1.0 rc（`drizzle-orm/effect-sqlite-node`） | ローカル完結。テーブル定義から型を導く。[ADR-0006](decisions/0006-drizzle-on-effect-sql.md) |
| LLM 抽象 | `effect/ai`（`LanguageModel`）+ `@effect/ai-*` | 複数プロバイダと tool calling を共通 API で扱える。Decisions provider は `effect/http` で自前実装 |
| 秘匿情報 | Electron `safeStorage`（macOS Keychain） | トークンを平文の設定ファイルに置かない |
| テスト | Vitest + `@effect/vitest`（UI の E2E は必要に応じて Playwright） | |
| パッケージ管理 | pnpm 12（`packageManager` で固定、corepack で起動） | |
| 開発環境 | nix flake + direnv | 版を `flake.lock` で固定し、手元・CI・worktree を揃える |

### プロセス構成

| プロセス | 担当 |
|----------|------|
| main | Sync（ポーリング）、Source Adapter、AI Agent、LLM 呼び出し、Approval、DB、秘匿情報 |
| renderer | カンバン UI、Agent Thread の表示、承認ダイアログ。IPC で main に依頼するだけ |

## 開発環境

| ファイル | 役割 |
|----------|------|
| `flake.nix` / `flake.lock` | 言語ランタイム・CLI ツールの固定。追加は `devShells.default` の `packages` へ |
| `package.json` / `pnpm-lock.yaml` | npm 依存と pnpm の版（`packageManager`）の固定 |
| `pnpm-workspace.yaml` | pnpm の設定（供給網対策など） |
| `.envrc` | `use flake` で devShell を有効化し、`dotenv_if_exists` で `.env` / `.env.local` を読み込む |
| `.env` | 非秘匿の環境差分。gitignore |
| `.env.local` | 秘匿値（API キー・トークン）。gitignore |
| `.env.example` | 上の 2 つの雛形。キーと説明だけを書く |
| `.worktreeinclude` | worktree 作成時にコピーする gitignore 対象ファイルの一覧 |

devShell には Node.js 24 と corepack を入れている。pnpm は nixpkgs の版を使わず、corepack が `packageManager` の版（12.23.0）を取得して起動する。nixpkgs の pnpm は版が遅れており、新しい設定キーを含む `pnpm-workspace.yaml` を読めないため。

## 主要な設計判断

- [ADR-0001: アーキテクチャ判断記録方式の採用](decisions/0001-record-architecture-decisions.md)
- [ADR-0002: アプリ基盤に Electron + TypeScript を採用する](decisions/0002-desktop-app-stack.md)
- [ADR-0003: 同期と判定のパイプライン](decisions/0003-sync-and-judge-pipeline.md)
- [ADR-0004: Epic とカスタムラベルを導入する](decisions/0004-epic-and-custom-labels.md)
- [ADR-0005: 実装の基盤に Effect を採用する](decisions/0005-adopt-effect.md)
- [ADR-0006: DB アクセスに Drizzle ORM（Effect 版）を使う](decisions/0006-drizzle-on-effect-sql.md)
- [ADR-0007: Source Item と Task を別の概念として分ける](decisions/0007-separate-source-items-from-tasks.md)
- [ADR-0008: 見張り（Watcher）を Source 共通の仕組みにする](decisions/0008-watchers.md)
- 設計の方針
  - Source ごとの差異は Source Adapter に閉じ込め、Task・UI は Source に依存させない
  - 外部への書き込みは Approval を必ず通す。Adapter の書き込みメソッドは、承認済みの操作しか受け付けない形にする
  - 設定は最初から `Account → LLM Profile` の構造で持ち、当面は PC 単位の既定値だけを使う（Phase 4 で作り直しにならないように）

## 判定の閾値（初期値）

運用しながら調整する。経緯は [ADR-0003](decisions/0003-sync-and-judge-pipeline.md)。

| 判定 | 閾値 | 結果 |
|------|------|------|
| todo 判定（predicate） | 0.8 以上 / 0.4 以上 0.8 未満 / 0.4 未満 | todo / 要確認 / 対象外 |
| カスタムラベル（自然文ルール） | 0.8 以上 | 付与 |
| 未分類 Task とのまとまり（predicate） | 0.8 以上の Task が 1 件以上 | Epic を作る |
| refusal・想定外の応答 | — | 要確認 |

## 外部依存

| 依存先 | 用途 | リスク |
|--------|------|--------|
| Slack API | メッセージ・メンション・スレッドの取得 | レート制限、ワークスペース側のアプリ承認が要る場合がある |
| Gmail API / Google Calendar API / Google Drive API | メール・予定・Docs のコメントの取得 | Google OAuth の審査範囲、トークンの有効期限 |
| GitHub API | Issue / PR / レビュー依頼 / 通知の取得 | レート制限 |
| Notion API | ページ・メンション・割り当ての取得 | インテグレーションへのページ共有が必要 |
| Microsoft Graph | Outlook（Mail・Calendar）・Teams の取得 | 会社テナントでのアプリ同意が必要な場合がある |
| LLM API（Claude / OpenAI / Gemini / Azure OpenAI / Bedrock） | fallback の判定、Epic の名前付け、Agent、Pre-work | 従量課金のコスト、会社ポリシー上の利用可否 |
| Drizzle ORM / drizzle-kit 1.0 rc | クエリとマイグレーション | rc のため正式版までに API が変わる可能性がある |
| `node:sqlite`（`@effect/sql-sqlite-node` の土台） | ローカル DB | Node 24 時点で experimental。API が変わる可能性がある。代わりにネイティブモジュールのリビルドが不要 |
| Decisions provider（Jev / OpenAI Decisions / Gemini Decisions） | todo 判定・ラベル・優先度・カスタムラベル・Epic への振り分け | Gemini Decisions は発表直後で API が変わる可能性がある |

## 非機能要件

- **性能**: TBD（次回更新時に決定）
- **可用性**: アプリ起動中にポーリングが動けばよい。常時稼働は求めない
- **セキュリティ**: トークンと Source Item の本文をログに出さない。外部への書き込みは承認制。会社のデータは会社が許可した LLM にだけ送る

## テスト戦略

TDD で進める。Source Adapter は実 API ではなく、記録したレスポンスのフィクスチャでテストする。詳細は TBD（次回更新時に決定）。

## 監視・観測

TBD（次回更新時に決定）。少なくとも、Source ごとの最終同期時刻とエラーを UI で確認できるようにする。

## デプロイ

自分の macOS にインストールして使う。パッケージング手段（electron-builder など）は TBD（次回更新時に決定）。
