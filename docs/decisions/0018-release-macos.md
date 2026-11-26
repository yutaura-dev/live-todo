# ADR-0018: macOS 向けのアプリを、タグの push で署名・公証して GitHub の Release に載せる

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

live-todo を開発環境（`pnpm app:dev`）からではなく、アプリとして使いたい。使うのは macOS（Apple Silicon）。ダウンロードしたアプリは、署名と公証がないと Gatekeeper に止められる。

アプリにして初めて現れる問題もある。

- Finder から起動したアプリの PATH は `/usr/bin:/bin:/usr/sbin:/sbin` だけで、nix や Homebrew で入れた `gws`・`claude`・`gh` が見つからない
- パッケージには省略できる依存（optional peer）が入らない。まとめた入口から読む import は、使わない部品の依存まで探して起動に失敗する（`@effect/platform-node` の `NodeRedis` が `redis` を探していた）

## Decision

- electron-builder で、Apple Silicon（arm64）向けの dmg と zip を作る。DB のマイグレーション（`drizzle/`）を同梱する
- `v1.2.3` の形のタグを push したら、GitHub Actions（`macos-15`）で作り、Developer ID で署名し、App Store Connect の API キーで公証して、下書きの Release に載せる。公開は人が確かめてからする
  - 版はタグから決め、`package.json` は書き換えない
  - 署名と公証の secrets は `release` environment にだけ置く。欠けていたら署名しないまま進まずに止める
  - Release は workflow の `gh release create` で作り、electron-builder に GitHub のトークンを渡さない
  - action はコミットの SHA で固定する。キャッシュは使わない（配るものを作るジョブで、汚染されうるキャッシュを読まない）
- 作った版をそのまま起動して（`LIVE_TODO_SMOKE=1`）、画面を読み込めるかを確かめてから Release に載せる
- 配る版は、起動時にログインシェル（`-ilc`）の PATH を読み込み、今の PATH の前に足す
- main では、まとめた入口ではなく、使う部品のパスから import する（`@effect/platform-node/NodeServices`）
- 自動更新は、まだ入れない

## Alternatives Considered

- **署名しない（ad-hoc）**: 開くたびに Gatekeeper に止められ、`xattr` で属性を消す手間がかかる。自動更新（Squirrel.Mac）も使えない
- **Universal（Intel と両方）**: 使う Mac は Apple Silicon だけで、サイズが約 2 倍になる
- **electron-builder の publish で Release を作る**: electron-builder に GitHub のトークンを渡すことになる。下書きにする手順も workflow に書いた方が読みやすい
- **省略できる依存（`redis`）を依存に足す**: 使わない部品のために依存を増やすことになる
- **main を依存ごと 1 つにまとめる（bundle）**: 起動の失敗は防げるが、ビルドの設定が大きく変わる。まずは import を直す

## Consequences

### Positive

- ダブルクリックで開けるアプリを、タグの push だけで作れる
- 配る版でしか起きない起動の失敗を、Release に載せる前に止められる

### Negative

- Apple Developer Program（年 99 ドル）と、証明書・API キーの管理が要る
- 配る版のデータは `~/Library/Application Support/live-todo/` に置くので、開発中のデータは写す必要がある

### Neutral

- アプリのアイコンはまだない（Electron の既定のアイコン）

## References

- [docs/release.md](../release.md)
- https://www.electron.build/code-signing-mac
