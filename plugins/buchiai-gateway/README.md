# buchiai-gateway — Codex 接続プラグイン

Codex のモデル呼び出しを「ぶち AI ゲートウェイ」経由にルーティングするための設定支援プラグインです。`~/.codex/config.toml` のプロバイダ設定を安全（差分表示 → 明示同意 → バックアップ → アトミック書込 → 完全復元可能）に切り替え、DLP（秘密・PII 検知）と利用可視化をゲートウェイ側で受けられるようにします。

## 必ず知っておいてほしいこと（正直な告知）

1. **設定反映には Codex の再起動が必要です。** `config.toml` は起動時に読み込まれるためです。接続・解除のたびに再起動してください。
2. **APIキー方式と ChatGPT サブスク方式の両方に対応します。** サブスク方式は `requires_openai_auth = true` のプロバイダを使い、`codex login` 済みである必要があります。
3. **サブスク利用時、圧縮による金銭的な削減はありません。** 本プラグインとゲートウェイの目的は DLP と利用の可視化です。従量課金（API キー）利用時のみコスト削減効果があります。
4. **トークンは `config.toml` に平文で保存されます**（現行ゲートウェイのパスベース認証 `/c/<token>/v1` に由来する制約。ファイル権限は 600 に設定します）。`config.toml` を共有・コミットしないでください。全出力は末尾 4 文字マスクです。なお `overwrite: true` で既存テーブルを置き換えた場合、導入前の内容は `state.json`（0600）に退避され、`off` で復元されます（旧トークンを含み得ます）。
5. **Codex cloud は対象外です。** クラウド側実行はローカルの `config.toml` を参照しないため、ゲートウェイ経由にできません。
6. **上流の API キー・OAuth トークン・`auth.json` には一切触れません。** 読み取りすら行いません。

さらに重要な前提として、**本プラグインは強制力を持ちません**。`config.toml` を手で書き戻せばゲートウェイ経由は外れます。DLP の強制はゲートウェイ側（ネットワーク/組織ポリシー）でのみ成立します。

## 動作要件

- Codex CLI **0.154.0 以上**（portable plugin 形式・bundled stdio MCP・`PLUGIN_DATA` 注入を実測）
- Node.js（MCP サーバー・hook の実行に使用。追加の npm 依存はゼロ）
- OS: Linux で検証済み。macOS / Windows は未検証
- 接続モード: APIキー方式 / サブスク方式（`auth` 引数で選択）

## インストールと接続

```
# 1. marketplace を登録（公開 mirror。初回同期までは下の代替手段を使う）
codex plugin marketplace add yamanexjp/buchi-plugins

# 2. プラグインをインストール
codex plugin add buchiai-gateway@buchi-plugins

# 3. 同梱 hook の信頼（初回のみ。/hooks でレビューして trust）
# 4. 接続（Codex の中で setup スキルを実行。例: 「buchi の setup でゲートウェイに接続して」と指示）

# 5. Codex を再起動

# 6. 実際に通過しているか確認（verify スキルを実行。confirm: true で Codex 実要求 1 回 + ゲートウェイ観測の突き合わせ）
```

トークンの入力は端末の `read -s BUCHI_GATEWAY_TOKEN` + export を推奨します（引数で渡すとセッション記録に残ります）。

## スキル一覧

| スキル | 種別 | 説明 |
|---|---|---|
| `setup` | 変更（要同意） | 接続をセットアップ。dry-run で差分を提示し、同意後にのみ `config.toml` へ書込。旧値は退避し、バックアップを直近 5 世代保持 |
| `off` | 変更（要同意） | 接続を解除し、**setup 前の状態へ完全復元**（元が未設定ならキー削除）。既存の他設定は壊しません |
| `on` | 変更（要同意） | 解除後の再接続（トークンの再入力が必要。初回は `setup`） |
| `status` | 照会 | 接続先（マスク表示）・反映状態（再起動待ち検知）・healthz 疎通・最新セッションの使用プロバイダを表示 |
| `doctor` | 照会 | 診断 D1〜D7（バージョン / TOML 妥当性 / env 競合・プロファイル / 疎通 / トークン有効性は送信しない・認証方式案内 / コスト効果と制限の常時表示） |
| `verify` | 照会（ゲートウェイへリクエスト送信） | **実際にゲートウェイを通過しているか**を確認。「設定済み」「疎通成功」「ゲートウェイ受理」「Codex 実要求の通過」を分けて表示。`confirm: true` でのみ Codex 実要求を 1 回発行（課金し得ます）。`confirm` 前の受理プローブもゲートウェイ経由で上流まで届く通常リクエストです（プレースホルダ鍵のため通常は上流 401・コスト 0 ですが、構成により課金され得ます）。confirm 付き verify 全体で最大 3 リクエスト（受理プローブ + 実要求 + 照会）がレート/日次上限を消費します |

### status と verify の違い（重要）

`config.toml` にゲートウェイの URL があっても、**いま動いている Codex がそれを使っているとは限りません**（再起動前・プロファイル上書き）。また `/healthz` が 200 でも、トークンが無効なら要求は上流へ届きません。`status` は「設定済み」「疎通成功」までを、`verify` はそれに加えて「ゲートウェイがトークンを受理したか」「（`verify` が起動した新規 `codex exec` プロセスの）要求をゲートウェイが観測したか（応答 ID 相関）」を、それぞれ独立した OK/NG として表示します。稼働中の対話セッション自体の通過は、再起動後にそのセッションで `verify` を実行して確認してください。接続作業の最後は必ず `verify` で締めてください。

SessionStart hook がセッション開始時に 1 行だけ接続状態を表示します（例: `ぶち: 接続中 (gw.example.dev)`。ホスト名のみで、トークンは表示しません）。

## 解除・アンインストール

- `off` スキルで解除（`config.toml` は setup 前に復元、Codex を再起動）。
- 完全な削除は `codex plugin remove buchiai-gateway`（+ 必要なら marketplace の remove）。

## 配布メモ（開発者向け）

- 公開 mirror（`yamanexjp/buchi-plugins`）への配布は `plugin-publish.yml` が自動化:
  `plugin/codex/**` → mirror `plugins/buchiai-gateway/**`、
  `plugin/.agents/plugins/marketplace.json` → mirror `.agents/plugins/marketplace.json`。
- 同名エントリ（Claude 版 `buchiai-gateway`）との衝突はカタログ分離で解決:
  Claude Code は `.claude-plugin/marketplace.json` のみ、Codex は
  `.agents/plugins/marketplace.json` があればそれのみを読む（実測）。
  Codex CLI は marketplace エントリ名と plugin.json name の一致を強制するため、
  両者とも `buchiai-gateway` でなければならない。
- 導入コマンド: `codex plugin marketplace add yamanexjp/buchi-plugins` →
  `codex plugin add buchiai-gateway@buchi-plugins`。
  ローカル検証は `bash plugin/tests/codex-marketplace-validate.sh`
  （CI の validate-codex と同一。mirror と同一のデュアルカタログ構成も検証する）。

## 制限事項

- プロジェクト側 `.codex/config.toml` では provider 設定は無視されます（Codex の仕様）。ユーザー側 `~/.codex/config.toml` が対象です。
- `--profile` 指定時はプロファイルが provider を上書きし得ます。doctor がプロファイルファイルを検出して警告します。
- `openai_base_url` が設定されていると組み込み openAI プロバイダの挙動が変わります（buchi テーブルには影響しませんが、混同防止のため警告します）。
- `wire_api` は `responses` のみ実機確認済みです。
- confirm 付き `verify` は最大で約 3 分かかります（実要求 + rollout ポーリング）。MCP ツールのタイムアウトが短い環境ではツール側が先に切れることがあります。その場合も実要求自体は発行済みのため、少し待ってから `verify` を再実行してください（再実行は新たに 1 要求を発行します）。
- `GW_CHATGPT_FORCE_HTTP=false` で WebSocket 素通しにしている構成では、ゲートウェイが WS 要求を観測できないため、通過していても `verify` は「未確認」になります（安全側の偽陰性）。
- 非ストリーミング応答が chunked（Content-Length 不明）や 256KiB 超の場合、ゲートウェイが応答 ID を記録できないため `verify` は「未確認」になり得ます（Codex 既定は SSE のため通常は非該当）。
- チーム共有トークン等で並行セッションが多い場合、記録上限（トークンあたり直近 64 件・30 分）を超えると `verify` の応答 ID が追い出され「未確認」になり得ます（安全側の偽陰性。再実行で再確認できます）。
