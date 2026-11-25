# ADR-0001: アーキテクチャ判断記録方式の採用

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

このリポジトリの設計判断を、後から「なぜそう決めたか」を追えるように残したい。git log とコミットメッセージだけでは、判断の背景や検討した代替案が散逸する。

## Decision

Michael Nygard 形式の Architecture Decision Record (ADR) を `docs/decisions/` ディレクトリで運用する。

- 1 つの ADR には 1 つの決定を記録する
- ファイル名は `NNNN-short-title.md`（NNNN は連番）
- 構成は Context / Decision / Alternatives Considered / Consequences
- 採用した決定は書き換えない。変えるときは新しい ADR を書いて Supersede する

`docs/charter.md` を改訂するときは ADR を必須とする。`docs/architecture.md` の重要な変更時は推奨とする。

## Alternatives Considered

- **コミットメッセージだけで残す**: 背景や代替案が散逸しやすい
- **wiki / Notion などの外部ツール**: git で管理されないので、コードと同期しなくなる
- **CHANGELOG.md にまとめる**: 「変更ログ」と「決定の根拠」は性質が違い、混ぜると読みにくい

## Consequences

### Positive

- 重要な判断の根拠が残り続ける
- 後から参加した人（将来の自分や AI を含む）が、過去の判断の経緯を理解できる
- charter.md の不変領域を変えたときに履歴が残る

### Negative

- ADR を書く手間がかかる
- 「これは ADR にすべきか」の判断に迷うことがある

### Neutral

- 個人開発なので ADR の数は少なくて済む見込み（無理に増やさない）

## References

- [Michael Nygard, "Documenting Architecture Decisions" (2011)](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [adr.github.io](https://adr.github.io/)
