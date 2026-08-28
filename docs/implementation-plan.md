# RC-S380 Android / React Native 実装計画

調査日: 2026-08-28
対象: Android タブレット + Sony PaSoRi RC-S380 で学生証の学籍番号を読む

## 結論

RC-S380 は **Android 公式対応機器ではない**。製品ページの動作環境は Windows 10/11 のみで、製品自体も生産終了している。ただし USB デバイスとしては Android USB Host から直接制御でき、学生証の学籍番号（非暗号化領域）を読むことは技術的に可能。

推奨ルートは次の2段:

1. この Mac に RC-S380 を刺し、nfcpy で実カードをダンプして学籍番号オフセットを確定する（最初の1枚は完了）
2. React Native は Android 専用の Kotlin USB Host ネイティブモジュールを作り、FeliCa Polling から Read Without Encryption だけを JS に返す

公式保証が必要なら Sony SDK（ICS-D101）または後継機 RC-S300 を検討する。ラボ用途なら OSS プロトコル実装で足りる。

## 調査結果

### 機器

| 項目 | 内容 |
|---|---|
| 型番 | RC-S380/S（業務用途 PaSoRi）。/P は個人向け相当 |
| USB | mini-USB Type-B, Full Speed, バスパワー 5V / 最大 200mA |
| VID/PID | Sony 0x054C。/S=0x06C1、/P=0x06C3 |
| プロトコル | CCID/PC/SC ではなく、NFC Port-100 独自フレーム（00 00 FF ... D6 cmd） |
| 公式OS | Windows 10/11 のみ。Android / Linux / macOS は製品サポート外 |
| 通信 | FeliCa 212/424 kbps、ISO/IEC 14443 Type A/B |
| 状態 | 生産終了。後継は RC-S300/S1（Windows + macOS、USB micro-B、PC/SC） |

公式製品ページ: [RC-S380/S](https://www.sony.co.jp/Products/felica/business/products/RC-S380.html)

### Sony SDK

| SDK | 対象 | Android | 備考 |
|---|---|---|---|
| SDK for NFC Lite (ICS-D004) | Windows / macOS | 不可 | PC/SC と FeliCa ライブラリ。RC-S380 は販売終了扱いでサポート縮小 |
| SDK for NFC Web Client | Windows / macOS ブラウザ | 不可 | タブレット Native には不適 |
| SDK for NFC Reference Implementation (ICS-D101) | Linux / Android / Windows / iPadOS | 条件付き可 | C リファレンス。Android Java から使うには JNI が別途必要。RC-S380 は 2026/6 末で本SDKサポート終了予定 |

ICS-D101 は「Android で動作確認済み」と明記している。ただし USB ドライバは Windows 非対応で、Android Java からは native 接続層を自前実装する必要がある。商用再頒布やサポートが要るなら購入検討。ラボ内アプリなら必須ではない。

公式: [ICS-D101/V16](https://www.sony.co.jp/Products/felica/business/products/ICS-D101_102.html)

### Android で RC-S380 を扱う条件

必須:

- android.hardware.usb.host を持つタブレット（OTG / USB Host）
- USB 給電。RC-S380 は最大 200mA。充電専用ケーブルや電力不足ハブは不可
- アプリ側 USB 権限（UsbManager.requestPermission + device_filter.xml）
- タブレット内蔵 NFC は使わない。S-380 は外付け USB リーダー

非必須 / 使えないもの:

- Android NfcAdapter / NfcF（内蔵アンテナ向け）
- PC/SC Android スタック（RC-S380 は標準 CCID ではない）
- React Native の既存 NFC ライブラリ（react-native-nfc-manager 等）

既存の動作実績:

- [nfcpy rcs380.py](https://github.com/nfcpy/nfcpy/blob/master/src/nfc/clf/rcs380.py): Linux/macOS から USB bulk で IDm / FeliCa 読み取り可能
- [mike-neko/AndroidPasori](https://github.com/mike-neko/AndroidPasori): Android UsbManager で RC-S380 IDm 読み取り（Kotlin、比較的新しい）
- [masato-ka/android-things-pasorilib](https://github.com/masato-ka/android-things-pasorilib): Android Things 向け。VID 1356 / PID 1731 = 0x054C/0x06C3
- [aruneko/WebUSB-RC-S380](https://github.com/aruneko/WebUSB-RC-S380): フレーム構造の参照に使える

### 学生証データ

最初の実カード（IDm 011203123C255918）は、一般的な FCF（0xFE00 / 0x1A8B）ではなく大学固有システムだった。

| 項目 | 実測値 | メモ |
|---|---|---|
| システムコード | 0x8277 | Request System Code の先頭。0xFE00 側にサービスは無し |
| サービスコード | 0x010B | Random RO without key |
| コマンド | Polling(0x8277) のあと Read Without Encryption block 0 | 暗号化なし |
| block 0 | 002AE19051030000 | ASCII。学籍番号は AE19051 |
| block 1 | 2019040120260930 | 有効期間 2019-04-01 から 2026-09-30 に見える |

学籍番号の切り出し:

- 使う: AE19051（block0 の index 3..9）
- 捨てる: 先頭 00、その次の 2、学籍番号の後ろの 03、末尾ゼロパディング

公開 FCF 実装（0xFE00 / 0x1A8B）はフォールバック候補として残すが、この研究室カードの本線ではない。

## 技術選定

### 1. リーダー制御レイヤ

| 案 | メリット | デメリット |
|---|---|---|
| A. Kotlin USB Host で NFC Port-100 を自前実装（推奨） | Android 標準 API のみ。RN から薄い module で呼べる。IDm + 非暗号化 Read に十分。既存 Kotlin 実装を参照できる | Sony 非公式。機種差・権限ダイアログ・切断再接続を自分で扱う |
| B. Sony ICS-D101 + JNI | 公式リファレンス。将来 RC-S300 にも寄せやすい | 有償。2026/6 末で RC-S380 サポート終了予定。Java 接続層は別途必要。RN との橋渡しが重い |
| C. タブレット内蔵 NFC (NfcF) | 実装が楽。ケーブル不要 | S-380 を使わない。機種依存、バックグラウンド制限、据え置きリーダー用途に不向き |
| D. WebUSB / Chrome Custom Tab | JS だけで試作できる | Android WebView / RN では WebUSB が使えないか不安定。本番アプリ向きでない |
| E. 後継 RC-S300 + PC/SC | 公式 macOS/Windows、CCID | プロトコルが Port-100 と違う。Android ではまた USB 実装が必要。今ある S-380 を使えない |

### 2. アプリ枠

| 案 | メリット | デメリット |
|---|---|---|
| React Native Android-only + Kotlin Native Module（推奨） | 指定どおり RN で UI を組める。USB/FeliCa は native に閉じられる | iOS は対象外。Expo Go では USB Host 不可 |
| 純 Kotlin Android アプリ | USB 周りが最短。デバッグが楽 | RN 指定から外れる。UI を後で移植するコスト |
| Expo + dev client + native module | 画面開発は楽 | USB permission / foreground service の制御が bare RN より分かりにくい |

Expo を使うなら development build / prebuild 必須。Expo Go では S-380 は動かない。

## 推奨アーキテクチャ

    Student card (FeliCa)
            | RF 13.56MHz
            v
    Sony RC-S380 (USB VID 054C / PID 06C1 or 06C3)
            | USB bulk IN/OUT (EP 0x81 / 0x02)
            v
    Android USB Host (UsbManager)
            v
    Kotlin module: PasoriS380Client
      - permission / attach / detach
      - Port-100 frame (ACK, SetCommandType, InSetRF, InCommRF)
      - FeliCa Polling(0x8277)
      - Read Without Encryption(service 0x010B, block 0)
      - ASCII block0[3:10] を学籍番号として返す
            v
    React Native JS
      - 待受 UI
      - studentId / idm 表示
      - 重複読み取り抑制
      - 出席・名簿連携（後続）

JS にはカードプロトコルを出さない。返すのは idm、studentId、rawBlockHex、error 程度。

## この Mac での解析手順

2026-08-28 20:11 JST に RC-S380/S（VID 0x054c / PID 0x06c1）で最初の学生証ダンプに成功。JSON は dumps/ に保存済み（gitignore）。

    cd /Users/mogami/develop/manabe/lab-student-card-reader
    uv python pin 3.12
    uv sync
    uv run python -m tools.probe_reader
    uv run python -m tools.dump_student_card

成功条件:

1. probe が VID 0x054c + PID 0x06c1 or 0x06c3 を出す
2. nfcpy が Sony RC-S380 を open できる
3. dump が system 0x8277 と service 0x010B を見つける
4. block 0 から AE19051 形式の学籍番号が取れる

macOS 注意:

- 充電専用ケーブル不可。データ対応 mini-USB が必要
- 他の NFC アプリや仮想マシンがデバイスを掴んでいると nfcpy が EACCES になる
- 初回は抜差してから probe

ダンプ JSON は dumps/ に保存される。学籍番号は個人情報なので Git に入れない。

## React Native 実装ステップ

実カードダンプが終わってからアプリ実装に入る。

### Phase 0. カード仕様確定（このリポジトリ / Mac）

- [x] RC-S380 を挿して probe-reader 成功
- [x] 実学生証 1枚で dump-student-card 成功
- [x] 0x8277 / 0x010B / block0[3:10] = AE19051 を本線にする
- [ ] 2枚目以降でも同じオフセットか確認
- [ ] 学生証が複数システム（交通系など）を持つ場合の Polling 順を決める

### Phase 1-2. React Native + Kotlin Native Module

実装済み（コード。実機読取は未検証）:

- app/ に React Native 0.87 Android アプリ
- Kotlin PasoriS380Client が USB Host で Port-100 / FeliCa を話す
- PasoriModule が onCard / onReader を JS に流す
- 学籍番号は 0x8277 / 0x010B / block0[3:10]

実機で残っている確認:

- [ ] USB Host 対応タブレットで APK 起動
- [ ] RC-S380 接続と USB 権限
- [ ] AE19051 形式の学籍番号が表示される
- [ ] 抜差、画面オフ、同じカードの 2〜3 秒デバウンス

### Phase 3. アプリ機能

カードが読めてから:

- 学籍番号の正規化（trim、ゼロ埋め、チェック文字）
- 名簿照合
- オフラインキュー
- 読取音 / 画面フラッシュ
- リーダー未接続の分かりやすいエラー

## リスク

| リスク | 影響 | 対策 |
|---|---|---|
| 公式未サポート | 機種によって USB 列挙や permission が失敗 | 実機を先に1台固定。ICS-D101 は保険 |
| RC-S380 生産終了 | 故障時に調達できない | 在庫確保。次機種は RC-S300 でプロトコル分岐 |
| 学籍番号レイアウト差 | 他大学カードや発行年でオフセットが違う | 必ず実カードダンプ。パーサは設定化 |
| USB 給電不足 | 読取が不安定 | 給電付きハブ、短いケーブル、充電専用ケーブル禁止 |
| 暗号化領域を誤って読む | 失敗または不正アクセス | 非暗号化サービスだけ。鍵付き attr は skip |
| Expo Go | USB Host が使えない | development build |
| 個人情報 | IDm / 学籍番号のログ流出 | dump JSON を gitignore。アプリログはマスク |

## 最初に買う / 確認するもの

1. RC-S380 本体とデータ対応 mini-USB ケーブル
2. USB Host 対応 Android タブレット 1台（機種を固定）
3. 実学生証（学籍番号が分かっているもの）
4. 必要なら給電ハブ

公式サポート契約が要る場合のみ ICS-D101。コード実装は app/ の RN + Kotlin まで進めた。次はタブレット実機での読取確認。
