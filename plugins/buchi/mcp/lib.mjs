// buchi plugin core library (zero npm dependencies; Node builtins only).
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
 * Display format per coordinator decision #3: `buchi_••••XXXX` (a recognizable
 * `buchi_` prefix is kept because it is a format marker, not secret material).
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
 * FIX-B: the segment is delimited ONLY by the next `/` or end of line (same
 * rule as splitBaseUrl) — spaces, quotes, or brackets inside the segment do
 * NOT terminate the mask, so no suffix of a weird token can leak.
 */
export function maskUrl(url) {
  if (url === undefined || url === null || url === '') return '(unset)';
  return String(url).replace(/(\/c\/)([^/\n]+)/g, (_m, p, tok) => p + maskToken(tok));
}

/**
 * Final output sweep (defense in depth). Applied to every tool response text:
 *  - replaces any literal occurrence of every known effective token
 *    (`secrets` accepts a string or an iterable; longest-first to avoid
 *    partial-overlap remnants)
 *  - unconditionally masks any residual `/c/<segment>` up to the next `/` or
 *    end of line, regardless of content (FIX-B: no reveal in the sweep path —
 *    already-masked segments from our own formatters are left as-is)
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
// Gateway URL normalization (coordinator decision #2)
// ---------------------------------------------------------------------------

/**
 * Normalize user-provided gateway_url + gateway_token.
 * - parses with `new URL()` (never trusts the raw string; FIX-A) and REJECTS:
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
  if (urlStr === '') return fail('gateway_url が未設定です。/plugin から設定してください。');
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return fail('gateway_url が URL として解釈できません（例: https://gw.example.dev）。');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return fail('gateway_url は http:// または https:// で始まる URL を指定してください。');
  }
  if (u.username !== '' || u.password !== '') {
    // FIX-A: `https://good.com@evil.com` は URL 解釈では host=evil.com になる。
    // userinfo 付き URL は黙って受理せず、接続先ホストの取り違え（全トラフィックの
    // 攻撃者ホスト送信）を防ぐため明示的に拒否する。
    return fail('gateway_url に認証情報（user@host 形式の userinfo）が含まれています。接続先ホストの取り違えを防ぐため拒否しました。ホスト名のみの URL を指定してください。');
  }
  if (u.search !== '' || u.hash !== '') {
    return fail('gateway_url にクエリ（?...）やフラグメント（#...）は指定できません。');
  }
  // Canonical rebuild from parsed components only (raw string is not reused).
  let url = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
  const m = url.match(/^(.*?)\/c\/([^/]+)(\/v1)?$/);
  if (m) {
    const embedded = m[2];
    url = m[1].replace(/\/+$/, '');
    if (m[3]) warnings.push('gateway_url 末尾の /v1 を除去しました（Claude 向け BASE_URL に /v1 は付けません）。');
    if (token === '') {
      token = embedded;
      warnings.push('gateway_url に /c/<token> が埋め込まれていたため分解しました（トークンは URL から抽出）。gateway_token 側での設定を推奨します。');
    } else if (embedded === token) {
      warnings.push('gateway_url に /c/<token> が埋め込まれていたため除去しました（二重埋め込み防止）。');
    } else {
      warnings.push('gateway_url 埋め込みトークンと gateway_token が不一致です。gateway_token の値を優先し、URL 埋め込み側は破棄しました。');
    }
  }
  if (token === '') {
    return fail('gateway_token が未設定です。/plugin から設定してください。');
  }
  if (/[\s/]/.test(token)) {
    return fail('gateway_token に空白や "/" は含められません（パスベース認証の URL セグメントとして埋め込むため）。');
  }
  return { ok: true, url, token, warnings };
}

/** Build the value written to env.ANTHROPIC_BASE_URL. No /v1 suffix (decision #1). */
export function buildBaseUrl(normUrl, token) {
  return `${normUrl}/c/${token}`;
}

/** Split a BASE_URL back into { gatewayUrl, token } if it matches /c/<token>. */
export function splitBaseUrl(baseUrl) {
  const m = String(baseUrl ?? '').match(/^(.*?)\/c\/([^/]+)(\/v1)?$/);
  if (!m) return null;
  return { gatewayUrl: m[1].replace(/\/+$/, ''), token: m[2] };
}

// ---------------------------------------------------------------------------
// settings.json IO (W1 atomic, W2 chmod 600, W3 backup x5, W5 non-destructive)
// ---------------------------------------------------------------------------

/**
 * Resolve target settings.json. BUCHI_SETTINGS_PATH overrides (test injection).
 * FIX-D: only 'user' (or empty) and 'project' are accepted. Any other value
 * throws (code 'EINVALIDSCOPE') instead of silently targeting the global
 * ~/.claude/settings.json — a typo or corrupted saved value must never cause
 * an unintended global settings modification.
 */
export function resolveSettingsPath(scope) {
  const s = (scope === undefined || scope === null || scope === '') ? 'user' : scope;
  if (s !== 'user' && s !== 'project') {
    const e = new Error(`settings_scope の値が不正です: "${scope}"。有効な値は user / project のみです（/plugin から設定し直してください）。`);
    e.code = 'EINVALIDSCOPE';
    throw e;
  }
  if (process.env.BUCHI_SETTINGS_PATH) return process.env.BUCHI_SETTINGS_PATH;
  if (s === 'project') return path.join(process.cwd(), '.claude', 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * V8's JSON.parse SyntaxError can embed a snippet of the raw parsed text
 * (e.g. `Unexpected token 'b', "{"a": buchi_dumm"... is not valid JSON`).
 * Never forward err.message verbatim into a thrown/reported error — only
 * the numeric position survives, everything else is discarded.
 */
function jsonParsePositionHint(err) {
  const m = /position (\d+)/.exec(String(err && err.message));
  return m ? `position ${m[1]}` : '位置不明';
}

/**
 * Read settings.json. Returns { exists, json }.
 * Throws Error with code 'EINVALIDJSON' if the file exists but is not valid JSON
 * (caller must abort without writing — no auto-repair).
 */
export function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { exists: false, json: {} };
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    const json = JSON.parse(raw);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      const e = new Error('settings.json のトップレベルが JSON オブジェクトではありません。');
      e.code = 'EINVALIDJSON';
      throw e;
    }
    return { exists: true, json };
  } catch (err) {
    if (err.code === 'EINVALIDJSON') throw err;
    const e = new Error(`settings.json が不正な JSON です（自動修復はしません、${jsonParsePositionHint(err)}）。`);
    e.code = 'EINVALIDJSON';
    throw e;
  }
}

/** W1+W2: write via same-dir tmp file then rename; final mode 600. */
export function writeSettingsAtomic(settingsPath, obj) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(settingsPath)}.buchi-tmp-${process.pid}`);
  const data = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, settingsPath);
  fs.chmodSync(settingsPath, 0o600);
}

/**
 * W3: copy settings.json to `<name>.buchi-backup-<ISO8601>` and keep only the
 * newest 5 generations. Returns backup path or null (source absent).
 */
export function backupSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const backupPath = `${settingsPath}.buchi-backup-${stamp}`;
  fs.copyFileSync(settingsPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  const dir = path.dirname(settingsPath);
  const prefix = `${path.basename(settingsPath)}.buchi-backup-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse();
  for (const stale of backups.slice(5)) {
    try { fs.unlinkSync(path.join(dir, stale)); } catch { /* rotation is best-effort */ }
  }
  return backupPath;
}

/** List existing backups, newest first (for buchi_off recovery guidance). */
export function listBackups(settingsPath) {
  const dir = path.dirname(settingsPath);
  const prefix = `${path.basename(settingsPath)}.buchi-backup-`;
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse()
      .map((f) => path.join(dir, f));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Exclusive lock (W7, coordinator decision #4: fs.open 'wx'; stale >10min)
// ---------------------------------------------------------------------------

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Acquire `<settings>.buchi-lock` exclusively.
 * Returns { ok, lockPath, warning? } or { ok:false, error }.
 */
export function acquireLock(settingsPath) {
  const lockPath = `${settingsPath}.buchi-lock`;
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

// ---------------------------------------------------------------------------
// state.json (W4: old-value stash; storage dir per coordinator decision #5)
// ---------------------------------------------------------------------------

/**
 * Resolution order (empirically measured against Claude Code, Phase 2 spike):
 *  1. BUCHI_STATE_DIR   (test injection)
 *  2. CLAUDE_PLUGIN_DATA (measured: IS auto-passed to MCP server processes)
 *  3. ~/.claude/plugins/data/buchi@buchi-plugins (fallback per coordinator)
 */
export function resolveStateDir() {
  if (process.env.BUCHI_STATE_DIR) return process.env.BUCHI_STATE_DIR;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'buchi@buchi-plugins');
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
  } catch (err) {
    const e = new Error(`state.json が不正な JSON です（${jsonParsePositionHint(err)}）。`);
    e.code = 'EINVALIDSTATE';
    throw e;
  }
}

/** Atomic write + chmod 600 (state.json holds the raw stashed old value). */
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
// /v1/messages pass-through probe (verify; 10s timeout; never throws)
// ---------------------------------------------------------------------------

/**
 * POST <baseUrl>/v1/messages with a minimal, harmless body (max_tokens: 1,
 * "ping"). Purpose: prove the gateway ACCEPTED the token embedded in baseUrl
 * and ran its pipeline (scan -> forward), which /healthz cannot show.
 * Default timeout 30s (overall deadline; see the note above the function).
 *
 * apiKey: if omitted, a placeholder key is sent. The gateway forwards it and
 * the upstream answers 401 authentication_error — that response shape (an
 * upstream-format error, not the gateway's own {"type":"unauthorized"}) is the
 * pass-through evidence and costs nothing. With a real key the upstream
 * answers 200 (1 output token; negligible but non-zero cost).
 *
 * Returns a classification only; the response body is never returned raw
 * (only `type`/`error.type`/`message` fields, truncated).
 */
// timeoutMs: the gateway runs its scan pipeline (secret/PII/injection; measured
// 5-6s per window on production sidecars) BEFORE forwarding, so this must be
// far longer than the 2s healthz budget. 30s measured OK against a real gateway.
// It is enforced as an OVERALL deadline (not just the socket-idle timeout), so a
// slow-drip response cannot keep the tool hanging past it.
export function probeMessages(baseUrl, { apiKey, timeoutMs = 30000, model = 'claude-haiku-4-5-20251001' } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/v1/messages`); }
    catch { return resolve({ ok: false, kind: 'badurl', detail: 'URL が解釈できません' }); }
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey || 'buchi-verify-probe-no-key',
      'user-agent': 'buchi-plugin-verify',
    };
    const started = Date.now();
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(v); } };
    const req = mod.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (raw.length < 65536) raw += d; });
      res.on('end', () => {
        const ms = Date.now() - started;
        const status = res.statusCode || 0;
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        const clip = (v) => (typeof v === 'string' ? v.slice(0, 160) : '');
        const info = {
          status,
          ms,
          bodyType: parsed && typeof parsed === 'object' ? clip(parsed.type) : '',
          errorType: parsed && parsed.error && typeof parsed.error === 'object' ? clip(parsed.error.type) : '',
          errorCode: parsed && parsed.error && typeof parsed.error === 'object' ? clip(parsed.error.code) : '',
          message: parsed && typeof parsed === 'object'
            ? clip(parsed.message || (parsed.error && typeof parsed.error === 'object' ? parsed.error.message : ''))
            : '',
          routedModel: clip(res.headers['x-buchi-routed-model']),
          trialDaysRemaining: clip(res.headers['x-buchi-trial-days-remaining'] || res.headers['x-buchi-trial-days-left']),
          budgetWarning: clip(res.headers['x-buchi-budget-warning']),
        };
        finish(classifyProbe(info));
      });
    });
    const deadline = setTimeout(() => { req.destroy(new Error('timeout')); }, timeoutMs);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => {
      const msg = String(err.message || err.code || err);
      let kind = 'network';
      if (/timeout/i.test(msg)) kind = 'timeout';
      else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) kind = 'dns';
      else if (/CERT|TLS|SSL|handshake/i.test(msg)) kind = 'tls';
      else if (/ECONNREFUSED/.test(msg)) kind = 'refused';
      finish({ ok: false, kind, detail: msg, ms: Date.now() - started, timeoutMs });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Classify a probe response into pass-through evidence.
 *
 * Body shapes (measured against the real gateway, 2026-09-16):
 *   gateway's own errors (writeErr)      : {"error":{"type":"unauthorized","message":"invalid gateway token"}}
 *   gateway's own errors (writeJSONError): {"error":{"code":"...","message":"..."}}
 *   gateway DLP block                    : {"error":{"type":"blocked_sensitive_content",...}}   (HTTP 400; writeErrBlocked)
 *   Anthropic upstream error (forwarded) : {"type":"error","error":{"type":"authentication_error",...}}
 * i.e. the top-level "type":"error" marker is what distinguishes a forwarded
 * upstream error from an error the gateway produced itself.
 *
 *   passed=true  : the gateway accepted the token and forwarded (or ran its
 *                  pipeline on) the request. kind: 'upstream_ok' (200),
 *                  'upstream_auth' (upstream-format 401), 'blocked' (gateway
 *                  DLP block, HTTP 400), 'accepted_other' (other upstream-format error).
 *   passed=false : kind 'gateway_token' (gateway's own 401 invalid token),
 *                  'gateway_other' (gateway-format non-auth error), or a
 *                  network kind from probeMessages.
 */
export function classifyProbe(info) {
  const upstreamShaped = info.bodyType === 'error' && info.errorType !== '';
  const gatewayShaped = info.bodyType === '' && (info.errorType !== '' || info.errorCode !== '');
  // 2xx alone is NOT evidence: a captive portal, a catch-all reverse proxy or a
  // wrong BASE_URL pointing at an unrelated server also answers 200. Require the
  // Anthropic Messages response shape ({"type":"message",...}) that a forwarded
  // upstream reply (or the E2E mock upstream) actually carries.
  if (info.status >= 200 && info.status < 300) {
    if (info.bodyType === 'message') return { ok: true, passed: true, kind: 'upstream_ok', ...info };
    return { ok: true, passed: false, kind: 'unknown', ...info };
  }
  if (info.status === 401 && !upstreamShaped && (info.errorType === 'unauthorized' || /invalid gateway token/i.test(info.message))) {
    return { ok: true, passed: false, kind: 'gateway_token', ...info };
  }
  if (info.status === 401 && upstreamShaped) return { ok: true, passed: true, kind: 'upstream_auth', ...info };
  // Auto-routing (#1128) may forward to an OpenAI-compatible upstream whose 401 has
  // no top-level "type": {"error":{"type":"invalid_request_error","code":"invalid_api_key"}}.
  // That is still a forwarded upstream auth error, i.e. pass-through evidence.
  if (info.status === 401 && info.errorCode === 'invalid_api_key') return { ok: true, passed: true, kind: 'upstream_auth', ...info };
  // DLP block: the real gateway answers HTTP 400 (writeErrBlocked); match on the
  // error type only so a future status change cannot silently demote this to gateway_other.
  if (info.errorType === 'blocked_sensitive_content') return { ok: true, passed: true, kind: 'blocked', ...info };
  if (upstreamShaped) return { ok: true, passed: true, kind: 'accepted_other', ...info };
  if (gatewayShaped) return { ok: true, passed: false, kind: 'gateway_other', ...info };
  return { ok: true, passed: false, kind: 'unknown', ...info };
}

/** Human-readable lines for a probeMessages()/classifyProbe() result. */
export function describeProbe(p) {
  if (!p.ok) {
    if (p.kind === 'timeout') {
      return `[NG] 通過未確認: タイムアウト（${Math.round((p.timeoutMs || 0) / 1000)}秒）。ゲートウェイの検査層が混雑しているか、ネットワーク/プロキシ（HTTPS_PROXY・NO_PROXY）を確認してください。`;
    }
    const h = describeHealth({ ok: false, kind: p.kind, detail: p.detail });
    return `[NG] 通過未確認: ${h.replace(/^疎通 NG: /, '')}`;
  }
  const extra = [];
  if (p.routedModel) extra.push(`ルーティング先モデル=${p.routedModel}`);
  if (p.trialDaysRemaining) extra.push(`トライアル残 ${p.trialDaysRemaining} 日`);
  if (p.budgetWarning) extra.push(`予算警告 ${p.budgetWarning}%`);
  const tail = extra.length ? `（${extra.join(' / ')}）` : '';
  switch (p.kind) {
    case 'upstream_ok':
      return `[OK] 通過確認済み: ゲートウェイがトークンを受理し、上流から応答が返りました (HTTP ${p.status}, ${p.ms}ms)${tail}`;
    case 'upstream_auth':
      return `[OK] 通過確認済み: ゲートウェイがトークンを受理して上流へ転送しました (上流の認証エラー HTTP ${p.status} を受信、${p.ms}ms)。上流 API キー/サブスク認証は本プローブでは検証していません${tail}`;
    case 'blocked':
      return `[OK] 通過確認済み: ゲートウェイの検査層が動作しました (HTTP ${p.status} blocked_sensitive_content, ${p.ms}ms)${tail}`;
    case 'accepted_other':
      return `[OK] 通過確認済み: ゲートウェイがトークンを受理し、上流形式の応答 (HTTP ${p.status} ${p.errorType}) が返りました${tail}`;
    case 'gateway_token':
      return `[NG] 通過未確認: ゲートウェイがトークンを拒否しました (HTTP 401 invalid gateway token)。gateway_token を確認してください`;
    case 'gateway_other':
      return `[NG] 通過未確認: ゲートウェイ自身がエラーを返しました (HTTP ${p.status} ${p.errorType || p.errorCode}${p.message ? ': ' + p.message : ''})`;
    default:
      if (p.status >= 200 && p.status < 300) {
        return `[NG] 通過未確認: HTTP ${p.status} が返りましたが Anthropic Messages 形式の応答ではありません（キャプティブポータル/別サーバー/誤った BASE_URL の可能性。/buchi:doctor で確認してください）`;
      }
      return `[?] 判定不能: HTTP ${p.status}${p.errorType ? ' ' + p.errorType : ''}${p.message ? ': ' + p.message : ''}`;
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
