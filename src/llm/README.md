# src/llm

アプリが AI を呼ぶ口と、呼ぶ内容（問い・書き物）の定義。アプリの実装と、LLM の評価・ベンチマーク・改善は、どちらもここの定義を import する（I/F をずらさないため）。

## 分け方

| ディレクトリ | 役割（AI Settings） | 呼ぶ口 | 定義 |
|---|---|---|---|
| `decision/` | Decisions: 確率付きの判定。理由は返さない | `Decisions.ask(question, input)` | `decision/questions/` |
| `generation/` | Generation: 文章を伴う Structured Output | `Generation.write(writing, input)` | `generation/writings/` |
| `agent/` | Agent: Claude Code などで作業・調査をする | `AgentRunner.run(request)` / `askToStop` | `agent/agent.ts` |
| `shared/` | 3 つに共通の型 | — | 答え・閾値・記録・材料・語彙 |

文章が要らない判定（真偽・分類・段階）は Decisions にし、文章を書くものだけを Generation にする。

## 決まりごと

- **答えなかったことは値で返す**: `Answer<A>` は `Answered` か `Unanswered`（Refused / Invalid / Missing）。否定の答えとして扱わず、ユーザーに回す（fail closed）
- **届かなかったことはエラーで返す**: `AiUnreachableError`（認証・上限・通信・provider）。Task も振り分けも変えず、次の同期でやり直す
- **閾値は問いごとに決め打ち**（AI 設定に持たない）。今の値は仮で、ベンチマークで決める。解釈の関数（`interpret*`・`routingBand` など）は、spec の判断表が読む区分（高い・中間・低い・判断できなかった など）を返す
- **記録**: 呼ぶたびに `CallRecord`（問いの ID・版・確率・トークン）を返す。入力の中身は持たない（本文を残さない）
- **版**: 問い・指示の文面や入出力の形を変えたら `version` を上げる
- **外の文と指示を分ける**: 外の人が書いた文は入力（`FactContent.external`）にだけ置き、問い・指示には入れない
- **テスト**: 実 API を呼ばず、`decisionsTest` / `generationTest` / `agentTest` に差し替える

## 一覧

### Decisions

| ID | 判定すること | 使うところ（spec） |
|---|---|---|
| `routing.fact-requests-work` | この事実は、自分に作業を求めているか（低ければ作業の切り出しを呼ばない） | routing |
| `routing.fact-belongs-to-task` | この事実は、候補の Task の事実か（判定 1） | routing |
| `routing.work-outlives-task` | この作業は、Task の完了条件を満たしたあとも残るか（判定 2） | routing |
| `routing.work-needs-new-action` | この作業に、新しく行動が要るか（判定 3。識別子は渡さない） | routing・task-proposal |
| `task.arrival-impact` | 届いた事実で、Task の何が変わるか | task（receive） |
| `task.detach-needs-replan` | 事実を外したあと、計画を見直すか | task（detachFact） |
| `task.blocks-others` | 自分の返事が他の人を止めているか | task・priority |
| `priority.level` | 規則で決まらない Task の優先度 | prioritization |
| `priority.blocking-now` | 止めている Task を今すぐにするか | prioritization |
| `decision-point.option-aspects` | 選択肢ごと・観点ごとに良い・差がない・悪い | action-definition（Option） |
| `decision-point.recommendation` | おすすめの選択肢 | action-definition（Decision） |
| `plan.item-effort` | Action Item の手間 | action-definition（effort） |

### Generation

| ID | 書くもの | 使うところ（spec） |
|---|---|---|
| `routing.extract-work` | 事実が求める作業の切り出し（0 個以上） | routing |
| `task.draft` | 新しい Task の題・今の状況・期日 | task・task-proposal |
| `proposal.reason` | 提案の「今の状況と、なぜ提案するか」 | task-proposal |
| `plan.draft` | 計画（Action Item の木。手間・得るもの・失うもの・おすすめは持たない） | task（revisePlan） |
| `task.rewrite` | 届いたもの・AI の作業の成果を受けた、題・今の状況・計画の書き直し | task（receive） |
| `decision-point.point-details` | 得るもの・失うものの中身（観点は Decisions が決めたもの） | action-definition |
| `decision-point.recommendation-reason` | おすすめの理由 | action-definition |
| `recurring.draft` | 定期の Task の決まりの下書き | recurring-task |

### Agent

`AgentRunner.run` に、作業の種類（質問に答える・Action Item をやる（読むだけ／直す）・依存の更新を調べる・PR を直す・コンフリクトを直す）と道具の段（読むだけ・直す。種類から決まる）を渡す。成果は回答・報告・差分のどれかで、Task Input（AI の作業の成果）として届け、`task.rewrite` で Task の言葉にする。外へ書き込む道具の段はない。
