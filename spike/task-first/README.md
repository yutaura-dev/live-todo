# spike: Task 起点の振り分けとルール（ADR-0019）

本番のコードには繋がない試し作り。AI を使う部分をベンチマークで磨き、使える形が決まったら `src` に作り直す。

- `model.ts`: 事実（Fact）と Task の dossier、Decisions に渡す形
- `llm.ts`: config.json の LLM Profile から Decisions と LLM を作る
- `rule-condition.ts`: ルールの条件が Task に当てはまるか
- `rule-interpret.ts`: 「何をする」を Task の操作に読み取る
- `attribute.ts` / `candidates.ts`: 届いた事実がどの Task のものか
- `bench/`: 作った例（リポジトリに入れてよいのはこれだけ。実在の案件・人・リポジトリを書かない）
- `data/`: 実データから作った評価用データ（gitignore。リポジトリに入れない）

```sh
direnv exec . pnpm exec tsx spike/task-first/bench/run.ts rule-condition
```
