# ADR-0022: AI は役割ごとに 3 つを選び、確かさで上げていかない

- **Status**: Accepted
- **Date**: 2026-11-28
- **Deciders**: YutaUra

## Context

これまでの LLM Profile は、プロバイダとモデルを 1 組持ち、Decisions provider を足せる形だった（ADR-0003）。アカウントごとに Profile を選べ、charter は「将来はアカウントごとに LLM Profile を切り替える」としていた。

実際には、アプリが使う AI には役割の違う 3 つがある。分類と確率付きの判定（安い）、文章を伴う Structured Output（Task の説明・計画）、複雑な作業と調査（Claude Code など）。これを 1 組で表すと、Claude Code が Profile に関係なく Anthropic に送るような食い違いが出た。

また、ADR-0003 の fallback（Decisions が使えなければ chat の LLM で判定する）は、Decisions で分からないことを、ほかの LLM に聞けば分かるかのような形になっていた。

## Decision

- AI Settings（PC に 1 つ）に、役割ごとに 3 つを独立して選ぶ。Decisions は OpenAI、Generation は Gemini、Agent は Claude Code、のように選べる
  - **Decisions**: 分類・確率付きの判定（安い）
  - **Generation**: 文章を伴う Structured Output。Task の説明・計画を作る。Agent の成果物も入力にする
  - **Agent**: 複雑な作業・調査（Claude Code・Codex・agy・OpenCode・pi code など）。Task は直接変えない
- 3 つの違いは役割で、確かさの段ではない。Decisions で迷ったら（閾値の間・refusal・形に合わない）、Generation に聞き直さずに要確認に倒す。迷うことがなるべく起きないよう、Decisions に渡す材料と問いの立て方（ハーネス）を作り込む
- どれを使うかは、使う側の判断表で決める（Task が届いたものを受け取るところでは、specs/task.spec.ts の判断表「届いたものを、どの使い道で Task の言葉にするか」）
- 計画を立てるのは Generation（Structured Output なので、ハーネスを直しやすく、答えの形もそろえやすい）。Generation の呼び出しは AI の作業にしない
- Agent に頼むのは、Generation が計画に足した「Claude Code で調べる」などの Action Item からだけ。自動でやるかボタンで頼むかは、ほかの Action Item と同じく計画の中で決める。Agent の成果物は Task Input「AI の作業の成果」として届き、Generation が Task の言葉にする
- 3 つとも設定して確かめるまで、アプリは使えない。どれかの認証が通らなくなったら、直すまでアプリ全体を使えない
- 会社のデータを送ってよいかの設定は持たない。会社の PC には、会社が許可したものだけを設定する。アカウントごとに AI を切り替えることはしない（charter の「将来はアカウントごとに切り替える」をやめる）
- Decisions の閾値は固定で、判定ごとに決める（architecture.md）。設定には持たない

## Alternatives Considered

- **Decisions で迷ったら Generation に聞き直す（上の段に上げる）**: Generation の答えには確率がなく、どれくらい当たっているか分からない答えに頼ることになる（ADR-0003 が退けた自己申告の確信度と同じ）
- **Generation が足りなければ自動で Agent に頼む**: 費用がかかり、知らないうちに走り、Agent の成果からまた Agent に頼む繰り返しが起きうる。計画の Action Item にすれば、今の仕組みで済み、繰り返しも起きない
- **会社のデータを送ってよいかを、使い道ごとに設定する**: 送ってはいけないものは設定しなければよく、設定が増えるだけ

## Consequences

### Positive

- 役割ごとに、安くて合うものを独立して選べる
- Agent が Task を直接変える経路がなくなり、Task の言葉に置き換えるのは Generation か規則に限られる

### Negative

- 3 つとも設定しないとアプリが使えないので、最初の設定の手間が増える
- 今の実装（アカウントごとの Profile・Decisions がなければ structured output で判定）は作り直しになる

## References

- [ADR-0003: 同期と判定のパイプライン](0003-sync-and-judge-pipeline.md)（判定の fallback を置き換える）
- [ADR-0013](0013-claude-code-reads-broadly.md)
- specs/ai-settings.spec.ts・specs/task.spec.ts

## のちの見直し（2026-11-28）

「Agent に頼むのは Action Item からだけ」は、アプリが Agent を始めるときの決まり。ユーザーは直接頼める（質問に答える・PR を直す・コンフリクトを直す。specs/agent-run.spec.ts）。
