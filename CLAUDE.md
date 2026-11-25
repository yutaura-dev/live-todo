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

## AI 協働ルール

- 外部サービスへの書き込みを行うコードは、必ず Approval を経由する設計にする。承認を迂回できる経路を作らない
- 会社アカウントのデータを別の LLM Profile に送る経路を作らない（[charter の前提と制約](docs/charter.md#前提と制約) を参照）
- Source Item の本文やトークンをログに出さない
- テストのない変更を入れない。新しい Source Adapter は実 API ではなくフィクスチャでテストする

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
