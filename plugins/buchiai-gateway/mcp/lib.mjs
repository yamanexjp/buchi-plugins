// buchi-gateway Codex plugin core library (zero npm dependencies; Node builtins only).
// Ported from plugin/plugins/buchi/mcp/lib.mjs (Claude Code edition).
// Security invariant: no exported formatting/helper function ever returns a raw
// gateway token. Callers must additionally pass final output through sanitizeText().

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';

// ---------------------------------------------------------------------------
// Masking (single canonical implementation for ALL output paths)
// ---------------------------------------------------------------------------

/**
 * Mask a token: reveal at most the last 4 characters.
 * Display format: `buchi_••••XXXX` when prefixed, else `••••XXXX`.
 * Safety guard: if the secret body is 8 chars or fewer, reveal nothing.
 */
export function maskToken(token) {
  if (token === undefined || token === null || token === '') return '(unset)';
  const t = String(token);
  const prefix = t.startsWith('buchi_') ? 'buchi_' : '';
  const body = t.slice(prefix.length);
  if (body.length <= 8) return prefix + '••••';
  return prefix + '••••' + body.slice(-4);
}

/**
 * Mask every `/c/<token>` path segment inside a URL or free text.
 * The segment is delimited ONLY by the next `/` or end of line — spaces,
 * quotes, or brackets inside the segment do NOT terminate the mask.
 */
export function maskUrl(url) {
  if (url === undefined || url === null || url === '') return '(unset)';
  return String(url).replace(/(\/c\/)([^/\n]+)/g, (_m, p, tok) => p + maskToken(tok));
}

/**
 * Final output sweep (defense in depth). Applied to every tool response text:
 *  - replaces any literal occurrence of every known effective token
 *    (longest-first to avoid partial-overlap remnants)
 *  - unconditionally masks any residual `/c/<segment>` up to the next `/` or
 *    end of line (already-masked segments from our own formatters are left as-is)
 */
export function sanitizeText(text, secrets) {
  let out = String(text);
  const list = (typeof secrets === 'string' ? [secrets] : Array.from(secrets ?? []))
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const s of list) {
    out = out.split(s).join(maskToken(s));
  }
  return out.replace(/(\/c\/)([^/\n]+)/g, (_m, p, seg) =>
    (seg.startsWith('••••') || seg.startsWith('buchi_••••')) ? p + seg : p + '••••');
}

// ---------------------------------------------------------------------------
// Gateway URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalize user-provided gateway_url + gateway_token.
 * - parses with `new URL()` (never trusts the raw string) and REJECTS:
 *   userinfo (`https://good.com@evil.com` resolves to host=evil.com under URL
 *   semantics), non-http(s) schemes, and query/fragment components
 * - rebuilds the canonical URL from parsed components (origin + cleaned path)
 * - if the URL mistakenly embeds `/c/<token>` (and optional `/v1`), decomposes
 *   it to prevent double embedding
 * Returns { ok, url, token, warnings: string[], error?: string }.
 * Never places a raw token in warnings/error strings.
 */
export function normalizeGateway(rawUrl, rawToken) {
  const warnings = [];
  const urlStr = String(rawUrl ?? '').trim();
  let token = String(rawToken ?? '').trim();
  const fail = (error) => ({ ok: false, url: '', token, warnings, error });
  if (urlStr === '') return fail('gateway_url が未設定です。');
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return fail('gateway_url が URL として解釈できません（例: https://<あなた>.gw.buchi.ai）。');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return fail('gateway_url は http:// または https:// で始まる URL を指定してください。');
  }
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    // P1: 認証情報を運ぶ接続は通常 HTTPS 必須。HTTP は隔離された開発用(ローカル)の明示例外のみ。
    return fail('http:// は localhost / 127.0.0.1（隔離された開発用）のみ許可します。通常利用は https:// を指定してください。');
  }
  if (u.username !== '' || u.password !== '') {
    return fail('gateway_url に認証情報（user@host 形式の userinfo）が含まれています。接続先ホストの取り違えを防ぐため拒否しました。ホスト名のみの URL を指定してください。');
  }
  if (u.search !== '' || u.hash !== '') {
    return fail('gateway_url にクエリ（?...）やフラグメント（#...）は指定できません。');
  }
  // Canonical rebuild from parsed components only (raw string is not reused).
  // A mistakenly embedded /c/<token> (and optional /v1) is decomposed first to
  // prevent double embedding; what remains must be the origin root, because the
  // gateway serves /c/ at the root only (sub-paths never match → refuse).
  let url = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
  const m = url.match(/^(.*?)\/c\/([^/]+)(\/v1)?$/);
  if (m) {
    const embedded = m[2];
    url = m[1].replace(/\/+$/, '');
    if (token === '') {
      token = embedded;
      warnings.push('gateway_url に /c/<token> が埋め込まれていたため分解しました（トークンは URL から抽出）。gateway_token 側での設定を推奨します。');
    } else if (embedded === token) {
      warnings.push('gateway_url に /c/<token> が埋め込まれていたため除去しました（二重埋め込み防止）。');
    } else {
      warnings.push('gateway_url 埋め込みトークンと gateway_token が不一致です。gateway_token の値を優先し、URL 埋め込み側は破棄しました。');
    }
  }
  if (url !== u.origin) {
    return fail('gateway_url にサブパスが含まれています。ゲートウェイは起点ルート直下の /c/<token> のみ受け付けるため、ホスト名のみの URL を指定してください。');
  }
  if (token === '') {
    return fail('gateway_token が未設定です（引数 gateway_token か環境変数 BUCHI_GATEWAY_TOKEN で指定してください）。');
  }
  if (/[\s/]/.test(token)) {
    return fail('gateway_token に空白や "/" は含められません（パスベース認証の URL セグメントとして埋め込むため）。');
  }
  return { ok: true, url, token, warnings };
}

/**
 * Build the value written to [model_providers.<id>].base_url.
 * Codex REQUIRES the trailing /v1 (unlike the Claude Code edition).
 */
export function buildBaseUrl(normUrl, token) {
  return `${normUrl}/c/${token}/v1`;
}

/** Split a base_url back into { gatewayUrl, token } if it matches /c/<token>(/v1)? */
export function splitBaseUrl(baseUrl) {
  const m = String(baseUrl ?? '').match(/^(.*?)\/c\/([^/]+)(\/v1)?$/);
  if (!m) return null;
  return { gatewayUrl: m[1].replace(/\/+$/, ''), token: m[2] };
}

// ---------------------------------------------------------------------------
// Codex config path + state dir
// ---------------------------------------------------------------------------

/** CODEX_HOME honoring Codex semantics (fallback ~/.codex). */
export function resolveCodexHome() {
  const h = String(process.env.CODEX_HOME ?? '').trim();
  if (h !== '') return h;
  return path.join(os.homedir(), '.codex');
}

/**
 * Resolve target config.toml. BUCHI_CODEX_CONFIG overrides (test injection).
 * The user-level file is the only supported target: project .codex/config.toml
 * ignores model_provider/model_providers/openai_base_url by Codex design.
 */
export function resolveConfigPath() {
  if (process.env.BUCHI_CODEX_CONFIG) return process.env.BUCHI_CODEX_CONFIG;
  return path.join(resolveCodexHome(), 'config.toml');
}

/**
 * Resolution order:
 *  1. BUCHI_STATE_DIR   (test injection)
 *  2. PLUGIN_DATA       (auto-passed to bundled MCP server processes by Codex)
 *  3. $CODEX_HOME/buchi-gateway
 */
export function resolveStateDir() {
  if (process.env.BUCHI_STATE_DIR) return process.env.BUCHI_STATE_DIR;
  if (process.env.PLUGIN_DATA) return process.env.PLUGIN_DATA;
  return path.join(resolveCodexHome(), 'buchi-gateway');
}

export function statePath() {
  return path.join(resolveStateDir(), 'state.json');
}

/** Read state.json. Corrupt state is reported, not silently discarded. */
export function readState() {
  const p = statePath();
  if (!fs.existsSync(p)) return { exists: false, json: null };
  try {
    return { exists: true, json: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    const e = new Error('state.json が不正な JSON です（手動復旧が必要です）。');
    e.code = 'EINVALIDSTATE';
    throw e;
  }
}

/** Atomic write + chmod 600 (state.json holds stashed old values). */
export function writeState(json) {
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = statePath();
  const tmp = path.join(dir, `.state.json.buchi-tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600);
  return p;
}

// ---------------------------------------------------------------------------
// Atomic file IO + backup + lock (target-agnostic)
// ---------------------------------------------------------------------------

/** Write text via same-dir tmp file then rename; final mode 600. */
export function writeFileAtomic(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.buchi-tmp-${process.pid}`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, targetPath);
  fs.chmodSync(targetPath, 0o600);
}

/**
 * Copy target to `<name>.buchi-backup-<ISO8601>` and keep only the
 * newest 5 generations. Returns backup path or null (source absent).
 */
export function backupFile(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const backupPath = `${targetPath}.buchi-backup-${stamp}`;
  fs.copyFileSync(targetPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  const dir = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.buchi-backup-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse();
  for (const stale of backups.slice(5)) {
    try { fs.unlinkSync(path.join(dir, stale)); } catch { /* rotation is best-effort */ }
  }
  return backupPath;
}

/** List existing backups, newest first (for buchi_off recovery guidance). */
export function listBackups(targetPath) {
  const dir = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.buchi-backup-`;
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse()
      .map((f) => path.join(dir, f));
  } catch { return []; }
}

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Acquire `<target>.buchi-lock` exclusively.
 * Returns { ok, lockPath, warning? } or { ok:false, error }.
 */
export function acquireLock(targetPath) {
  const lockPath = `${targetPath}.buchi-lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tryOnce = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    fs.closeSync(fd);
  };
  try {
    tryOnce();
    return { ok: true, lockPath };
  } catch (err) {
    if (err.code !== 'EEXIST') return { ok: false, error: `ロック取得に失敗しました: ${err.message}` };
    let ageMs = 0;
    try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* raced away */ }
    if (ageMs > STALE_LOCK_MS) {
      try {
        fs.unlinkSync(lockPath);
        tryOnce();
        return { ok: true, lockPath, warning: `stale ロック（${Math.round(ageMs / 60000)} 分前）を検出したため奪取しました。` };
      } catch (err2) {
        return { ok: false, error: `stale ロックの奪取に失敗しました: ${err2.message}` };
      }
    }
    return { ok: false, error: '別の buchi 操作が実行中です（ロックあり）。完了を待ってから再実行してください。' };
  }
}

export function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

/** Simple sha256 hex of a string (for dry-run/apply conflict detection). */
export async function sha256Hex(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// /healthz probe (2s timeout; never throws)
// ---------------------------------------------------------------------------

/** GET <gatewayUrl>/healthz. Token never appears in the request. */
export function healthCheck(gatewayUrl, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`${String(gatewayUrl).replace(/\/+$/, '')}/healthz`); }
    catch { return resolve({ ok: false, kind: 'badurl', detail: 'URL が解釈できません' }); }
    const mod = url.protocol === 'http:' ? http : https;
    const started = Date.now();
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      const ms = Date.now() - started;
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ ok: true, status: res.statusCode, ms });
      } else {
        resolve({ ok: false, kind: 'httpstatus', status: res.statusCode, ms, detail: `HTTP ${res.statusCode}` });
      }
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => {
      const msg = String(err.message || err.code || err);
      let kind = 'network';
      if (/timeout/i.test(msg)) kind = 'timeout';
      else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) kind = 'dns';
      else if (/CERT|TLS|SSL|handshake/i.test(msg)) kind = 'tls';
      else if (/ECONNREFUSED/.test(msg)) kind = 'refused';
      resolve({ ok: false, kind, detail: msg, ms: Date.now() - started });
    });
  });
}

/** Human-readable one-liner for a healthCheck() result (D4 classification). */
export function describeHealth(h) {
  if (h.ok) return `疎通 OK (HTTP ${h.status}, ${h.ms}ms)`;
  switch (h.kind) {
    case 'dns': return `疎通 NG: DNS 解決に失敗（ホスト名を確認してください）: ${h.detail}`;
    case 'tls': return `疎通 NG: TLS エラー（証明書/プロキシの TLS 検査を確認）: ${h.detail}`;
    case 'timeout': return '疎通 NG: タイムアウト（2秒）。ネットワーク/プロキシ（HTTPS_PROXY・NO_PROXY）を確認してください。';
    case 'refused': return `疎通 NG: 接続拒否（ポート/サービス稼働を確認）: ${h.detail}`;
    case 'httpstatus': return `疎通 NG: ${h.detail}（ゲートウェイは応答するが healthz が異常）`;
    case 'badurl': return `疎通 NG: ${h.detail}`;
    default: return `疎通 NG: ${h.detail}`;
  }
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/** Compare dotted versions: -1 / 0 / 1. Unknown parts treated as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Last 4 chars of a token (for state.json / diagnostics; never the full token). */
export function tokenLast4(token) {
  const t = String(token ?? '');
  if (t.length <= 8) return '••••';
  return t.slice(-4);
}

/**
 * Resolve symlinks to the real file (chezmoi/stow/yadm managed dotfiles).
 * Editing through the link would REPLACE the link with a regular file
 * (same-dir tmp + rename) and desync the manager — see install.sh #1712.
 * Returns { path, resolved, warning? }. Throws on loops/inaccessible targets.
 */
export function resolveRealTarget(p) {
  let cur = p;
  for (let hop = 0; hop < 40; hop += 1) {
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return { path: cur, resolved: cur !== p };
    }
    if (!st.isSymbolicLink()) return { path: cur, resolved: cur !== p };
    const link = fs.readlinkSync(cur);
    cur = path.isAbsolute(link) ? link : path.join(path.dirname(cur), link);
  }
  throw new Error(`config.toml の symlink 解決でループを検出しました: ${p}（自動編集はしません）。`);
}

/** mtime+size fingerprint for final write guards (non-cooperative writers). */
export function statFingerprint(p) {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** File permission bits (e.g. 0o600) or null when unreadable. */
export function statMode(p) {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}
