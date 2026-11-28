# サービスのアイコン

取得元のサービスを示す小さなアイコン。どれも各社が配っているファイルを、中身に手を加えずに置いている（色・形・余白を変えない）。
ファイル名だけを取得元の名前に変えている（`brand-icons.ts` がファイル名から読み込むため）。ダーク用は名前に `-dark` を付ける。

| ファイル | 元のファイル | 配布元 | 取得日 |
|---|---|---|---|
| github.svg / github-dark.svg | `GitHub_Invertocat_Black.svg` / `GitHub_Invertocat_White.svg` | https://brand.github.com/foundations/logo の `GitHub_Logos.zip` | 2026-11-28 |
| notion.svg / notion-dark.svg | `notion-logo-block-main.svg` / `notion-logo-block-mono-white.svg` | https://notion.notion.site/Logos-6331ef1fc18241f8bae8a4b923b05ce4 の `notion-logos-2024.zip` | 2026-11-28 |
| gmail.svg / calendar.svg | `gmail.svg` / `calendar.svg` | https://knowledge.workspace.google.com/admin/getting-started/brand-your-internal-communications-with-google-workspace の製品アイコン | 2026-11-28 |
| outlook.svg / teams.svg | `outlook_48x1.svg` / `teams_48x1.svg` | Microsoft の Fluent UI の Office Brand Icons（https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/） | 2026-11-28 |
| slack.svg | `SLA-Slack-icon-RGB.svg` | Slack のメディアキット（https://slack.com/media-kit →「ロゴ」→ https://salesforce.widencollective.com/c/yn6bxnam）と同じファイルを、https://github.com/m4ttstack/mattstack/tree/e51b343373e0a17d7fd46aacd631dfa6b78d7a0d/apps/board/src/assets/slack から取った | 2026-11-28 |

## 使う条件について（作者の判断を残す）

- GitHub・Notion・Google は、連携先を示すために改変せず使うことを、各社のブランドページが認めている（GitHub: "Use a permitted GitHub logo to inform others that your project integrates with GitHub."）
- **Slack と Microsoft（Outlook・Teams）は、ロゴの利用にライセンスが要り、再配布も認めていない**（Slack ブランド利用規約・Microsoft Trademark and Brand Guidelines）。
  個人で使うツールなので、作者の判断で、許可を得ずに使っている。問題を指摘されたら、このファイルを消せば名前の文字に戻る
