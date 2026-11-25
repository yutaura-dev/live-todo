# live-todo

Slack・Gmail・GitHub などに散らばった「自分がやるべきこと」を自動で集め、優先度をつけて「今やるべきこと」を示すローカル完結の GUI todo アプリ。

## なぜこれが必要か

やるべきことを記憶して、こなしていくのは面倒で、しかもすぐ忘れる。依頼やレビュー待ち、返信待ちは複数のツールに散らばっていて、それぞれを見に行かないと把握できない。

live-todo は各ツールから自分の todo を自動で集め、ラベルと優先度をつけてカンバンに並べる。元のツール側で状況が変われば（PR がマージされた、スレッドが解決した、など）タスクも自動で更新する。各タスクの中では AI Agent と会話したり作業を依頼したりでき、AI だけで片付くものは先回りして処理しておく。

詳細は [docs/charter.md](docs/charter.md) を参照。

## クイックスタート

```sh
direnv allow          # nix devShell と .env を有効化（初回のみ）
cp .env.example .env  # 自分の環境の値を記入（秘匿値は .env.local へ）
pnpm install          # pnpm は corepack が packageManager の版で起動する
```

> 依存は nix flake で固定されている。詳細は [docs/architecture.md](docs/architecture.md) を参照。

## 機能（予定）

- 各ツールからの todo 自動収集（Slack / Gmail / GitHub / Google Calendar / Google Docs / Notion / Outlook / Teams）
- 自動ラベリングと優先度付け、「今やるべきこと」の提示
- ポーリングによる状況変化の検知とタスクの自動更新
- GitHub Projects 風のカンバン UI と手動での todo 追加
- タスクごとの AI Agent との会話・依頼、AI による先回り実行（外部への書き込みは承認制）
- LLM プロバイダの選択（Claude / OpenAI / Gemini / Azure OpenAI / Bedrock など）

段階的なリリース計画は [docs/plan.md](docs/plan.md) を参照。

## ドキュメント

- [docs/charter.md](docs/charter.md) — 存在意義・スコープ・撤退条件 🪨
- [docs/plan.md](docs/plan.md) — フェーズ・マイルストーン 🌀
- [docs/architecture.md](docs/architecture.md) — 技術スタック・設計判断 🌊
- [docs/decisions/](docs/decisions/) — Architecture Decision Records

## 貢献

個人用ツールとして作者 1 人でメンテナンスしている。外部からの貢献は現時点では想定していない。

## ライセンス

TBD（次回更新時に決定）
