# Changelog

すべての注目すべき変更はこのファイルに記録されます。

このフォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に
基づき、バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に
従います。

## [0.5.0] - 2026-09-16

### Added

- `/buchi:verify`（MCP ツール `buchi_verify`）: 無害なテスト要求
  （`/v1/messages`、max_tokens=1、"ping"、既定はプレースホルダ鍵でコスト 0）で
  「設定済み / 疎通成功 / 稼働セッションが設定を使用 / 実際の通過（トークン受理→
  検査→上流転送）」を独立に判定する。プローブは稼働セッションの env 値を優先し、
  実際に使われている経路を検証する。`full: true` で env の `ANTHROPIC_API_KEY` を
  使い上流 200 まで確認（出力 1 トークン分の課金）。応答ヘッダ
  `X-Buchi-Routed-Model` / `X-Buchi-Trial-Days-Remaining` / `X-Buchi-Budget-Warning`
  を表示に反映。分類は実ゲートウェイの応答形（ゲートウェイ自身のエラーは
  `{"error":{"type":...}}`、転送された上流エラーは `{"type":"error","error":{...}}`）
  で実測して決定。
- README に非対話インストール手順（`claude plugin install --config ...`、
  2.1.273 で実測）と「status と verify の違い」を追記。配布元を
  `yamanexjp/buchi-plugins` に確定。
- テスト S10a〜S10t（verify の 9 シナリオ）と S11a〜S11j（classifyProbe の
  全分岐）を追加。A5 の漏えい grep 対象にダミー API キー / 誤トークンを追加（15 種）。
- push-gate レビュー（opus）指摘の反映: DLP 遮断は HTTP 400（403 ではない）なので
  `error.type` のみで判定／プローブのタイムアウトを総所要時間の上限として強制／
  `full: true` の API キーを最終 sanitize 対象に登録／settings.json 不正時の [1/3]
  二重表示を解消／シェル export のみで通過した場合は結果行に「settings 未設定」を明記／
  副作用（統計・日次上限・エラー率への計上）を SKILL.md と README に明記。

### Changed

- doctor D5 の文言を「doctor はトークンを送信しない。実際の受理/転送は
  `/buchi:verify` で確認」に変更（TODO(O-3) を解消）。
- marketplace.json の「Phase 1: 骨格のみ、機能未実装」表記を撤去し版数を同期。
- plugin-ci の Claude Code ピンを 2.1.207 → 2.1.273（本版の実測バージョン）に更新。

## [0.4.1] - 2026-07-13

### Security

- gateway_url を `new URL()` で解析し、userinfo 付き URL
  （`https://good.example@evil.example` は URL 解釈で host=evil.example になる）
  やクエリ/フラグメント付き URL を明示エラーで拒否。正規 URL は解析結果からのみ
  再構築（FIX-A）。
- トークンマスクの抜け穴を封鎖: `/c/<segment>` の残余マスクを「次の `/` まで」の
  厳密分割に変更（空白・引用符・括弧で途切れない）。gateway_url に埋め込まれた
  実効トークン等、値を解析したすべてのトークンを既知シークレット集合として
  全応答の最終 sweep に通す（FIX-B）。

### Fixed

- 退避 state を settings パス毎にキー分けし（v1→v2 自動移行）、プロジェクト/
  scope 跨ぎで `buchi_off` が他ターゲットの値を復元してしまう相互汚染を解消
  （FIX-C）。
- `settings_scope` を user / project のみに厳格化。それ以外の値は黙って
  グローバル設定を対象にせず明示エラー（FIX-D）。
- CI の依存を明示固定（`@anthropic-ai/claude-code@2.1.207`。actions/* は
  リポジトリ慣行の major タグ運用に準拠）（FIX-E）。

## [0.4.0] - 2026-07-13

### Added

- README を本実装。「正直な告知」5 項目（再起動必須 / Remote Control 非互換
  #230 / サブスク時は金銭的削減なし / トークン保存場所の 2 段階
  （キーチェーン保管と settings.json への平文書込）/ Cursor・VS Code Copilot
  対象外）、プラグインが強制力を持たない旨、インストール・解除手順、
  コマンド表、動作要件、トラブルシューティングを記載。
- 受け入れテスト A1〜A8 を `plugin/tests/` に追加
  （`run-all.sh` 入口 + ゼロ依存 Node テスト 3 スイート、対応表は
  `plugin/tests/acceptance.md`）。A1 は実 `claude -p` がダミーゲートウェイの
  `/c/<token>/v1/messages` へ到達することを記録で実証。
- `plugin/**` 変更時のみ発火する CI（`.github/workflows/plugin-ci.yml`:
  validate --strict / テスト一式 / gitleaks）。

### Changed

- MCP サーバーの `serverInfo.version` をプラグイン版数（0.4.0）に統一。

## [0.3.0] - 2026-07-13

### Added

- 5 スキル（setup/off/on/status/doctor）の本文を実装。setup/on/off は
  dry-run → マスク済み差分の提示 → 明示同意 → `apply: true` → 再起動案内の
  同意フローを必須手順として記述。status/doctor は照会のみ。
- SessionStart hook を本実装: 接続状態を 1 行だけ出力
  （接続中はゲートウェイのホスト名のみ表示。トークンは一切出力しない）。
  healthz は 2 秒タイムアウト、どの経路でも exit 0。

### Changed

- hooks.json の timeout を 2→5 秒に変更（healthz 2 秒 + node 起動分の確保）。

## [0.2.0] - 2026-07-13

### Added

- 5 ツール（`buchi_setup` / `buchi_off` / `buchi_on` / `buchi_status` /
  `buchi_doctor`）を本実装。
- `buchi_setup`: dry-run 既定（`apply: true` で書込）。settings.json の
  `env.ANTHROPIC_BASE_URL` のみを書き換え（`<gateway_url>/c/<token>`、
  `/v1` サフィックスなし、`ANTHROPIC_AUTH_TOKEN` は書かない）。アトミック
  書込・chmod 600・バックアップ直近 5 世代・旧値退避・書込後 healthz・冪等。
- `buchi_off`: 退避値からの完全復元（元が未設定ならキー削除）。退避なし時は
  バックアップからの復元手順を提示。
- `buchi_status`: 設定と現プロセス env の乖離（再起動待ち）検知 + healthz。
- `buchi_doctor`: D1〜D7 診断（D6 Remote Control 非互換・D7 サブスク時の
  金銭削減なしを常時表示）。
- URL 正規化（末尾スラッシュ・`/c/<token>` 二重埋め込み分解）と排他ロック
  （stale 10 分で警告付き奪取）。
- 全出力経路でトークンをマスク（末尾 4 文字のみ、最終 sanitize スイープ付き）。

### Fixed

- 外部要因で BASE_URL が書き換わった後の再セットアップが退避原本を上書きし、
  `buchi_off` が完全復元できなくなるバグを修正（退避は stash が無い時のみ
  記録し、直前値の救済はバックアップ 5 世代が担う）。

## [0.1.0] - 2026-07-13

### Added

- プラグイン骨格を追加（`.claude-plugin/plugin.json`, `.mcp.json`,
  `hooks/hooks.json`）。
- ゼロ依存 Node stdio MCP サーバー雛形を追加（`buchi_setup` / `buchi_off` /
  `buchi_on` / `buchi_status` / `buchi_doctor` はスタブ登録のみ）。
- 5 スキル（setup/status/off/on/doctor）の SKILL.md をプレースホルダとして
  追加。
- `defaultEnabled: false` のため既定では無効。saas モード（テナント
  サブドメイン + Bearer 認証）は未提供（O-1 確定待ち）。
