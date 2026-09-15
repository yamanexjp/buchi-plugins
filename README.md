# buchi-plugins — ぶち AI ゲートウェイ用 Claude Code プラグイン marketplace

[ぶち AI ゲートウェイ](https://buchi.ai/gateway) に Claude Code を安全に接続するための
プラグイン配布リポジトリです。このリポジトリは本体リポジトリの `plugin/` 配下から
自動同期されます（直接の Pull Request は受け付けていません。不具合報告は
サポート窓口へお願いします）。

## インストール

```
claude plugin marketplace add yamanexjp/buchi-plugins
claude plugin install buchi@buchi-plugins \
  --config gateway_url="https://<あなた>.gw.buchi.ai" \
  --config gateway_token="<TOKEN>"
claude plugin enable buchi@buchi-plugins
claude            # 起動後に /buchi:setup → 同意 → Claude Code を再起動 → /buchi:verify
```

ゲートウェイの `/setup` ページ・管理画面には、あなたの URL とトークンを埋め込んだ
上記コマンドがそのまま表示されます。

## 収録プラグイン

| プラグイン | 説明 | ドキュメント |
|---|---|---|
| `buchi` | Claude Code のモデル呼び出しをゲートウェイ経由（`https://<gw>/c/<token>`）に切り替える設定支援。`/buchi:setup` `/buchi:status` `/buchi:verify` `/buchi:doctor` `/buchi:off` `/buchi:on` | [plugins/buchi/README.md](plugins/buchi/README.md) |

## ライセンス

Apache-2.0（[LICENSE](LICENSE)）
