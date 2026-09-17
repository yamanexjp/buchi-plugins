// buchi SessionStart hook body (invoked by session-check.sh).
//
// Emits EXACTLY ONE status line and always exits 0 — a hook failure must never
// break the session. Security: the token part of ANTHROPIC_BASE_URL is never
// printed; only the gateway HOST is shown. JSON parsing and the healthz probe
// are done in Node (W5: Node is already a hard dependency of this plugin).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { splitBaseUrl, healthCheck } from '../mcp/lib.mjs';

function emit(line) {
  process.stdout.write(line + '\n');
  process.exit(0);
}

try {
  const settingsPath = process.env.BUCHI_SETTINGS_PATH
    || path.join(os.homedir(), '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    emit('ぶち: 未接続です。/buchiai-gateway:setup を実行してください');
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    emit('ぶち: settings.json が読めません（/buchiai-gateway:doctor で診断してください）');
  }

  const base = json && json.env && typeof json.env === 'object' ? json.env.ANTHROPIC_BASE_URL : undefined;
  if (base === undefined || base === '') {
    emit('ぶち: 未接続です。/buchiai-gateway:setup を実行してください');
  }

  // Gateway-shaped URL? (…/c/<token>) — derive host WITHOUT ever touching the token.
  const split = splitBaseUrl(base);
  if (!split) {
    // BASE_URL is set but points elsewhere (not a buchi path-auth URL).
    // Intentionally do not print the foreign URL/host.
    emit('ぶち: 未接続（ANTHROPIC_BASE_URL に別の設定があります。/buchiai-gateway:status で確認してください）');
  }

  let host = '';
  try { host = new URL(split.gatewayUrl).host; } catch { host = '(不明なホスト)'; }

  // healthz against the gateway root only (no /c/<token> in the request), max 2s.
  const h = await healthCheck(split.gatewayUrl, 2000);
  emit(h.ok
    ? `ぶち: 接続中 (${host})`
    : `ぶち: 接続中 (${host}) ※healthz 疎通NG（/buchiai-gateway:doctor で診断してください）`);
} catch {
  // Last-resort guard: still one line, still exit 0.
  emit('ぶち: 状態確認をスキップしました（内部エラー）');
}
