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
| Source Item | Source から取得した元データ（メッセージ、PR、メール、予定など） |
| Task | Source Item から作られる todo。手動追加の Task もある |
| Label / Priority | AI や規則で Task に付与される分類と優先度 |
| Sync | ポーリングで Source の状態変化を取得し、Task に反映する処理 |
| Agent Thread | Task ごとの AI Agent との会話履歴 |
| Pre-work | AI がユーザーの依頼を待たずに先回りして進める作業 |
| Approval | 外部への書き込み（返信、コメント、送信など）をユーザーが承認する手続き |
| LLM Profile | 使う LLM プロバイダ・モデル・認証情報の組み合わせ。当面は PC 単位で 1 つ |
| Epic | Task をまとめる親。Epic → Task の 2 段だけ。自動で作られる |
| 未分類 | どの Epic にも入っていない Task |
| 更新マーク | 未読の TaskChange（状態や内容の変化）がある Task に付く目印 |
| Decisions provider | 確率付きの判定 API（Jev / OpenAI Decisions / Gemini Decisions） |
| 要確認 | 判定の確率が閾値の中間、または refusal だった Task の置き場 |
| SnapshotDiffer | 全件取得の結果を前回の fingerprint と比べて SourceChange に変換する共通処理 |

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
- ローカル DB ファイル（場所は実装時に追記）— 実データが入っているため直接編集しない

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
- 実装は Effect 4。LLM は `effect/ai`、DB は `effect/sql` を使う（[ADR-0005](docs/decisions/0005-adopt-effect.md)）
