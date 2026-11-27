# リリースの手順

`v1.2.3` の形のタグを push すると、GitHub Actions（`.github/workflows/release.yml`）が macOS（Apple Silicon）向けのアプリを作り、Developer ID で署名・公証して、下書きの Release に dmg と zip を載せる（[ADR-0018](decisions/0018-release-macos.md)）。

## 出すとき

```sh
git tag v0.1.0
git push origin v0.1.0
```

workflow が終わったら、GitHub の Releases で下書きを確かめて公開する。版はタグから決まる（`package.json` の `version` は書き換えない）。

## 最初に一度だけ: secrets を置く

secrets は、リポジトリの Settings → Environments に `release` という environment を作り、そこに置く。environment の「Deployment branches and tags」で、`v*.*.*` のタグだけに絞っておくと、ほかのブランチの workflow から secrets を読まれない。

| secret | 中身 | 作り方 |
|--------|------|--------|
| `MACOS_CERTIFICATE_P12_BASE64` | Developer ID Application の証明書と秘密鍵（.p12）を base64 にしたもの | キーチェーンアクセスで「Developer ID Application: …」を .p12 に書き出し、`base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PASSWORD` | .p12 を書き出したときのパスワード | |
| `APPLE_API_KEY_P8` | App Store Connect の API キー（.p8）の中身 | App Store Connect →「ユーザとアクセス」→「統合」→「App Store Connect API」でキーを作り、.p8 をダウンロードして中身を貼る |
| `APPLE_API_KEY_ID` | そのキーの ID | 同じ画面の「キー ID」 |
| `APPLE_API_ISSUER` | Issuer ID | 同じ画面の上にある「Issuer ID」 |

- Developer ID Application の証明書は、Apple Developer の「Certificates」で作る（Apple Developer Program への登録が要る）
- API キーのアクセスは「Developer」で足りる（公証に使うだけ）
- secrets がひとつでも欠けていると、workflow は署名しないまま進まずに止まる

## 手元で作って試す

署名せずに手元で確かめるときは、ad-hoc 署名で hardened runtime を切って作る（ad-hoc 署名と hardened runtime を組み合わせると、Electron Framework の読み込みで止められるため）。

```sh
pnpm app:build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --arm64 --dir \
  -c.mac.notarize=false -c.mac.identity=- -c.mac.hardenedRuntime=false
LIVE_TODO_SMOKE=1 release/mac-arm64/live-todo.app/Contents/MacOS/live-todo
```

`画面を読み込めた` と出れば起動できている。

## 配る版の違い

- データ（`config.json`・`live-todo.db`）は `~/Library/Application Support/live-todo/` に置く。開発中（リポジトリの中）のデータは引き継がないので、使い続けるならそこへ写す
- Finder から起動すると PATH が狭いので、起動時にログインシェルの PATH を読み込む（`gws`・`claude`・`gh` を見つけるため）
