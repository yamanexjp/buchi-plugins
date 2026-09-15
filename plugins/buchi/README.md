# buchi — ぶち AI ゲートウェイ接続プラグイン

Claude Code のモデル呼び出しを「ぶち AI ゲートウェイ」経由にルーティングする
ための設定支援プラグインです。settings.json の `env.ANTHROPIC_BASE_URL` を
安全（差分表示 → 明示同意 → バックアップ → アトミック書込 → 完全復元可能）に
切り替え、DLP（秘密・PII 検知）と利用可視化をゲートウェイ側で受けられるように
します。

## 必ず知っておいてほしいこと（正直な告知）

1. **設定反映には Claude Code の再起動が必要です。**
   `settings.json` の `env` はプロセス起動時に 1 度だけ読み込まれるためです。
   接続・解除のたびに再起動してください（各コマンドも完了時に案内します）。
2. **接続中は Remote Control 系機能が動作しません（#230）。**
   `ANTHROPIC_BASE_URL` を変更している間、claude.ai からのセッション起動・
   Slack 連携・定期実行は使えません。`/buchi:doctor` でも毎回警告します。
3. **サブスク（定額プラン / OAuth）利用時、圧縮による金銭的な削減はありません。**
   本プラグインとゲートウェイの目的は DLP と利用の可視化です。従量課金
   （API キー）利用時のみコスト削減効果があります。
4. **トークンの保存場所は 2 段階あります（隠さず書きます）。**
   - プラグイン設定（userConfig）に入力した `gateway_token` は、Claude Code に
     より OS のキーチェーン（非対応環境では `~/.claude/.credentials.json`）に
     保管されます。
   - ただし接続を有効化（`/buchi:setup` を適用）すると、トークンは
     **`ANTHROPIC_BASE_URL` の一部（パス埋め込み）として `settings.json` に
     平文で書き込まれます**（ファイル権限は 600 に設定します）。これは現行
     ゲートウェイの認証方式（パスベース）に由来する制約です。
     `settings.json` を共有・コミットしないでください。
5. **Cursor / VS Code Copilot は本プラグインの対象外です。**
   それらのクライアントは従来どおりクライアント側ガイドに従って設定してください。

さらに重要な前提として、**本プラグインは強制力を持ちません**。settings.json を
手で書き戻せばゲートウェイ経由は外れます。DLP の強制はゲートウェイ側
（ネットワーク/組織ポリシー）でのみ成立します。本プラグインは「安全に設定を
切り替える道具」であり「回避を防ぐ仕組み」ではありません。

## 動作要件

- Claude Code **2.1.154 以上**（userConfig 対応。`/buchi:doctor` の D1 で検査。
  実測は 2.1.273 で install → enable → MCP 接続 → 実ルーティング（A1）まで確認済み）
- Node.js（MCP サーバー・hook の実行に使用。追加の npm 依存はゼロ）
- OS: Linux で検証済み。**macOS / WSL は未検証**（テストは POSIX 準拠・
  パス非依存で作成していますが、実測は Linux のみです）
- 接続モード: **byok（パスベース認証）のみ提供**。saas モードは未提供です
  （O-1 確定待ち。選択するとセットアップは明示エラーで中断します）

## インストールと接続

配布元（marketplace）は `yamanexjp/buchi-plugins`（GitHub 公開リポジトリ）です。
ゲートウェイの `/setup` ページ・管理画面のトークン発行画面には、あなたの
ゲートウェイ URL とトークンを埋め込んだ下記コマンドがそのまま表示されます。

### A. ターミナルから（非対話・推奨）

```
claude plugin marketplace add yamanexjp/buchi-plugins
claude plugin install buchi@buchi-plugins \
  --config gateway_url="https://<あなた>.gw.buchi.ai" \
  --config gateway_token="<TOKEN>"
claude plugin enable buchi@buchi-plugins
claude            # 起動後に /buchi:setup → 同意 → Claude Code を再起動 → /buchi:verify
```

`--config` で渡した `gateway_token` は sensitive 扱いで Claude Code の
credentials ストア（`~/.claude/.credentials.json` 等）に保管され、
`settings.json` には書かれません（`/buchi:setup` を適用するまでは）。

### B. Claude Code の中から（対話）

```
# 1. marketplace を追加
/plugin marketplace add yamanexjp/buchi-plugins

# 2. プラグインをインストール
/plugin install buchi@buchi-plugins

# 3. 有効化時に userConfig を入力
#    gateway_url   : ゲートウェイの URL（例: https://<あなた>.gw.buchi.ai）
#    gateway_token : 接続トークン（sensitive 扱いで保管されます）
#    mode          : byok（既定。saas は未提供）
#    settings_scope: user（既定）または project

# 4. 接続（差分を確認し、同意すると書き込まれます）
/buchi:setup

# 5. Claude Code を再起動

# 6. 実際に通過しているか確認
/buchi:verify
```

トークンを画面で確認する必要がある場合も、表示は常に `buchi_••••1a2b` のような
マスク形式（末尾 4 文字のみ）です。全出力経路でトークン全文は表示されません。

## コマンド一覧

| コマンド | 種別 | 説明 |
|---|---|---|
| `/buchi:setup` | 変更（要同意） | 接続をセットアップ。dry-run で差分を提示し、同意後にのみ `settings.json` へ書込。旧値は退避し、バックアップを直近 5 世代保持 |
| `/buchi:off` | 変更（要同意） | 接続を解除し、**setup 前の状態へ完全復元**（元が未設定ならキー削除）。既存の他キーは壊しません |
| `/buchi:on` | 変更（要同意） | 解除後の再接続（setup 再実行相当。初回は `/buchi:setup`） |
| `/buchi:status` | 照会 | 接続先（マスク表示）・反映状態（再起動待ち検知）・healthz 疎通を表示 |
| `/buchi:doctor` | 照会 | 診断 D1〜D7（バージョン / JSON 妥当性 / env 競合 / 疎通 / トークン有効性(doctor は送信しない・verify へ誘導) / Remote Control 警告 / コスト効果の正直な説明） |
| `/buchi:verify` | 照会（1 リクエスト送信） | **実際にゲートウェイを通過しているか**を無害なテスト要求で確認。「設定済み」「疎通成功」「稼働セッションが設定を使用」「実際の通過（トークン受理→検査→上流転送）」を分けて表示。既定はプレースホルダ鍵でコスト 0。`full: true` で env の `ANTHROPIC_API_KEY` を使い上流応答まで確認（出力 1 トークン分） |

### status と verify の違い（重要）

`settings.json` にゲートウェイの URL があっても、**いま動いている Claude Code が
それを使っているとは限りません**（再起動前・シェルの `export` 残存）。また
`/healthz` が 200 でも、トークンが無効なら要求は上流へ届きません。
`/buchi:status` は「設定済み」「疎通成功」までを、`/buchi:verify` はそれに加えて
「稼働セッションの env が設定と一致しているか」「ゲートウェイがトークンを受理して
上流へ転送したか」を、それぞれ独立した OK/NG として表示します。接続作業の
最後は必ず `/buchi:verify` で締めてください。

SessionStart hook が毎セッション 1 行だけ接続状態を表示します
（例: `ぶち: 接続中 (gw.example.dev)`。ホスト名のみで、トークンは表示しません）。

## 解除・アンインストール

1. `/buchi:off` を実行（差分確認 → 同意 → setup 前の settings.json へ完全復元）
2. Claude Code を再起動
3. 必要なら `/plugin uninstall buchi`

退避情報が失われている場合、`/buchi:off` は `settings.json.buchi-backup-*`
（直近 5 世代）からの手動復元手順を提示します。

## トラブルシューティング

まず `/buchi:doctor` を実行してください。DNS / TLS / プロキシ
（`HTTPS_PROXY`・`NO_PROXY`）/ シェル export の競合 / settings.json 破損を
切り分けて表示します。設計の詳細と設計書からの変更点は本体リポジトリの
`plugin/docs/design-revisions.md`、受け入れ基準と検証状況は
`plugin/tests/acceptance.md` に記録しています（配布リポジトリには同梱して
いません）。
