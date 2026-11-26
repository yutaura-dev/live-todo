# live-todo

各種ツールから自分の todo を自動で集め、優先度付きのカンバンで示すローカル完結の GUI アプリ。

## このプロジェクトについて

詳細は [docs/charter.md](docs/charter.md) を参照。AI が作業するときに最低限知っておくべき要点だけをここに書く。

- **目的**: やるべきことを覚えておく負担をなくし、「今やるべきこと」を示す
- **やらないこと**: 共有・マルチユーザー・クラウド同期はしない。承認なしの外部書き込みは絶対にしない
- **想定ユーザー**: 作者 1 人。データはすべてローカルに置く

## ドメイン用語

| 用語 | 意味 |
|------|------|
| Source | todo の取得元ツール（Slack, Gmail, GitHub など） |
| Account | Source のアカウント単位（例: 会社の Slack ワークスペース、私用の Gmail） |
| Source Adapter | Source ごとの取得・正規化・差分検知を担う実装。共通インターフェースを持つ |
| Source Item | Source から取得した 1 件（PR、スレッド、メール、予定など）。外の世界の写しで、Task とは別の概念（[ADR-0007](docs/decisions/0007-separate-source-items-from-tasks.md)） |
| Activity | Source Item に起きた出来事（appeared / changed / resolved / reopened / removed）。そのままでは更新マークにならない |
| Link | Task と Source Item のつながり。tracks（完了を決める）と context（関連情報）。1 つの Item が属せる Task は 1 つまで |
| Task | 自分がやること。Source の言葉ではなく自分にとっての意味（title: 何をするか、brief: 今の状況と次の一手）で持つ。手動追加の Task もある |
| Task Change | Task の項目の変化（どの項目が何から何に）。更新マークはこれにだけ付く |
| triage | Source Item の仕分け状態（pending: 未判定 / linked: Task に紐づけ済み / ignored: 対象外） |
| Label / Priority | AI や規則で Task に付与される分類と優先度 |
| Sync | ポーリングで Source の状態変化を取得し、Task に反映する処理 |
| Agent Thread | Task ごとの AI Agent との会話履歴 |
| Pre-work | AI がユーザーの依頼を待たずに先回りして進める作業 |
| 定期の Task | 決まった時期（毎月 N 日など）に、決まった手順つきで作られる Task。決まりは `recurring_tasks` に持つ（[ADR-0011](docs/decisions/0011-recurring-tasks.md)） |
| Approval | 外部への書き込み（返信、コメント、送信など）をユーザーが承認する手続き |
| LLM Profile | 使う LLM プロバイダ・モデル・認証情報の組み合わせ。当面は PC 単位で 1 つ |
| Epic | Task をまとめる親。Epic → Task の 2 段だけ。自動で作られる |
| 未分類 | どの Epic にも入っていない Task |
| 更新マーク | 未読の Task Change がある Task に付く目印。Source 側の変化ではなく Task の項目が変わったときだけ付く |
| Decisions provider | 確率付きの判定 API（Jev / OpenAI Decisions / Gemini Decisions） |
| 要確認 | 判定の確率が閾値の中間、または refusal だった Task の置き場 |
| SnapshotDiffer | 全件取得の結果を前回の fingerprint と比べて SourceChange に変換する共通処理 |
| Watcher | 見張りの共通部分。WatchProvider（見張る対象の一覧）と Condition（困った状態か）から Condition Item を作る（[ADR-0008](docs/decisions/0008-watchers.md)） |
| Condition Item | 条件が成り立っている間は open、解消したら resolved になる Source Item。source 名は `<source>:watch` |

## AI 協働ルール

- 外部サービスへの書き込みを行うコードは、必ず Approval を経由する設計にする。承認を迂回できる経路を作らない
- 会社アカウントのデータを別の LLM Profile に送る経路を作らない（[charter の前提と制約](docs/charter.md#前提と制約) を参照）
- Source Item の本文やトークンをログに出さない
- テストのない変更を入れない。新しい Source Adapter は実 API ではなくフィクスチャでテストする
- 判定の refusal や想定外の応答は「要確認」に倒す（fail closed）。否定判定として扱わない
- 実 LLM / Decisions API はテストから呼ばない（課金されるため）。provider はテストダブルに差し替える
- 実装は Effect 4 で書く（[ADR-0005](docs/decisions/0005-adopt-effect.md)）。API は v3 から大きく変わっているので、記憶や外部記事ではなく `node_modules/effect/CLAUDE.md`・`node_modules/effect/ai-docs/`・型定義を一次情報にする
  - エラーは `Schema.TaggedError` で定義し、`throw` しない
  - 依存は `Context.Service` で表し、テストでは `Effect.provideService` で差し替える
  - 外部データ（LLM の出力、API の応答、ユーザー設定）は `Schema` でデコードする
  - 時刻は `DateTime` / `Clock` を使う（`Date.now` を使わない）。テストでは `TestClock` で固定する
  - テストは `@effect/vitest` の `it.effect` で書く

## 触れてほしくない領域

- `.env.local` — API キー・トークンの置き場所。読まない、出力しない
- `drizzle/` — drizzle-kit が生成するマイグレーション。手で編集せず、`src/core/db/schema.ts` を直して `pnpm db:generate` で作り直す
- ローカル DB ファイル（場所は実装時に追記）— 実データが入っているため直接編集しない

## 仕様（live-spec）

- 振る舞いの仕様（どの状態で・誰が・何をできるか）の正本は `specs/*.spec.ts`。1 ファイル 1 ドメインオブジェクトで置き、書き方は live-spec-authoring skill に従う（[ADR-0015](docs/decisions/0015-adopt-live-spec.md)）
- 振る舞いを変えるときは、実装より先に spec を直す。`pnpm spec:check` を通し、生成した図と一覧（`pnpm spec`）をユーザーに見せて振る舞いが決まってから実装する。実装に合わせて spec を書き換えない
- spec からコードを指さない（`// 根拠: path:line` と `live-spec.evidence.lock` は使わない。live-spec-from-code skill で書き起こすときも同じ）。spec と実装が合っているかはテストで確かめる
- 生成した仕様書（HTML / Markdown）はコミットしない
- 人の判断が要ることは推測で埋めず、spec の `questions` に書く。決まった理由を残したいときは ADR に書く

## 開発環境

- **ツールを追加するとき**: `flake.nix` の `devShells.default` の `packages` へ追加する。グローバルインストールはしない
- **npm 依存を追加するとき**: `pnpm add` を使う。pnpm の設定は `pnpm-workspace.yaml` に書き、`.npmrc` や `package.json` の `"pnpm"` フィールドには書かない。`ERR_PNPM_IGNORED_BUILDS` が出たら、ビルドが本当に必要か判断してから `pnpm approve-builds <pkg>` する
- **環境変数を増やすとき**: `.env.example` にキーと説明だけを追記する（非秘匿値は `.env`、秘匿値は `.env.local`）
- **worktree で足りないファイルがあるとき**: `.worktreeinclude` に追記する

構成の詳細は [docs/architecture.md](docs/architecture.md) を参照。

## プロジェクト特有のワークフロー

TBD（次回更新時に決定）

## 主要な設計判断（要点のみ）

- データはローカル保存、推論は外部の LLM API（プロバイダは切り替え可能）
- Source ごとの差異は Source Adapter で吸収し、Task 側は Source に依存しない
- macOS 向けの Electron + TypeScript。Sync・Adapter・Agent・秘匿情報は main プロセスに置き、renderer には API キーもトークンも渡さない（[ADR-0002](docs/decisions/0002-desktop-app-stack.md)）
- 実装は Effect 4。LLM は `effect/ai`、DB は Drizzle ORM の Effect 版を使う（[ADR-0005](docs/decisions/0005-adopt-effect.md)、[ADR-0006](docs/decisions/0006-drizzle-on-effect-sql.md)）
