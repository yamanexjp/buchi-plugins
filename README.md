# buchi-plugins — ぶち AI ゲートウェイ用プラグイン marketplace

[ぶち AI ゲートウェイ](https://buchi.ai/gateway) に Claude Code / Codex を安全に接続するための
プラグイン配布リポジトリです。このリポジトリは本体リポジトリの `plugin/` 配下から
自動同期されます（直接の Pull Request は受け付けていません。不具合報告は
サポート窓口へお願いします）。

## インストール（Claude Code）

```
claude plugin marketplace add yamanexjp/buchi-plugins
claude plugin install buchiai-gateway@buchi-plugins \
  --config gateway_url="https://<あなた>.gw.buchi.ai" \
  --config gateway_token="<TOKEN>"
claude plugin enable buchiai-gateway@buchi-plugins
claude            # 起動後に /buchiai-gateway:setup → 同意 → Claude Code を再起動 → /buchiai-gateway:verify
```

ゲートウェイの `/setup` ページ・管理画面には、あなたの URL とトークンを埋め込んだ
上記コマンドがそのまま表示されます。

## インストール（Codex）

```
codex plugin marketplace add yamanexjp/buchi-plugins
codex plugin add buchiai-gateway@buchi-plugins
# 初回のみ /hooks で同梱 hook をレビューして trust
codex              # setup スキルで接続 → 差分確認・同意 → Codex 再起動 → verify スキルで通過確認
```

ゲートウェイトークンは環境変数 `BUCHI_GATEWAY_TOKEN`（`read -s` で入力）での受け渡しを
推奨します。詳細は [plugins/buchiai-gateway/README.md](plugins/buchiai-gateway/README.md)。

## 収録プラグイン

| プラグイン | 対象 | 説明 | ドキュメント |
|---|---|---|---|
| `buchiai-gateway` | Claude Code | モデル呼び出しをゲートウェイ経由（`https://<gw>/c/<token>`）に切り替える設定支援。`/buchiai-gateway:setup` `/buchiai-gateway:status` `/buchiai-gateway:verify` `/buchiai-gateway:doctor` `/buchiai-gateway:off` `/buchiai-gateway:on` | [plugins/buchiai-gateway-claude/README.md](plugins/buchiai-gateway-claude/README.md) |
| `buchiai-gateway` | Codex | 同上（Codex 版。MCP ツール `buchi_setup` 等と応答 ID 相関による通過確認を提供） | [plugins/buchiai-gateway/README.md](plugins/buchiai-gateway/README.md) |

両プラグインは同名 `buchiai-gateway` ですが衝突しません: Claude Code は
`.claude-plugin/marketplace.json` を、Codex は `.agents/plugins/marketplace.json` を
それぞれ読み、各クライアントは自分向けのプラグインのみを解決します。

## ライセンス

Apache-2.0（[LICENSE](LICENSE)）
