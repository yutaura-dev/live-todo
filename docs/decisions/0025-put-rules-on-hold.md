# ADR-0025: ルール（Rule）を保留にする

- **Status**: Accepted
- **Date**: 2026-11-28
- **Deciders**: YutaUra

## Context

ユーザーが決めたルール（ADR-0014。Gmail のラベル・既読・アーカイブ）と、組み込みのルール（ADR-0020 の案）を、Rule と Rule Run の集約として spec にしようとした（PR #6）。その途中で、Task を完了したらメールをアーカイブする、のようなルールは、Task の側の「完了したときにすること」（Completion Effect）として持つほうが自然だと分かった。また、自動でやってよい範囲（ADR-0023）ができ、承認なしで書き込める範囲をユーザーが決められるようになった。

ルールの役割は、この 2 つを踏まえて捉え直す必要がある。

## Decision

- ルールは一旦保留にする。spec は PR #6 に draft のまま置き、ルールがなくても成り立つように spec を作る
- charter の「やること」（カスタムラベル）と「やらないこと」の ADR-0014 の例外には、保留中と書く。今の実装にある Gmail のルールは、実装を spec に合わせるときに扱いを決める
- 再開するときは、Completion Effect と自動でやってよい範囲を踏まえて、ルールが何を担うかから考え直す

## Alternatives Considered

- **今の PR #6 の形で入れる**: Completion Effect・自動でやってよい範囲と役割が重なり、同じ書き込みに経路が 2 つできる

## Consequences

### Positive

- 承認なしの書き込みの経路が、自動でやってよい範囲の 1 つにまとまる

### Negative

- カスタムラベルと、Task の外でメールに当てる操作が、当面 spec にない

## References

- [charter](../charter.md)
- [ADR-0014](0014-user-defined-gmail-rules.md)・[ADR-0023](0023-autonomy-policy.md)
- PR #6
