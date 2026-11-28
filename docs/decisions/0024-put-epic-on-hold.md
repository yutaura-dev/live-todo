# ADR-0024: Epic を保留にする

- **Status**: Accepted
- **Date**: 2026-11-28
- **Deciders**: YutaUra

## Context

charter は「Task を Epic → Task の 2 段で管理する。Epic は自動で作り、Task を振り分ける」としている（ADR-0004）。spec に起こすにあたって DDD の見方で見直したところ、Epic が自分で守る決まりは、名前（ユーザーが決めた名前を AI が書き換えない）と統合くらいしかなかった。進行中・終わったは、入っている Task から算出できる。

算出できるものを保存して、Task が終わるたびにつながりで合わせ続ける形は、どちらかの更新が漏れると食い違う。Task・Action Item・優先度がそろった今、Epic がなくてもボードは使えるかを先に確かめたい。

## Decision

- Epic は一旦保留にする。charter の「やること」からは外さず、保留中と書く
- spec は PR #12 に draft のまま置く。再開するときは、名前・概要・統合だけを持つ小さな形（進行中・終わったは入っている Task から算出して見せる）から考え直す
- 今の実装にある Epic（ADR-0004）は、実装を spec に合わせるときに扱いを決める

## Alternatives Considered

- **今の spec（進行中・終わったを持つ Epic）で入れる**: 算出できる状態を保存することになり、Task とのつながりで合わせ続ける必要がある
- **charter から Epic を外す**: 一旦なしで使ってみてから決めたいので、外すまではしない

## Consequences

### Positive

- 保存する状態とつながりが減り、Task まわりの spec を先に固められる

### Negative

- たくさんの Task を、まとまりで見渡すことができない（必要になったら再開する）

## References

- [charter](../charter.md) のやること
- [ADR-0004](0004-epic-and-custom-labels.md)
- PR #12
