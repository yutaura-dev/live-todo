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
| Link | Task と Source Item のつながり（その Item が Task の事実になる）。役割の区別は持たない。1 つの Item は複数の Task の事実になれ、AI も緩めにいくつでも自動で紐づける（間違えたら外す・移すで直す。[ADR-0025](docs/decisions/0025-grow-plans-and-propose-tasks.md)） |
| Task | 自分がやること。Source の言葉ではなく自分にとっての意味（title: 何をするか、brief: 今の状況と次の一手）で持つ。やると決まったものだけを Task にする（確信が高く自動で作った・提案を受け入れた・手で足した・定期の Task から作った・切り出した） |
| Task Activity | Task に起きた出来事（項目が変わった・AI が作業をやめた・書き込めなかった など）。Task が起きた順に足すだけで持つ。Source Item の Activity（Source の出来事）とは別 |
| 振り分け | 届いた Source Item 1 件を、どの Task の事実にし、何を生むかを決める処理（未振り分け / 振り分けた / 対象外 / ユーザー待ち）。既存の Task の計画に足す方に倒し、迷ったら提案にする（[ADR-0025](docs/decisions/0025-grow-plans-and-propose-tasks.md)） |
| Label / Priority | Label は AI や規則で Task に付く分類。Priority は「いつまでに手を付けるとよいか」（今すぐ・今日中・3 日以内・10 日以内・30 日以内・それより先でよい）。期日から手間を引いて規則で決め、決まらなければ Decisions が判定する |
| Sync | ポーリングで Source の状態変化を取得し、Task に反映する処理 |
| Agent Thread | Task ごとの AI Agent との会話履歴 |
| Pre-work | AI がユーザーの依頼を待たずに先回りして進める作業 |
| 定期の Task | 決まった時期（毎月 N 日など）に、決まった手順つきで作られる Task。決まりは `recurring_tasks` に持つ（[ADR-0011](docs/decisions/0011-recurring-tasks.md)） |
| Approval | 外部への書き込み（返信、コメント、送信など）をユーザーが承認する手続き |
| AI Settings | アプリが使う AI の設定（PC に 1 つ）。使い道ごとに 3 つ持つ: Decisions（分類・確率付きの判定。安い）・Generation（文章を伴う Structured Output。Task の説明・計画を作る）・Agent（Claude Code・Codex などで複雑な作業・調査をする）。安い順に上げていき、3 つは独立して選べる。3 つとも使えないとアプリは使えない |
| Epic | Task をまとめる親。Epic → Task の 2 段だけ。自動で作られる |
| 未分類 | どの Epic にも入っていない Task |
| 更新マーク | ユーザーが最後に Task を見たあとに、ユーザー以外が起こした Task Activity がある Task に付く目印。Source 側の変化ではなく、Task の出来事から導く。まだ一度も見ていない Task は「新着」で見せる |
| Decisions provider | 確率付きの判定 API（OpenAI Decisions / Azure OpenAI Decisions / Microsoft-Decision / Jev / Gemini Decisions） |
| 提案 | AI が「この事実から、こういう Task をやるとよい／この Task の計画に足すとよい」と差し出すもの（Task ではない）。判定の確率が中間のときにでき、ユーザーが受け入れる・見送る。確信が上がれば自動で受け入れる |
| SnapshotDiffer | 全件取得の結果を前回の fingerprint と比べて SourceChange に変換する共通処理 |
| Watcher | 見張りの共通部分。WatchProvider（見張る対象の一覧）と Condition（困った状態か）から Condition Item を作る（[ADR-0008](docs/decisions/0008-watchers.md)） |
| Condition Item | 条件が成り立っている間は open、解消したら resolved になる Source Item。source 名は `<source>:watch` |

## AI 協働ルール

- 外部サービスへの書き込みを行うコードは、必ず Approval を経由する設計にする。承認を迂回できる経路を作らない
- 会社アカウントのデータを、会社が許可していない AI（AI Settings に設定していないもの）に送る経路を作らない（[charter の前提と制約](docs/charter.md#前提と制約) を参照）
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
- `drizzle-store/` — 作り直しのアプリ（`src/store/`）のマイグレーション。手で編集せず、`src/store/schema.ts` を直して `pnpm db:generate:store` で作り直す
- ローカル DB ファイル（場所は実装時に追記）— 実データが入っているため直接編集しない

## 仕様（live-spec）

- 振る舞いの仕様（どの状態で・誰が・何をできるか）の正本は `specs/*.spec.ts`。1 ファイル 1 ドメインオブジェクトで置き、書き方は live-spec-authoring skill に従う（[ADR-0015](docs/decisions/0015-adopt-live-spec.md)）
- 振る舞いを変えるときは、実装より先に spec を直す。`pnpm spec:check` を通し、生成した図と一覧（`pnpm spec`）をユーザーに見せて振る舞いが決まってから実装する。実装に合わせて spec を書き換えない
- spec からコードを指さない（live-spec-from-code skill で書き起こすときも同じ）。spec と実装の対応はテストの側から持つ。実装のテストは `describe(specOf(Spec.操作, "理由"), ...)` で spec の条件に結び、`pnpm spec:check`（`--tests src` 付き）を通す。テストで確かめられない条件は、理由を書いて spec の `reviewed` に入れる
- 生成した仕様書（HTML / Markdown）はコミットしない
- 人の判断が要ることは推測で埋めず、spec の `questions` に書く。決まった理由を残したいときは ADR に書く

## 開発環境

- **ツールを追加するとき**: `flake.nix` の `devShells.default` の `packages` へ追加する。グローバルインストールはしない
- **npm 依存を追加するとき**: `pnpm add` を使う。pnpm の設定は `pnpm-workspace.yaml` に書き、`.npmrc` や `package.json` の `"pnpm"` フィールドには書かない。`ERR_PNPM_IGNORED_BUILDS` が出たら、ビルドが本当に必要か判断してから `pnpm approve-builds <pkg>` する
- **@yutaura/live-spec を上げるとき**: 作者自身のパッケージなので、確認せずに最新版へ上げてよい。公開から 24 時間たっていなければ、`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` に完全な版（`"@yutaura/live-spec@x.y.z"`）で書き、前の版の行は消す（名前だけ・範囲では書かない）
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
