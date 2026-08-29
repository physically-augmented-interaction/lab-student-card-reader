# lab-student-card-reader

Android タブレット + Sony PaSoRi RC-S380 で学生証（FeliCa）の学籍番号を読むための調査リポジトリです。

実装計画は [docs/implementation-plan.md](docs/implementation-plan.md) にあります。

## いま分かっていること

- RC-S380 の公式対応 OS は Windows のみで、Android 製品サポートはありません。
- それでも USB bulk デバイスとして扱えます。Sony VID 0x054C、PID 0x06C1（RC-S380/S）または 0x06C3（RC-S380/P）。
- 学籍番号は非暗号化領域にあります。最初の実カードではシステム 0x8277、サービス 0x010B、block 0 の ASCII 002AE19051030000 から AE19051 を切り出します。
- 前後の 00 / 2 / 03 / ゼロパディングは学籍番号ではありません。

## この Mac でカードを解析する

必要: RC-S380、データ対応 mini-USB ケーブル、mise、Homebrew の libusb。
JDK / Node / Python / uv / Android SDK は mise.toml で管理します。

    mise trust
    mise install
    mise run setup
    mise run probe
    mise run dump

成功条件:

1. probe-reader が RC-S380 を見つける
2. 学生証の dump が dumps/ に書かれる
3. 0x8277 / 0x010B / block 0 から AE19051 形式の学籍番号が取れる

dumps/ は gitignore 済みです。学籍番号は個人情報なのでコミットしないでください。

## React Native アプリ

React Native アプリは app/ です。USB / FeliCa は Kotlin Native Module PasoriModule に閉じ、JS には学籍番号と IDm だけを返します。

    mise run android

タブレットに RC-S380 を挿し、USB 権限を許可してから学生証をタッチします。学籍番号は AE19051 形式です。

## 入退室バックエンド

Cloudflare Workers + D1。Web 管理画面はのちのち Cloudflare Access で絞ります。リーダー API は D1 管理の API キー（複数可、ハッシュ保存）です。

公開URL: https://lab-attendance.manabe-lab.workers.dev

    cd worker
    npm install
    npx wrangler d1 migrations apply lab-attendance --remote
    npx wrangler deploy

ダッシュボードは / 、設定（メンバー追加・効果音・API キー）は /settings/ です。効果音用 R2 は Cloudflare ダッシュボードで R2 を有効化したあと、bucket lab-attendance-sounds を作って wrangler.jsonc の binding を戻してください。

Android アプリは gradle プロパティか環境変数で接続します。

    LAB_API_BASE_URL=https://lab-attendance.manabe-lab.workers.dev
    LAB_API_KEY=ltn_...
    LAB_DEVICE_ID=tablet-1
