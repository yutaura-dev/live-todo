> **Stability**: 🌀 evolving
> **最終更新**: 2026-11-25
> **直近の変更 ADR**: [ADR-0007](decisions/0007-separate-source-items-from-tasks.md)

# Plan — live-todo

このプロジェクトの段階的な計画。フェーズの進行や見直しに合わせて更新する。

## 現在のフェーズ

**Phase 0: 立ち上げ**

charter・計画の整備と技術スタックの決定は完了（[ADR-0002](decisions/0002-desktop-app-stack.md)）。同期と判定の設計も決定済み（[ADR-0003](decisions/0003-sync-and-judge-pipeline.md)、[ADR-0004](decisions/0004-epic-and-custom-labels.md)）。残りは Source Adapter の共通インターフェースの実装。

## MVP 定義

「毎朝これを開けば、今日やることが分かる」状態を作る最小構成。

完了条件:
- [ ] GitHub・Slack・Gmail の 3 つから自分の todo を自動で取得できる
- [ ] 取得した Task にラベルと優先度が付き、カンバンに表示される
- [ ] Task が Epic に自動で振り分けられ、まとまる未分類 Task から Epic が自動で作られる
- [ ] カスタムラベルのルール（条件ルール・自然文ルール）を設定できる
- [ ] 元のツール側の状態変化（PR のマージ、スレッドの解決、メールの返信など）で Task が自動で更新される
- [ ] Task を手動で追加できる
- [ ] 作者自身が 2 週間、毎日使い続けられる

## フェーズ計画

### Phase 0: 立ち上げ

**目標**: 技術スタックを決めて、開発を始められる状態にする

**完了条件 (Definition of Done)**:
- [x] GUI の形態と主要な技術スタックを ADR で決定する（[ADR-0002](decisions/0002-desktop-app-stack.md)）
- [x] 同期と判定の方針を ADR で決定する（ADR-0003 / ADR-0004）
- [ ] Source Adapter の共通インターフェースと `SnapshotDiffer` を実装する

### Phase 1 (MVP): 自動収集とカンバン

**目標**: GitHub・Slack・Gmail から集めた Task を、優先度付きのカンバンで見られるようにする

**完了条件**: 上の「MVP 定義」を満たす

**想定タイムライン**: TBD（次回更新時に決定）

**このフェーズで選んだ Source の理由**: 3 つとも状態変化がはっきり取れるので、自動更新を検証しやすい。認証方式もそれぞれ違うため、Source Adapter の共通インターフェースを早い段階で固められる

### Phase 2: AI Agent と承認制の書き込み

**目標**: Task の中で AI Agent と会話・依頼ができるようにする

**完了条件**:
- [ ] Task ごとに Agent Thread を持ち、会話できる
- [ ] LLM プロバイダを設定で選べる（PC 単位）
- [ ] AI が提案した外部への書き込みを、ユーザーが承認してから実行できる

### Phase 3: Source の拡充と先回り実行

**目標**: 普段使うツールをすべてカバーし、AI が先回りして作業を進める

**完了条件**:
- [ ] Google Calendar / Google Docs / Notion / Outlook（Mail・Calendar）/ Teams に対応する
- [ ] AI が片付けられる Task を判定し、Pre-work の結果を Task に添えて示す

### Phase 4: アカウント単位の LLM 切り替え

**目標**: 1 台の PC で会社用と私用のデータを扱えるようにする

**完了条件**:
- [ ] Account ごとに LLM Profile を割り当て、会社のデータが会社の LLM Profile 以外に送られないことをテストで保証する

## マイルストーン

| マイルストーン | 内容 | 状態 |
|----------------|------|------|
| M0 | 技術スタック決定（ADR） | ✅ 完了 |
| M1 | GitHub Adapter + カンバン表示 | ⬜ 未着手 |
| M2 | Slack・Gmail Adapter + 自動更新 | ⬜ 未着手 |
| M3 | MVP で 2 週間運用 | ⬜ 未着手 |
| M4 | AI Agent + Approval | ⬜ 未着手 |

## 計画の見直しトリガー

- MVP で 2 週間使い続けられなかった（撤退条件の判断も併せて行う）
- Source の API 仕様や利用規約の変更で、予定していた取得方法が使えなくなった
- 会社のポリシーで、使える LLM プロバイダや Source が変わった
