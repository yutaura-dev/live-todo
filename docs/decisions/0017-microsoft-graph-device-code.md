# ADR-0017: Microsoft（Outlook・Teams）は、自分で登録したアプリで device code 認証し、Graph を読む

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

職場の Outlook（メール・予定）と Teams から todo を集めたい。どれも Microsoft Graph で読める。Electron のアプリから職場のアカウントにサインインするには、Entra ID に登録したアプリが要る。

- ブラウザにリダイレクトして戻す方式は、ローカルにリダイレクトを受ける口が要り、会社のテナントではリダイレクト URI の登録が制限されていることがある
- device code 認証なら、アプリはコードを見せて待つだけで、サインインはふだんのブラウザで済む（多要素認証や SSO もそのまま使える）
- 職場のデータなので、charter の制約（会社のデータは会社が許可した LLM にだけ送る）を守る必要がある

## Decision

- 認証は device code 認証（RFC 8628）で行う。アプリはユーザーが自分の Entra ID に登録し、client ID とテナント ID を設定に書く（[手順](../setup/microsoft.md)）。Azure CLI などの Microsoft のアプリの client ID は借りない
- MSAL は使わず、devicecode と token のエンドポイントを HttpClient で呼ぶ。トークンの保存先を秘密情報の暗号化に合わせられ、依存を増やさずに済むため
- 求める権限は `offline_access` と `User.Read` に、使う機能の読み取りの権限を足したものにする。使う機能を変えたら、サインインし直してもらう
- リフレッシュトークンは秘密情報（`microsoft.<id>.refresh_token`）として暗号化して保存する。更新のたびに入れ替わるので、返った方を保存し直す。アクセストークンは保存せず、期限の 5 分前まで使い回す。同時に取り直さないよう 1 本ずつにする
- Graph は v1.0 を読む。401 ならトークンを取り直して 1 回だけやり直す。429・503 は `Retry-After` まで休む。`@odata.nextLink` は Graph の中を指すときだけたどる（外を指していると、アクセストークンを外に送ってしまう）
- Microsoft のアカウントは LLM Profile を書かないと設定が通らないようにする。既定の LLM Profile に黙って流れないようにするため
- Outlook の予定は、Graph の予定（`/me/calendarView`、時刻は `Prefer: outlook.timezone="UTC"`）を Google Calendar と同じ形に直し、同じ出欠・準備・自分の todo の 3 つの Source（頭は `outlook`）に乗せる（[ADR-0016](0016-google-calendar.md)）
  - Graph の予定には作った人がないので、主催なら自分で入れた予定とみなす
  - 終日の予定の日付は、この PC のタイムゾーンで読む。Graph のタイムゾーン名は Windows の名前で、IANA の名前に直す表が要るため
  - 見るのは既定のカレンダーだけ
- 次の段階で、Teams（メンション・未返信のチャット・自分のスレッドへの返信）と、メール（Gmail と同じ仕分け）を足す

## Alternatives Considered

- **Microsoft のアプリ（Azure CLI など）の client ID を借りる**: 登録の手間はないが、ほかのアプリになりすます形になり、会社の条件付きアクセスやアプリの管理に触れやすい
- **ブラウザにリダイレクトする認可コードの方式（PKCE）**: ローカルでリダイレクトを受ける口が要り、会社のテナントでリダイレクト URI を登録できないことがある
- **MSAL Node を使う**: トークンのキャッシュを MSAL の形で持つことになり、秘密情報の暗号化と二重になる

## Consequences

### Positive

- ふだんのブラウザで、多要素認証や SSO を含めてサインインできる
- Outlook の予定の Task が、Google Calendar と同じ決まりで作られる

### Negative

- アプリの登録をユーザーがする必要がある。会社のテナントでは管理者の協力が要ることがある
- 会社の条件付きアクセスで device code 認証が止められていると使えない
- 実際の Graph の応答では、まだ確かめていない（フィクスチャでテストした）

### Neutral

- 終日の予定の日付は PC のタイムゾーンで読むので、メールボックスのタイムゾーンと違うとずれる

## References

- [RFC 8628: OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [Microsoft identity platform and the OAuth 2.0 device authorization grant flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code)
- [ADR-0016](0016-google-calendar.md)
