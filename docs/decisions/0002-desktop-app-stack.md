# ADR-0002: アプリ基盤に Electron + TypeScript を採用する

- **Status**: Accepted（LLM の抽象と DB は [ADR-0005](0005-adopt-effect.md) で置き換え）
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

live-todo は、8 つの Source（Slack / Gmail / GitHub / Google Calendar / Google Docs / Notion / Outlook / Teams）を常駐してポーリングし、複数の LLM プロバイダと会話するローカル完結の GUI アプリである（[charter](../charter.md)）。基盤を選ぶ軸は次の 4 つ。

1. ウィンドウを閉じてもポーリングを続けられる（トレイ・メニューバー常駐）
2. 8 Source 分の OAuth トークンと LLM の API キーを、OS のキーチェーンで暗号化して保存できる
3. 各 Source の公式 SDK と、複数 LLM を扱う SDK をそのまま使える
4. 1 人でメンテナンスし続けられる（charter の撤退条件「メンテが月に数時間を超え続けたら」に直結する）

利用者は作者 1 人で、対象 OS は macOS だけ。

## Decision

- アプリ基盤は **Electron**、言語は **TypeScript** に統一する
- Sync・Source Adapter・AI Agent・秘匿情報の扱いはすべて **main プロセス** に置き、renderer は UI だけを担う。トークンと API キーは renderer に渡さない
- 外部への書き込みは main プロセスの Approval を必ず通る
- 主要ライブラリ

| 領域 | 採用 |
|------|------|
| UI | React + Vite |
| カンバン | dnd-kit |
| DB | SQLite（better-sqlite3）+ Drizzle ORM |
| LLM | Vercel AI SDK（Anthropic / OpenAI / Google / Azure / Bedrock の各プロバイダ） |
| 秘匿情報 | Electron `safeStorage`（macOS Keychain） |
| テスト | Vitest。UI の E2E は必要になったら Playwright |
| パッケージ管理 | pnpm（版は `packageManager` で固定し、corepack で起動する） |

- 対象 OS は macOS に限る

## Alternatives Considered

- **Tauri v2**: 配布サイズとメモリ使用量は優れている。しかし必要な SDK がすべて Node 向けのため、Node の sidecar を同梱することになり、Rust + Node + Web の 3 層構成になる。1 人でのメンテ負荷が撤退条件に触れやすいため見送った
- **ローカル Web サーバー + ブラウザ**: 構成は最も単純だが、ブラウザを閉じた後の常駐、トレイ、キーチェーン連携を自前で用意する必要がある。結局デスクトップアプリの機能を作り直すことになるため見送った
- **React 以外の UI フレームワーク（Svelte / Vue など）**: 特に強い理由がなく、dnd-kit などカンバン周りのライブラリが最も揃っている React を選んだ

## Consequences

### Positive

- main・renderer・ツール類を TypeScript 1 言語で書ける
- 各 Source の公式 SDK と Vercel AI SDK を追加の橋渡しなしで使える
- トークンを main プロセスに閉じ込められるので、renderer（Web 側）の脆弱性がトークン漏えいに直結しにくい

### Negative

- アプリのサイズとメモリ使用量が大きい（利用者が自分だけなので許容する）
- Electron のメジャーアップデート（おおむね 8 週間ごと）への追従が必要
- better-sqlite3 はネイティブモジュールなので、Electron の版に合わせたリビルドが必要になる

### Neutral

- macOS 限定なので、Windows / Linux 向けの検証はしない。対象 OS を広げる場合は新しい ADR を書く

## References

- [architecture.md](../architecture.md)
