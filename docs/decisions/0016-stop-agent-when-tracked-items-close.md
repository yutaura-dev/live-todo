# ADR-0016: AI の処理中に追う項目が片付いたら、Claude Code にやめるか続けるかを判断させる

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

処理中（agent_running）の Task は、同期が status を動かさない。処理が終わると処理前の status（todo など）に戻すので、
処理中に追う PR が merge されても、Task は todo に戻り、次の Activity が来るまで完了にならなかった。
一方で、merge されても続ける意味がある作業（別の PR でも要る修正、merge 後の確認など）もあり、一律に打ち切ると取りこぼす。

## Decision

- 同期が、処理中の Task の追う項目がすべて片付いた（merge・close された、または消えた）ことを見つけたら、`RunInterrupts` を通して処理側に知らせる
- 動いている Claude Code は止め、同じ session を `--resume` で続けて、知らせを伝えて「作業をやめるか続けるか」を判断させる。止めたあとに続けられるよう、新しい会話は `--session-id` で id を先に決めて起動する
  - やめると判断したら、追う項目の今の状態から status を導き直し（merge なら完了、消えたならアーカイブ）、やめた理由を更新マークで知らせる
  - 続けると判断したら、同じ session のまま元の作業を終えさせ、元の形の回答を使う。終わったら今までどおり処理前の status に戻す
  - 決まった形の答えが返らない・失敗したときは、今までの処理の失敗と同じに扱う（処理前の status に戻す）
- 待ち行列にあるだけでまだ Claude Code が動いていない処理は、判断させずに取り消し、追う項目から status を導き直す
- merge を承認して走る処理は、merge 自体が目的なので知らせない
- 判断は Decisions や LLM ではなく、処理中の Claude Code 自身にさせる。何をどこまで進めたかを知っているのはそのセッションだけで、続ける意味を一番正しく判断できるため

## Alternatives Considered

- **処理が終わってから status を導き直す**: 作りは簡単だが、merge 後も意味のない作業を最後まで走らせ、費用と時間がかかる
- **Decisions に判断させる**: 安く確率で扱えるが、作業の途中経過を知らないので、続ける意味を判断する材料がない
- **一律に打ち切って完了にする**: merge 後も要る作業を取りこぼす

## Consequences

### Positive

- merge された PR の Task が、処理中だったせいで todo に残ることがなくなる
- 意味のなくなった作業を途中で止められ、費用を抑えられる

### Negative

- 止めるときに、Claude Code が途中まで書き換えた作業ディレクトリが残る（続けるなら同じ場所で続け、やめるなら使わない）
- 判断のために Claude Code をもう一度呼ぶので、そのぶんの費用がかかる
- 処理が Claude Code を呼び終えたあと（commit などの後片付けの途中）に知らせが来ても止めない。その場合は今までどおり処理前の status に戻る

## References

- [ADR-0007](0007-separate-source-items-from-tasks.md)
- [ADR-0013](0013-claude-code-reads-broadly.md)
- `specs/task-status.spec.ts` の「知らせを受けて AI が作業をやめる」「待ち行列の処理を取り消す」

## のちの見直し（2026-11-28）

specs/agent-run.spec.ts で次のように見直した。

- AI が作業中かは、Task の agent_running ではなく Agent Run（Agent Thread）の段階で決まる
- 追う項目が片付いて Claude Code が作業をやめても、Task の列は変えない。片付いたことは事実の変化として Task が受け取り（receive）、Task の言葉に置き換える
- Task を終える・やらないことにするほうを、この判断より先にする（作業はアプリがやめ、途中までの報告を残す）
