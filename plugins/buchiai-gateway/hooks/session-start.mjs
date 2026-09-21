#!/usr/bin/env node
// SessionStart hook: one-line connection status. Always exits 0.
// Prints host name only — never tokens. Reads config.toml read-only.
// Top-level model_provider and [model_providers.*] tables only (a stray
// model_provider inside another table is ignored by Codex, so we ignore it).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function codexHome() {
  const h = String(process.env.CODEX_HOME ?? '').trim();
  return h !== '' ? h : path.join(os.homedir(), '.codex');
}

function main() {
  try {
    const cfg = path.join(codexHome(), 'config.toml');
    if (!fs.existsSync(cfg)) { console.log('ぶち: 未接続 (config.toml なし)'); return; }
    const text = fs.readFileSync(cfg, 'utf8');
    let section = '';
    let provider = '';
    let base = '';
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const sec = line.match(/^\[(.+)\]$/);
      if (sec) { section = sec[1].trim(); continue; }
      if (section !== '') continue;
      const mp = line.match(/^model_provider\s*=\s*"([^"\n]+)"\s*(#.*)?$/);
      if (mp) { provider = mp[1]; continue; }
    }
    // base_url は buchi 管理テーブル内のみ参照する。
    const tableRe = new RegExp(`^\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`, 'm');
    if (provider !== '' && tableRe.test(text)) {
      const block = text.split(tableRe)[1].split(/^\[.*\]$/m)[0];
      const bm = block.match(/^\s*base_url\s*=\s*"([^"\n]*\/c\/[^"/\n]+)(?:\/v1)?"/m);
      if (bm) base = bm[1];
    }
    if (base === '') {
      console.log(provider !== '' ? `ぶち: 未接続 (model_provider=${provider})` : 'ぶち: 未接続');
      return;
    }
    let host = '(不明)';
    try { host = new URL(base).host; } catch { /* keep unknown */ }
    const active = provider === 'buchi' || provider === 'buchi_sub';
    console.log(active ? `ぶち: 接続中 (${host})` : `ぶち: 未接続 (model_provider=${provider || '未設定'})`);
  } catch {
    console.log('ぶち: 状態不明');
  }
}
main();
