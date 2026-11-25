> **Stability**: 🌊 living
> **最終更新**: 2026-11-25
> **直近の変更 ADR**: なし（初版）

# Architecture — live-todo

このプロジェクトの技術構成と設計判断。実装に合わせて自由に更新する。重要な設計判断は `decisions/` に ADR として記録する。

## 全体構成

ローカルで動く GUI アプリ。アプリ内でポーリングして Source から取得し、ローカル DB に保存する。推論だけを外部の LLM API に投げる。

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

## 技術スタック

**未確定**。Phase 0 で ADR を書いて決める。下の表は候補であり、決定ではない。

| 領域 | 候補 | 備考 |
|------|------|------|
| GUI 形態 | デスクトップアプリ（Tauri など）/ ローカル Web サーバー + ブラウザ | ローカル完結・常駐ポーリングならデスクトップアプリが自然 |
| 言語 | TypeScript（+ Tauri なら Rust） | TBD |
| データストア | SQLite | ローカル完結のため |
| LLM 抽象 | Vercel AI SDK / LiteLLM など | 複数プロバイダと tool calling の差分を吸収できるもの |
| 秘匿情報の保存 | OS のキーチェーン | トークンを平文の設定ファイルに置かないため。TBD |
| 開発環境 | nix flake + direnv | 版を `flake.lock` で固定し、手元・CI・worktree を揃える |

## 開発環境

| ファイル | 役割 |
|----------|------|
| `flake.nix` / `flake.lock` | 言語ランタイム・CLI ツールの固定。追加は `devShells.default` の `packages` へ |
| `.envrc` | `use flake` で devShell を有効化し、`dotenv_if_exists` で `.env` / `.env.local` を読み込む |
| `.env` | 非秘匿の環境差分。gitignore |
| `.env.local` | 秘匿値（API キー・トークン）。gitignore |
| `.env.example` | 上の 2 つの雛形。キーと説明だけを書く |
| `.worktreeinclude` | worktree 作成時にコピーする gitignore 対象ファイルの一覧 |

devShell には現時点で Node.js と pnpm だけを入れている。技術スタックが決まったら追加する。

## 主要な設計判断

- [ADR-0001: アーキテクチャ判断記録方式の採用](decisions/0001-record-architecture-decisions.md)
- 設計の方針（ADR 化は技術スタック決定時に行う）
  - Source ごとの差異は Source Adapter に閉じ込め、Task・UI は Source に依存させない
  - 外部への書き込みは Approval を必ず通す。Adapter の書き込みメソッドは、承認済みの操作しか受け付けない形にする
  - 設定は最初から `Account → LLM Profile` の構造で持ち、当面は PC 単位の既定値だけを使う（Phase 4 で作り直しにならないように）

## 外部依存

| 依存先 | 用途 | リスク |
|--------|------|--------|
| Slack API | メッセージ・メンション・スレッドの取得 | レート制限、ワークスペース側のアプリ承認が要る場合がある |
| Gmail API / Google Calendar API / Google Drive API | メール・予定・Docs のコメントの取得 | Google OAuth の審査範囲、トークンの有効期限 |
| GitHub API | Issue / PR / レビュー依頼 / 通知の取得 | レート制限 |
| Notion API | ページ・メンション・割り当ての取得 | インテグレーションへのページ共有が必要 |
| Microsoft Graph | Outlook（Mail・Calendar）・Teams の取得 | 会社テナントでのアプリ同意が必要な場合がある |
| LLM API（Claude / OpenAI / Gemini / Azure OpenAI / Bedrock） | ラベリング・優先度付け・Agent・Pre-work | 従量課金のコスト、会社ポリシー上の利用可否 |

## 非機能要件

- **性能**: TBD（次回更新時に決定）
- **可用性**: アプリ起動中にポーリングが動けばよい。常時稼働は求めない
- **セキュリティ**: トークンと Source Item の本文をログに出さない。外部への書き込みは承認制。会社のデータは会社が許可した LLM にだけ送る

## テスト戦略

TDD で進める。Source Adapter は実 API ではなく、記録したレスポンスのフィクスチャでテストする。詳細は TBD（次回更新時に決定）。

## 監視・観測

TBD（次回更新時に決定）。少なくとも、Source ごとの最終同期時刻とエラーを UI で確認できるようにする。

## デプロイ

自分の PC にインストールして使う。配布形式は技術スタックの決定に合わせて決める（TBD）。
