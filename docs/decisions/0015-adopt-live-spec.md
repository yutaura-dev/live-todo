# ADR-0015: 振る舞いの仕様を live-spec で書き、実行して検査する

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

Source Item の triage、Task の status、Approval のように、「どの状態で・誰が・何をできるか」で決まる振る舞いが増えてきた。
今は docs/architecture.md の文章とコードにしか書かれておらず、実装を AI が変えたときに、振る舞いが意図どおりかを人が確かめにくい。

## Decision

- 振る舞いの仕様は live-spec（`@yutaura/live-spec`）で、`specs/*.spec.ts` に 1 ファイル 1 ドメインオブジェクトで書く。spec は AI が書き、人は生成された状態遷移図と「できる／できない」の一覧を見てレビューする
- spec の書き方は live-spec 同梱の skill（live-spec-authoring / live-spec-from-code / live-spec-review）に従う。skill は drizzle-kit と同じく pnpm の `permissions` で承認し、`.claude/skills/` にリンクする
- 振る舞いの正本は spec で、実装はそれに従う。振る舞いを変えるときは先に spec を直し、生成した図と一覧で振る舞いを決めてから実装する。実装に合わせて spec を書き換えない
- spec からコードを指さない。コードを指すと、実装が変わるたびに spec を追従させることになり、実装が正本になってしまうため
- spec と実装の対応はテストの側から持つ。実装のテストは `specOf`（`@yutaura/live-spec/testing`）で spec の条件に結び、`live-spec check specs/ --tests src` で、どのテストも確かめていない条件がないかを検査する。テストで確かめられない条件（誰が起こすかが呼び出し口だけで決まるものなど）は、理由を書いて `reviewed` に入れる
- 生成した仕様書はコミットしない
- 役割を分ける。charter・ADR は「なぜ」（何をやらないか、判断の理由）、spec は「どう振る舞うべきか」。architecture.md の状態や権限を文章で説明している部分が spec と重なったら、spec を正にして文書側は spec へのリンクにする

## Alternatives Considered

- **docs/architecture.md の文章で書き続ける**: 実行も検査もできず、コードとずれても気づけない
- **振る舞いをテスト（vitest）だけで表す**: 実装の正しさは確かめられるが、人が一覧や図として読めず、「できないのは誰か・いつか」の抜けを見つけにくい

## Consequences

### Positive

- 振る舞いの変化を、コードの差分ではなく状態遷移図と一覧の差（`live-spec diff`）でレビューできる
- 振る舞いを実装の前に図と一覧で決められるので、作ってから「思っていたのと違う」と気づくことが減る

### Negative

- 振る舞いを変えるたびに、実装の前に spec の更新とその確認が要る
- 条件ごとにテストを結ぶ手間がかかる
- live-spec は公開されたばかりで版の更新が速い。pnpm の `minimumReleaseAge` を満たさない版を入れるときは、`minimumReleaseAgeExclude` に完全な版で例外を書く

## References

- [ADR-0007](0007-separate-source-items-from-tasks.md)
- [architecture](../architecture.md) のドメインモデル
