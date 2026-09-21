// buchiai-gateway Codex plugin MCP server (stdio, zero npm dependencies).
// Tools: buchi_setup / buchi_status / buchi_doctor / buchi_off / buchi_on / buchi_verify.
//
// Security invariants (non-negotiable):
//   - never read ~/.codex/auth.json (or any *auth*/credentials/token store of Codex).
//     Upstream API keys and OAuth tokens are fully out of scope.
//   - every tool response passes through sanitizeText() with all tokens seen
//     during the call (config base_url token, input token).
//   - config.toml edits: lock -> re-read+hash check -> backup -> atomic write.
//   - verify never claims passage without gateway-side correlation
//     (seen-response endpoint) for a response_id taken from Codex's own rollout.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  maskToken, maskUrl, sanitizeText, normalizeGateway, buildBaseUrl, splitBaseUrl,
  resolveConfigPath, resolveCodexHome, resolveStateDir, statePath, readState, writeState,
  writeFileAtomic, backupFile, listBackups, acquireLock, releaseLock, sha256Hex,
  healthCheck, describeHealth, compareVersions, tokenLast4,
  resolveRealTarget, statFingerprint, statMode,
} from './lib.mjs';
import {
  parseToml, serializeToml, findTopLevel, findTable, setTopLevel, deleteTopLevel,
  setTable, deleteTable, readTable, validateManaged, findSuspicious, spliceTableRaw,
  findArrayManaged,
} from './toml.mjs';

const SERVER_STARTED_AT = Date.now();
const MIN_CODEX_VERSION = '0.154.0'; // verified version (doctor warns below, never hard-fails)
const MANAGED_PROVIDERS = ['buchi', 'buchi_sub'];
const PROVIDER_FOR_AUTH = { api: 'buchi', subscription: 'buchi_sub' };
const RESP_ID_RE = /^resp_[A-Za-z0-9_-]{8,128}$/;
const VERIFY_PROMPT = 'Reply with exactly: ok';
const PLACEHOLDER_KEY = 'buchi-placeholder-key';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function codexBin() {
  // BUCHI_CODEX_BIN is a TEST hook (stub binary in hermetic tests). Production
  // always uses 'codex' from PATH. Arguments are passed as an array (no shell).
  return process.env.BUCHI_CODEX_BIN || 'codex';
}

function runCmd(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 15000;
    // stdin は必ず ignore (/dev/null) にする。`codex exec` はパイプ接続の stdin を
    // 追加入力として EOF まで読みに行くため、開きっぱなしのパイプを継承すると
    // ターンを実行せず stdin 待ちで固まる（実測で exit 0 無要求を確認）。
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, code: null, signal: null, stdout: '', stderr: String(e.message || e).slice(0, 2000), timedOut: false });
    }
    let stdout = ''; let stderr = ''; let done = false;
    const finish = (ok, extra = {}) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ ok, code: null, signal: null, stdout, stderr: stderr.slice(0, 2000), timedOut: false, ...extra });
    };
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ok: false, code: null, signal: 'SIGKILL', stdout, stderr: stderr.slice(0, 2000), timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 262144) stdout = stdout.slice(0, 262144); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 32768) stderr = stderr.slice(-32768); });
    child.on('error', (e) => finish(false, { error: String(e.message || e) }));
    child.on('close', (code) => finish(code === 0, { code }));
  });
}

function httpGetJson(urlStr, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch { return resolve({ ok: false, error: 'badurl' }); }
    const mod = url.protocol === 'http:' ? http : https;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 65536) { res.destroy(); done({ ok: false, error: 'response too large' }); } });
      res.on('end', () => done({ ok: true, status: res.statusCode, body: data }));
      // destroy() 後に end が発火しない場合の安全網（Promise 宙ぶらりん防止）。
      res.on('close', () => done({ ok: false, error: 'connection closed' }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: String(e.message || e.code || e) }));
  });
}

function httpPostJson(urlStr, bodyObj, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch { return resolve({ ok: false, error: 'badurl' }); }
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(bodyObj);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = mod.request(url, {
      method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 262144) { res.destroy(); done({ ok: false, error: 'response too large' }); } });
      res.on('end', () => done({ ok: true, status: res.statusCode, body: data }));
      res.on('close', () => done({ ok: false, error: 'connection closed' }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: String(e.message || e.code || e) }));
    req.write(body);
    req.end();
  });
}

function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) return { exists: false, text: '' };
  return { exists: true, text: fs.readFileSync(configPath, 'utf8') };
}

function desiredTable(auth, baseUrl) {
  if (auth === 'subscription') {
    return { name: 'Buchi Gateway', base_url: baseUrl, requires_openai_auth: true, wire_api: 'responses' };
  }
  return { name: 'Buchi Gateway', base_url: baseUrl, env_key: 'OPENAI_API_KEY', wire_api: 'responses' };
}

/** base_url からホストを取り出す。不正 URL では throw せず null（案内付き処理用）。 */
function baseUrlHost(baseUrl) {
  try {
    const sp = splitBaseUrl(baseUrl);
    if (!sp) return null;
    return new URL(sp.gatewayUrl).host;
  } catch {
    return null;
  }
}

function profileFiles() {
  const dir = resolveCodexHome();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.config.toml'))
      .map((f) => path.join(dir, f));
  } catch { return []; }
}

/**
 * buchi 管理テーブルの選択: model_provider が指すテーブルを優先する。
 * buchi / buchi_sub 併存時に先頭固定で選ぶと、非アクティブ側のトークンで
 * プローブ・照会して恒久的な偽陰性になる（push-gate adversarial 指摘）。
 */
function selectManagedProvider(parsed, mpVal) {
  const present = [];
  for (const name of MANAGED_PROVIDERS) {
    const t = readTable(parsed, `model_providers.${name}`);
    if (t?.base_url) present.push({ provider: name, baseUrl: t.base_url });
  }
  if (present.length === 0) return { provider: null, baseUrl: null };
  const match = present.find((p) => p.provider === mpVal);
  return match ?? present[0];
}

// --- rollout inspection (Codex's own session records; read-only) ---

function listRollouts() {
  const base = path.join(resolveCodexHome(), 'sessions');
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try { out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs }); } catch { /* raced */ }
      }
    }
  };
  walk(base);
  return out;
}

/**
 * Parse the head (first 64 KiB, for session_meta) + tail (last 512 KiB, for
 * records) of a rollout file. Bounded reads only.
 * Returns { modelProvider, modelProviderId, model, cwd, responseIds: [], sessionIds: [] }.
 * NEVER returns message content.
 */
function inspectRollout(rolloutPath) {
  const info = { modelProvider: null, modelProviderId: null, model: null, cwd: null, responseIds: [], sessionIds: [] };
  let chunks = [];
  try {
    const st = fs.statSync(rolloutPath);
    const fd = fs.openSync(rolloutPath, 'r');
    try {
      const headLen = Math.min(st.size, 64 * 1024);
      const hb = Buffer.alloc(headLen);
      fs.readSync(fd, hb, 0, headLen, 0);
      chunks.push(hb.toString('utf8'));
      if (st.size > headLen) {
        const tailLen = Math.min(st.size - headLen, 512 * 1024);
        const tb = Buffer.alloc(tailLen);
        fs.readSync(fd, tb, 0, tailLen, st.size - tailLen);
        chunks.push(tb.toString('utf8'));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { return info; }
  const lines = chunks.join('\n').split('\n');
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;
    if (o.type === 'session_meta' && typeof p.model_provider === 'string') info.modelProvider = p.model_provider;
    if (o.type === 'session_meta') {
      for (const k of ['session_id', 'id', 'parent_thread_id']) {
        if (typeof p[k] === 'string' && p[k] !== '' && !info.sessionIds.includes(p[k])) info.sessionIds.push(p[k]);
      }
      if (typeof p.cwd === 'string' && p.cwd !== '') info.cwd = p.cwd;
    }
    if (o.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings) {
      if (typeof p.thread_settings.model_provider_id === 'string') info.modelProviderId = p.thread_settings.model_provider_id;
      if (typeof p.thread_settings.model === 'string') info.model = p.thread_settings.model;
    }
    if (o.type === 'token_usage_record' && typeof p.response_id === 'string' && RESP_ID_RE.test(p.response_id)) {
      info.responseIds.push(p.response_id);
    }
  }
  return info;
}

function newestRollout() {
  const all = listRollouts();
  if (all.length === 0) return null;
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all[0];
}

// ---------------------------------------------------------------------------
// tool implementations (each returns { text, isError } — text already masked)
// ---------------------------------------------------------------------------

function inputToken(args) {
  const fromArg = String(args?.gateway_token ?? '').trim();
  if (fromArg !== '') return { token: fromArg, from: '引数 gateway_token' };
  const fromEnv = String(process.env.BUCHI_GATEWAY_TOKEN ?? '').trim();
  if (fromEnv !== '') return { token: fromEnv, from: '環境変数 BUCHI_GATEWAY_TOKEN' };
  return { token: '', from: '' };
}

async function toolSetup(args) {
  const secrets = [];
  const apply = args?.apply === true;
  const overwrite = args?.overwrite === true;
  const auth = args?.auth;
  if (auth !== 'api' && auth !== 'subscription') {
    return { text: 'auth を指定してください（"api" または "subscription"）。APIキー方式は "api"、ChatGPTサブスク方式は "subscription" です。', isError: true };
  }
  const { token, from } = inputToken(args);
  if (!token) {
    return { text: 'gateway_token が未設定です。会話への平文貼り付けを避けるため、端末で `read -s BUCHI_GATEWAY_TOKEN` → export してから再実行するか、引数 gateway_token で指定してください（引数はセッション記録に残る点に注意）。', isError: true };
  }
  secrets.push(token);
  const tokenFrom = args?._tokenFrom ?? from;
  const norm = normalizeGateway(args?.gateway_url, token);
  if (!norm.ok) return { text: sanitizeText(norm.error, secrets), isError: true };
  const provider = PROVIDER_FOR_AUTH[auth];
  const baseUrl = buildBaseUrl(norm.url, norm.token);
  const configPath = resolveConfigPath();
  // Symlink 解決 (#1712 と同型事故の防止): 編集対象は実ファイルに固定し、
  // リンク自体を通常ファイルで置換しない。dry-run で解決先を明示する。
  let target = configPath;
  let symlinkNote = null;
  try {
    const real = resolveRealTarget(configPath);
    target = real.path;
    if (real.resolved) symlinkNote = `config.toml が symlink のため実体 ${target} を編集します（リンクは保持されます）。`;
  } catch (e) {
    return { text: sanitizeText(`config.toml の解決に失敗したため中断しました: ${e.message}`, secrets), isError: true };
  }

  const cur = readConfigFile(target);
  let parsed;
  try {
    parsed = parseToml(cur.text);
  } catch (e) {
    return { text: sanitizeText(`config.toml が不正のため中断しました（自動修復はしません）: ${e.message}`, secrets), isError: true };
  }
  const warnings = [...norm.warnings, ...parsed.warnings];
  if (symlinkNote) warnings.push(symlinkNote);
  const arrManaged = findArrayManaged(parsed, MANAGED_PROVIDERS);
  if (arrManaged.length > 0) {
    return {
      text: sanitizeText([
        `[[array]] 形式の buchi テーブルがあります（${arrManaged.map((a) => `${a.lineNo} 行目`).join('、')}）。本プラグインは [単一] テーブルのみ管理するため自動編集しません。手動で [model_providers.<name>] 形式に統合してください。`,
      ].join('\n'), secrets),
      isError: true,
    };
  }
  const broken = findSuspicious(parsed);
  if (broken.length > 0) {
    return { text: sanitizeText(`config.toml に不正の疑いがある行があるため中断しました（自動修復はしません）: ${broken.map((b) => `${b.lineNo} 行目・${b.reason}`).join('、')}。doctor の D2 を確認し、手動で修正してください。`, secrets), isError: true };
  }
  const curProvider = findTopLevel(parsed, 'model_provider');
  const curTable = readTable(parsed, `model_providers.${provider}`);
  const otherProvider = provider === 'buchi' ? 'buchi_sub' : 'buchi';
  const otherTable = readTable(parsed, `model_providers.${otherProvider}`);
  if (otherTable?.base_url) {
    warnings.push(`別の buchi 方式のテーブル [model_providers.${otherProvider}] が存在します。両方式の併存は可能ですが、model_provider が指す方だけが有効です。`);
  }
  if (curTable?.base_url && curTable.base_url !== baseUrl && !overwrite) {
    const head = ['buchi 接続セットアップ（Codex）', `- 対象: ${target}`];
    if (symlinkNote) head.push(`- ${symlinkNote}`);
    return {
      text: sanitizeText([...head,
        `競合: [model_providers.${provider}] が既に別の接続先を指しています（${maskUrl(curTable.base_url)}）。上書きしません。`,
        '既存設定を確認し、意図的に置き換える場合は overwrite: true を付けて再実行してください（旧値は state.json とバックアップに退避されます）。',
      ].join('\n'), secrets),
      isError: true,
    };
  }
  if (findTopLevel(parsed, 'openai_base_url')) {
    warnings.push('openai_base_url が設定されています（組み込み openai プロバイダの上書き）。buchi テーブルには影響しませんが、off 後の挙動と混同しないよう注意してください。');
  }
  const profiles = profileFiles();
  if (profiles.length > 0) {
    warnings.push(`プロファイル設定が ${profiles.length} 件あります（--profile で provider が上書きされる可能性があります）: ${profiles.map((p) => path.basename(p)).join(', ')}`);
  }
  if (tokenFrom.startsWith('引数')) {
    warnings.push('トークンを引数で受け取りました（セッション記録に残ります）。次回からは環境変数 BUCHI_GATEWAY_TOKEN の利用を推奨します。');
  }

  const lines = [
    'buchi 接続セットアップ（Codex）',
    `- 対象: ${target}`,
    `- 方式: ${auth === 'api' ? 'APIキー方式' : 'ChatGPTサブスク方式'}（プロバイダ: ${provider}）`,
    `- model_provider: ${curProvider ? curProvider.line.value.parsed : '(未設定)'} → "${provider}"`,
    `- [model_providers.${provider}]: ${curTable ? '更新' : '新規作成'}（base_url=${maskUrl(baseUrl)}）`,
  ];
  if (warnings.length > 0) lines.push('警告:', ...warnings.map((w) => `- ${w}`));
  lines.push('適用後は Codex の再起動（TUI/IDE の再起動）が必要です。設定は起動時に読み込まれます。');

  if (!apply) {
    const planHash = await sha256Hex(`${cur.text}\n${auth}\n${provider}\n${baseUrl}`);
    lines.push(`plan: ${planHash}`);
    lines.push('dry-run のため書き込んでいません。内容を確認し、同意したら同じ plan 値と共に plan_hash 付き・apply: true で再実行してください（plan が一致しない場合は外部変更または引数変更として中止します）。');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }

  const lock = acquireLock(target);
  if (!lock.ok) return { text: sanitizeText(lock.error, secrets), isError: true };
  try {
    const cur2 = readConfigFile(target);
    const h1 = await sha256Hex(cur.text);
    const h2 = await sha256Hex(cur2.text);
    if (h1 !== h2) {
      return { text: sanitizeText('適用直前の再読込で config.toml の変更を検出しました。中止します（再実行して最新の差分を確認してください）。', secrets), isError: true };
    }
    // 変更なしの apply は plan 不要で正常終了（冪等）。
    {
      const pTmp = parseToml(cur2.text);
      const sameProvider = findTopLevel(pTmp, 'model_provider')?.line.value.parsed === provider;
      const sameTable = JSON.stringify(readTable(pTmp, `model_providers.${provider}`) ?? null) === JSON.stringify(desiredTable(auth, baseUrl));
      if (sameProvider && sameTable) {
        return { text: sanitizeText([...lines, '変更はありませんでした（既に同一設定・冪等）。'].join('\n'), secrets) };
      }
    }
  // plan_hash 必須: 同意した dry-run 時点のファイル内容・引数と一致しなければ
  // 適用しない（dry-run→apply 間の外部変更・引数差し替えの検出。省略不可）。
  if (args?.plan_hash === undefined || args.plan_hash === '') {
    return { text: sanitizeText('apply には dry-run 出力の plan 値（plan_hash）が必須です。先に dry-run を実行し、その plan_hash を付けて再実行してください。', secrets), isError: true };
  }
  const expectedPlan = await sha256Hex(`${cur2.text}\n${auth}\n${provider}\n${baseUrl}`);
  if (args.plan_hash !== expectedPlan) {
    return { text: sanitizeText('plan_hash が一致しません（dry-run 後にファイルまたは引数が変わりました）。最新の dry-run を取り直して plan 値を確認してください。', secrets), isError: true };
  }
    const fp1 = statFingerprint(target);
    const prevMode = statMode(target);
    const p2 = parseToml(cur2.text);
    if (findSuspicious(p2).length > 0) {
      return { text: sanitizeText('config.toml に不正の疑いがある行があるため書き込みません（自動修復はしません）。doctor の D2 を確認し、手動で修正してください。', secrets), isError: true };
    }
    // 上書きで失われる既存テーブル内容を退避する（off で完全復元するため）。
    // state.json は 0600。旧トークンを含み得ることは README に明記する。
    let stashedTable = null;
    {
      const ex = findTable(p2, `model_providers.${provider}`);
      if (ex) {
        const raw = p2.lines.slice(ex.start, ex.end).map((l) => l.text).join('\n');
        const curBase = readTable(p2, `model_providers.${provider}`)?.base_url;
        if (curBase && curBase !== baseUrl) stashedTable = raw;
      }
    }
    setTopLevel(p2, 'model_provider', provider);
    setTable(p2, `model_providers.${provider}`, desiredTable(auth, baseUrl));
    const newText = serializeToml(p2);
    if (newText === cur2.text) {
      return { text: sanitizeText([...lines, '変更はありませんでした（既に同一設定・冪等）。'].join('\n'), secrets) };
    }
    // 非協調ライタ対策の最終ガード: 再読込→書込の間に変わっていたら中止する。
    const fp2 = statFingerprint(target);
    if (JSON.stringify(fp1) !== JSON.stringify(fp2)) {
      return { text: sanitizeText('適用直前に config.toml が外部変更されました。中止します（再実行してください）。', secrets), isError: true };
    }
    const backup = backupFile(target);
    // state 読込は config 書込より先に確定させる（書込後の state 失敗で
    // 不整合状態を作らないため）。writeState 自体の失敗も明示する。
    let prev = null;
    try {
      const st = readState();
      if (st.exists && st.json && typeof st.json === 'object') prev = st.json;
    } catch (e) { return { text: sanitizeText(`state.json が不正のため中断しました（config.toml は未変更です）: ${e.message}`, secrets), isError: true }; }
    writeFileAtomic(target, newText);
    const nextState = {
      version: 1,
      auth, provider,
      gateway_url: norm.url,
      gateway_host: new URL(norm.url).host,
      token_last4: tokenLast4(norm.token),
      prev_model_provider: (prev && 'prev_model_provider' in prev)
        ? prev.prev_model_provider
        : (curProvider ? curProvider.line.value.parsed : null),
      prev_tables: {
        ...((prev && prev.prev_tables && typeof prev.prev_tables === 'object') ? prev.prev_tables : {}),
        ...(stashedTable ? { [provider]: stashedTable } : {}),
      },
      config_path: target,
      prev_mode: prevMode,
      applied_at: new Date().toISOString(),
      last_verify: (prev && prev.last_verify) ? prev.last_verify : null,
    };
    try {
      writeState(nextState);
    } catch (e) {
      const done = [...lines,
        `config.toml は書き換え済みですが、state.json の保存に失敗しました: ${e.message}`,
        `バックアップ (${backup ?? '（なし）'}) から手動復元するか、state.json を修復して setup を再実行してください。off による自動復元は state.json が無いため force が必要です。`];
      return { text: sanitizeText(done.join('\n'), secrets), isError: true };
    }
    const done = [...lines, `適用しました（バックアップ: ${backup ?? '（新規作成のためなし）'}）。`, 'Codex を再起動してから buchi_verify で確認してください。'];
    if (lock.warning) done.push(lock.warning);
    return { text: sanitizeText(done.join('\n'), secrets) };
  } finally {
    releaseLock(lock.lockPath);
  }
}

async function toolStatus() {
  const secrets = [];
  const lines = ['buchi 接続状態（Codex）'];
  const configPath = resolveConfigPath();
  lines.push(`- 設定ファイル: ${configPath}`);
  const cur = readConfigFile(configPath);
  if (!cur.exists) {
    lines.push('- [1/4] 設定済み: [NG] config.toml が存在しません（setup を実行してください）');
    return { text: lines.join('\n') };
  }
  let parsed;
  try {
    parsed = parseToml(cur.text);
  } catch (e) {
    lines.push(`- [1/4] 設定済み: [NG] config.toml が不正です: ${e.message}`);
    return { text: lines.join('\n') };
  }
  let st = null;
  let stateError = null;
  try { const r = readState(); if (r.exists) st = r.json; } catch (e) { stateError = e.message; }
  if (stateError) lines.push(`- [注意] state.json が不正です: ${stateError}`);
  for (const b of findSuspicious(parsed)) {
    lines.push(`- [注意] config.toml に不正の疑いがある行があります (${b.lineNo} 行目・${b.reason}): ${b.preview}`);
  }

  const mp = findTopLevel(parsed, 'model_provider');
  const mpVal = mp ? mp.line.value.parsed : null;
  const { provider: activeProvider, baseUrl: activeBase } = selectManagedProvider(parsed, mpVal);
  if (activeBase) {
    const sp = splitBaseUrl(activeBase);
    if (sp) secrets.push(sp.token);
    lines.push(`- [1/4] 設定済み: [OK] model_provider=${mpVal ?? '(未設定)'} / [model_providers.${activeProvider}] base_url=${maskUrl(activeBase)}`);
    if (mpVal !== activeProvider) {
      lines.push(`  [注意] model_provider が "${mpVal}" のため、現在の buchi テーブルは有効ではありません（on/setup で切り替えてください）。`);
    }
  } else {
    lines.push('- [1/4] 設定済み: [NG] buchi 管理のプロバイダテーブルがありません（setup を実行してください）');
  }

  const gwHost = activeBase && splitBaseUrl(activeBase) ? splitBaseUrl(activeBase).gatewayUrl : (st?.gateway_url ?? (st?.gateway_host ? `https://${st.gateway_host}` : null));
  if (gwHost) {
    const h = await healthCheck(gwHost);
    lines.push(`- [2/4] 疎通成功: ${h.ok ? '[OK]' : '[NG]'} ${maskUrl(gwHost)}/healthz → ${describeHealth(h)}`);
  } else {
    lines.push('- [2/4] 疎通成功: [NG] 接続先が特定できません（setup を実行してください）');
  }

  try {
    const mtime = fs.statSync(configPath).mtimeMs;
    if (mtime > SERVER_STARTED_AT) {
      lines.push('- [3/4] 稼働反映: [注意] この Codex プロセス起動後に config.toml が変更されています。再起動待ちの可能性があります。');
    } else {
      lines.push('- [3/4] 稼働反映: [OK] この Codex プロセス起動後の config.toml 変更はありません。');
    }
  } catch { lines.push('- [3/4] 稼働反映: [注意] config.toml の時刻を確認できませんでした。'); }
  const latest = newestRollout();
  if (latest) {
    const info = inspectRollout(latest.path);
    const when = new Date(latest.mtimeMs).toISOString();
    const prov = info.modelProviderId ?? info.modelProvider ?? '(不明)';
    lines.push(`- [3/4] 最新セッション: ${when} に provider=${prov} を使用（rollout 記録より）`);
    if (activeProvider && prov !== activeProvider) {
      lines.push('  [注意] 最新セッションのプロバイダが現在の buchi 設定と異なります（再起動前・別プロファイル・手動切替の可能性）。');
    }
  } else {
    lines.push('- [3/4] 最新セッション: rollout 記録がありません（まだ Codex セッションが無いか、CODEX_HOME が異なります）。');
  }

  if (st?.last_verify) {
    lines.push(`- [4/4] 実際の通過: ${st.last_verify.passed ? '[OK] 通過確認済み' : '[NG] 未確認'}（${st.last_verify.at}、response_id=${st.last_verify.response_id ?? '(不明)'}）`);
  } else {
    lines.push('- [4/4] 実際の通過: [未確認] buchi_verify で確認してください（設定・疎通だけでは通過と断定しません）。');
  }
  return { text: sanitizeText(lines.join('\n'), secrets) };
}

async function toolDoctor() {
  const secrets = [];
  const lines = ['buchi 診断（Codex、D1〜D7）'];
  const configPath = resolveConfigPath();

  const ver = await runCmd(codexBin(), ['--version'], { timeoutMs: 10000 });
  if (ver.ok) {
    const m = ver.stdout.match(/(\d+\.\d+\.\d+)/);
    const v = m ? m[1] : '(不明)';
    lines.push(compareVersions(v, MIN_CODEX_VERSION) >= 0 || v === '(不明)'
      ? `D1 [OK] Codex バージョン: ${ver.stdout.trim().slice(0, 80)}`
      : `D1 [注意] Codex バージョン ${v} は検証済み ${MIN_CODEX_VERSION} 未満です（動作未確認）。`);
  } else {
    lines.push('D1 [注意] `codex --version` を実行できませんでした（PATH を確認してください）。判定をスキップします。');
  }

  const cur = readConfigFile(configPath);
  if (!cur.exists) {
    lines.push(`D2 [NG] config.toml が存在しません: ${configPath}（setup を実行してください）。`);
    return { text: lines.join('\n') };
  }
  let parsed;
  try {
    parsed = parseToml(cur.text);
    lines.push('D2 [OK] config.toml は解釈可能です。');
  } catch (e) {
    lines.push(`D2 [NG] config.toml が不正です（自動修復はしません）: ${e.message}`);
    return { text: lines.join('\n') };
  }
  for (const w of parsed.warnings) lines.push(`D2 [注意] ${w}`);
  for (const b of findSuspicious(parsed)) {
    lines.push(`D2 [NG] 不正の疑いがある行 (${b.lineNo} 行目・${b.reason}): ${b.preview}`);
  }
  for (const w of validateManaged(parsed, MANAGED_PROVIDERS)) {
    lines.push(`D2 [注意] ${w}`);
    const t = readTable(parsed, 'model_providers.buchi') ?? readTable(parsed, 'model_providers.buchi_sub');
    if (t?.base_url) { const sp = splitBaseUrl(t.base_url); if (sp) secrets.push(sp.token); }
  }
  {
    const t = readTable(parsed, 'model_providers.buchi') ?? readTable(parsed, 'model_providers.buchi_sub');
    if (t?.base_url) { const sp = splitBaseUrl(t.base_url); if (sp) secrets.push(sp.token); }
  }

  const envNames = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY'];
  const present = envNames.filter((n) => process.env[n] !== undefined && process.env[n] !== '');
  lines.push(`D3 設定の競合: 環境変数（値ではなく有無のみ）: ${present.length > 0 ? present.join(', ') + ' が設定済み' : '該当なし'}`);
  if (present.includes('OPENAI_API_KEY')) lines.push('D3 [情報] OPENAI_API_KEY が設定されています（APIキー方式の上流認証に使用。値は確認しません）。未設定の場合、APIキー方式の要求は認証失敗します。');
  if (present.includes('OPENAI_BASE_URL')) lines.push('D3 [注意] OPENAI_BASE_URL が設定されていますが、Codex はこの環境変数を参照しません（有効な上書きは config.toml の openai_base_url です）。意図しない設定の混同に注意してください。');
  if (findTopLevel(parsed, 'openai_base_url')) lines.push('D3 [注意] config.toml の openai_base_url が設定されています（組み込み openai プロバイダを上書き。buchi テーブルには影響しません）。');
  const profiles = profileFiles();
  if (profiles.length > 0) lines.push(`D3 [注意] プロファイル設定が ${profiles.length} 件あります（--profile で provider が上書きされる可能性）: ${profiles.map((p) => path.basename(p)).join(', ')}`);
  else lines.push('D3 [OK] プロファイル上書きファイルはありません。');

  const anyTable = readTable(parsed, 'model_providers.buchi') ?? readTable(parsed, 'model_providers.buchi_sub');
  const sp = anyTable?.base_url ? splitBaseUrl(anyTable.base_url) : null;
  if (sp) {
    const h = await healthCheck(sp.gatewayUrl);
    lines.push(`D4 ${h.ok ? '[OK]' : '[NG]'} healthz (${maskUrl(sp.gatewayUrl)}/healthz): ${describeHealth(h)}`);
  } else {
    lines.push('D4 [注意] healthz: スキップ（/c/<token> 形式の base_url がありません）。');
  }

  lines.push('D5 [注意] トークン有効性: doctor では検証しません（doctor はトークンを送信しません）。buchi_verify で「設定済み / 疎通 / 実際の通過」を分けて確認できます。');

  lines.push('D6 認証方式: 上流の API キー・OAuth トークン・auth.json は読み取りも出力もしません。Codex 側の認証状態は `codex doctor` の auth 節で各自確認してください。');
  const subTable = readTable(parsed, 'model_providers.buchi_sub');
  const apiTable = readTable(parsed, 'model_providers.buchi');
  if (subTable?.base_url && !apiTable?.base_url) lines.push('D6 [情報] サブスク方式のテーブルがあります。`codex login` 済みである必要があります（未ログインでは認証失敗します）。');
  if (apiTable?.base_url && !present.includes('OPENAI_API_KEY')) lines.push('D6 [注意] APIキー方式のテーブルがありますが OPENAI_API_KEY が未設定です（認証失敗します）。');

  lines.push('D7 [常に表示] サブスク方式では圧縮による金銭的削減はありません（目的は DLP と利用可視化）。従量課金（APIキー）利用時のみコスト削減効果があります。');
  lines.push('D7 [常に表示] 本プラグインに強制力はありません（config.toml を手で戻せば外れます）。Codex cloud は対象外です。設定変更後は Codex の再起動が必要です。');
  return { text: sanitizeText(lines.join('\n'), secrets) };
}

async function toolOff(args) {
  const secrets = [];
  const apply = args?.apply === true;
  const force = args?.force === true;
  const configPath = resolveConfigPath();
  let target = configPath;
  try {
    target = resolveRealTarget(configPath).path;
  } catch (e) {
    return { text: sanitizeText(`config.toml の解決に失敗したため中断しました: ${e.message}`, secrets), isError: true };
  }
  const cur = readConfigFile(target);
  if (!cur.exists) return { text: 'config.toml が存在しません。解除する設定がありません。', isError: true };
  let parsed;
  try {
    parsed = parseToml(cur.text);
  } catch (e) {
    return { text: sanitizeText(`config.toml が不正のため中断しました（自動修復はしません）: ${e.message}`, secrets), isError: true };
  }
  let st = null;
  try { const r = readState(); if (r.exists) st = r.json; } catch (e) {
    return { text: sanitizeText(`state.json が不正のため中断しました: ${e.message}`, secrets), isError: true };
  }
  const arrManagedOff = findArrayManaged(parsed, MANAGED_PROVIDERS);
  if (arrManagedOff.length > 0) {
    return {
      text: sanitizeText(`[[array]] 形式の buchi テーブルがあります（${arrManagedOff.map((a) => `${a.lineNo} 行目`).join('、')}）。本プラグインは [単一] テーブルのみ管理するため自動編集しません。手動で統合してください。`, secrets),
      isError: true,
    };
  }
  const gwHost = st?.gateway_host ?? null;
  const noState = !st;
  const offBroken = findSuspicious(parsed);
  if (offBroken.length > 0) {
    return { text: sanitizeText(`config.toml に不正の疑いがある行があるため中断しました（自動修復はしません）: ${offBroken.map((b) => `${b.lineNo} 行目・${b.reason}`).join('、')}。doctor の D2 を確認し、手動で修正してください。`, secrets), isError: true };
  }
  const removals = [];
  for (const name of MANAGED_PROVIDERS) {
    const t = readTable(parsed, `model_providers.${name}`);
    if (!t?.base_url) continue;
    const sp = splitBaseUrl(t.base_url);
    if (sp) secrets.push(sp.token);
    const host = baseUrlHost(t.base_url);
    if (noState && !force) {
      // state 不在では出所を判定できないため、手動作成の同名テーブルを
      // 「復元」の名目で消さない。force: true で明示的に削除できる。
      removals.push({ name, action: 'skip', reason: 'state.json がないため自動判定しません（手動確認か force: true）' });
    } else if (gwHost && host !== gwHost) {
      removals.push({ name, action: 'skip', reason: `別の接続先 (${host}) のため残します` });
    } else {
      removals.push({ name, action: 'remove', reason: `buchi 管理 (${host ?? '不明'})` });
    }
  }
  const mp = findTopLevel(parsed, 'model_provider');
  const restoreTo = st && 'prev_model_provider' in st ? st.prev_model_provider : null;
  const prevTables = (st && st.prev_tables && typeof st.prev_tables === 'object') ? st.prev_tables : {};
  // state 不在では model_provider の変更前値が不明のため、手を付けない
  //（force: true でのみ削除/復元を行う）。
  const touchModelProvider = !(!st && !force);
  const lines = ['buchi 接続解除（Codex）', `- 対象: ${target}`];
  for (const w of parsed.warnings) lines.push(`- [注意] ${w}`);
  for (const r of removals) {
    if (r.action === 'remove' && prevTables[r.name]) {
      lines.push(`- [model_providers.${r.name}]: 導入前の内容へ復元（setup 時の上書きを戻します）`);
    } else {
      lines.push(`- [model_providers.${r.name}]: ${r.action === 'remove' ? '削除' : `保持（${r.reason}）`}`);
    }
  }
  // buchi テーブルに触れないのに model_provider だけ消す事故を防ぐ:
  // 削除対象テーブルが無く、復元値も無い場合は model_provider に触れない。
  const reallyTouchMp = !!(mp && touchModelProvider && (removals.some((r) => r.action === 'remove') || restoreTo !== null));
  if (reallyTouchMp) {
    lines.push(restoreTo === null
      ? `- model_provider: "${mp.line.value.parsed}" → 削除（導入前は未設定だったため）`
      : `- model_provider: "${mp.line.value.parsed}" → "${restoreTo}"（導入前の値へ復元）`);
  } else if (mp) {
    lines.push(touchModelProvider
      ? `- model_provider: "${mp.line.value.parsed}" → 保持（buchi テーブルが無く復元値も無いため変更しません）`
      : `- model_provider: "${mp.line.value.parsed}" → 保持（state.json がないため変更前の値が不明。force: true で削除できます）`);
  } else {
    lines.push('- model_provider: 未設定（変更なし）');
  }
  if (removals.filter((r) => r.action === 'remove').length === 0 && !reallyTouchMp) {
    lines.push('解除対象がありません（state.json 不在時は force: true で強制解除できます）。');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }
  if (!apply) {
    const planHash = await sha256Hex(`${cur.text}\n${JSON.stringify(removals.map((r) => [r.name, r.action]))}\n${restoreTo}\n${force}\n${reallyTouchMp}`);
    lines.push(`plan: ${planHash}`);
    lines.push('dry-run のため書き込んでいません。同意したら同じ plan 値と共に plan_hash 付き・apply: true で再実行してください。');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }
  const lock = acquireLock(target);
  if (!lock.ok) return { text: sanitizeText(lock.error, secrets), isError: true };
  try {
    const cur2 = readConfigFile(target);
    const h1 = await sha256Hex(cur.text);
    const h2 = await sha256Hex(cur2.text);
    if (h1 !== h2) {
      return { text: sanitizeText('dry-run 後に config.toml が外部変更されました。中止します。', secrets), isError: true };
    }
    if (args?.plan_hash === undefined || args.plan_hash === '') {
      return { text: sanitizeText('apply には dry-run 出力の plan 値（plan_hash）が必須です。先に dry-run を実行し、その plan_hash を付けて再実行してください。', secrets), isError: true };
    }
    {
      const pTmp = parseToml(cur2.text);
      const reRemovals = [];
      for (const name of MANAGED_PROVIDERS) {
        const t = readTable(pTmp, `model_providers.${name}`);
        if (!t?.base_url) continue;
        const host = baseUrlHost(t.base_url);
        if (noState && !force) reRemovals.push([name, 'skip']);
        else if (gwHost && host !== gwHost) reRemovals.push([name, 'skip']);
        else reRemovals.push([name, 'remove']);
      }
      const reMp = findTopLevel(pTmp, 'model_provider');
      const reReally = !!(reMp && touchModelProvider && (reRemovals.some((r) => r[1] === 'remove') || restoreTo !== null));
      const expected = await sha256Hex(`${cur2.text}\n${JSON.stringify(reRemovals)}\n${restoreTo}\n${force}\n${reReally}`);
      if (args.plan_hash !== expected) {
        return { text: sanitizeText('plan_hash が一致しません（dry-run 後にファイルまたは状態が変わりました）。最新の dry-run を取り直してください。', secrets), isError: true };
      }
    }
    const fp1 = statFingerprint(target);
    const p2 = parseToml(cur2.text);
    if (findSuspicious(p2).length > 0) {
      return { text: sanitizeText('config.toml に不正の疑いがある行があるため書き込みません（自動修復はしません）。doctor の D2 を確認し、手動で修正してください。', secrets), isError: true };
    }
    // 対象なしの apply は plan 不要で正常終了（冪等）。判定は再読込後の
    // 現状で再計算する（dry-run 時の古い判定を使わない）。
    {
      const nowRemovals = [];
      for (const name of MANAGED_PROVIDERS) {
        const t = readTable(p2, `model_providers.${name}`);
        if (!t?.base_url) continue;
        const host = baseUrlHost(t.base_url);
        if (noState && !force) nowRemovals.push([name, 'skip']);
        else if (gwHost && host !== gwHost) nowRemovals.push([name, 'skip']);
        else nowRemovals.push([name, 'remove']);
      }
      const nowMp = findTopLevel(p2, 'model_provider');
      const nowReally = !!(nowMp && touchModelProvider && (nowRemovals.some((r) => r[1] === 'remove') || restoreTo !== null));
      if (!nowRemovals.some((r) => r[1] === 'remove') && !nowReally) {
        return { text: sanitizeText([...lines, '変更はありませんでした（既に解除済み・冪等）。'].join('\n'), secrets) };
      }
    }
    for (const r of removals) {
      if (r.action !== 'remove') continue;
      if (prevTables[r.name]) spliceTableRaw(p2, `model_providers.${r.name}`, prevTables[r.name]);
      else deleteTable(p2, `model_providers.${r.name}`);
    }
    if (reallyTouchMp) {
      if (restoreTo === null) deleteTopLevel(p2, 'model_provider');
      else setTopLevel(p2, 'model_provider', restoreTo);
    }
    const newText = serializeToml(p2);
    if (newText === cur2.text) {
      return { text: sanitizeText([...lines, '変更はありませんでした（既に解除済み・冪等）。'].join('\n'), secrets) };
    }
    const fp2 = statFingerprint(target);
    if (JSON.stringify(fp1) !== JSON.stringify(fp2)) {
      return { text: sanitizeText('適用直前に config.toml が外部変更されました。中止します（再実行してください）。', secrets), isError: true };
    }
    const backup = backupFile(target);
    writeFileAtomic(target, newText);
    // 導入前のパーミッションへ戻す（writeFileAtomic は 600 に固定するため）。
    if (st && typeof st.prev_mode === 'number') {
      try { fs.chmodSync(target, st.prev_mode); } catch { /* best-effort */ }
    }
    if (st) {
      st.off_at = new Date().toISOString();
      writeState(st);
    }
    lines.push(`適用しました（バックアップ: ${backup ?? '（なし）'}）。Codex を再起動してください。`);
    return { text: sanitizeText(lines.join('\n'), secrets) };
  } finally {
    releaseLock(lock.lockPath);
  }
}

async function toolOn(args) {
  const secrets = [];
  const apply = args?.apply === true;
  let st = null;
  try {
    const r = readState();
    if (r.exists) st = r.json;
  } catch (e) {
    return { text: sanitizeText(`state.json が不正のため中断しました: ${e.message}`, secrets), isError: true };
  }
  if (!st || !st.auth || !st.provider || (!st.gateway_url && !st.gateway_host)) {
    return { text: '前回の setup 記録（state.json）がありません。初回は buchi_setup を実行してください。', isError: true };
  }
  const { token, from } = inputToken(args);
  if (!token) {
    return { text: 'gateway_token が未設定です（off で設定から除去したため再入力が必要です）。引数 gateway_token か環境変数 BUCHI_GATEWAY_TOKEN で指定してください。', isError: true };
  }
  secrets.push(token);
  const gatewayUrl = st.gateway_url ?? `https://${st.gateway_host}`;
  return toolSetup({ gateway_url: gatewayUrl, gateway_token: token, _tokenFrom: from, auth: st.auth, apply, overwrite: true, plan_hash: args?.plan_hash });
}

async function toolVerify(args) {
  const secrets = [];
  const confirm = args?.confirm === true;
  const lines = ['buchi 通過確認（Codex verify）'];
  const configPath = resolveConfigPath();
  lines.push(`- 設定ファイル: ${configPath}`);

  const cur = readConfigFile(configPath);
  if (!cur.exists) {
    lines.push('- [1/4] 設定済み: [NG] config.toml が存在しません');
    lines.push('結果: 通過未確認');
    return { text: lines.join('\n') };
  }
  let parsed;
  try {
    parsed = parseToml(cur.text);
  } catch (e) {
    lines.push(`- [1/4] 設定済み: [NG] config.toml が不正です: ${e.message}`);
    lines.push('結果: 通過未確認');
    return { text: lines.join('\n') };
  }
  const mp = findTopLevel(parsed, 'model_provider');
  const mpVal = mp ? mp.line.value.parsed : null;
  if (findSuspicious(parsed).length > 0) {
    lines.push('- [1/4] 設定済み: [NG] config.toml に不正の疑いがある行があります（doctor の D2 を確認してください）');
    lines.push('結果: 通過未確認');
    return { text: lines.join('\n') };
  }
  const { provider, baseUrl } = selectManagedProvider(parsed, mpVal);
  const sp = baseUrl ? splitBaseUrl(baseUrl) : null;
  if (!sp) {
    lines.push('- [1/4] 設定済み: [NG] buchi 管理の base_url（/c/<token>/v1 形式）がありません');
    lines.push('結果: 通過未確認');
    return { text: lines.join('\n') };
  }
  secrets.push(sp.token);
  lines.push(`- [1/4] 設定済み: [OK] model_provider=${mpVal ?? '(未設定)'} / [model_providers.${provider}] base_url=${maskUrl(baseUrl)}`);
  if (mpVal !== provider) {
    lines.push(`  [注意] model_provider が "${mpVal}" のため buchi テーブルは有効ではありません。on/setup で切り替えてください。`);
  }

  const h = await healthCheck(sp.gatewayUrl);
  lines.push(`- [2/4] 疎通成功: ${h.ok ? '[OK]' : '[NG]'} ${maskUrl(sp.gatewayUrl)}/healthz → ${describeHealth(h)}`);
  if (!h.ok) {
    lines.push('結果: 通過未確認（疎通に失敗しているため先に doctor/setup を確認してください）');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }

  // [2b] ゲートウェイ受理（プレースホルダ鍵プローブ。通常コスト 0 だが構成依存の例外あり）。
  const probe = await probeResponsesAccept(sp.gatewayUrl, sp.token);
  lines.push(`- [2b/4] ゲートウェイ受理: ${probe.line}`);
  if (!probe.accepted) {
    lines.push('結果: 通過未確認（ゲートウェイがトークンを受理していません。setup の token/url を確認してください）');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }

  if (!confirm) {
    lines.push('- [3/4] 実際の通過: [未実行] 次の手順はモデル要求を 1 回発行します（課金・サブスク消費が発生し得ます）。');
    lines.push('  実行内容: `codex exec` で無害な定型プロンプト（"Reply with exactly: ok"）を 1 回だけ送信し、Codex 自身の rollout 記録から応答 ID を取り出してゲートウェイの観測と突き合わせます。');
    lines.push('  実行するには confirm: true を付けて再実行してください。');
    lines.push('結果: 通過未確認（明示的な実行待ち）');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }

  // [3/4] Codex 本体による実要求 → rollout の response_id → seen-response 照会。
  // 相関の厳密化 (push-gate adversarial 指摘): 別セッションの rollout を拾わないよう、
  // exec 標準出力の session id と一致する rollout だけを候補にする。exec 前から
  // 存在するファイルはセッション一致でのみ許可する（mtime 猶予条項は廃止）。
  lines.push(`- [3/4] 実要求を発行します（プロンプト固定・出力最小・リトライなし）: codex exec "${VERIFY_PROMPT}"`);
  const before = new Map(listRollouts().map((r) => [r.path, r.mtimeMs]));
  const execRes = await runCmd(codexBin(), ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', VERIFY_PROMPT], { timeoutMs: 120000 });
  if (!execRes.ok) {
    lines.push(`- [3/4] 実要求: [NG] codex exec が失敗しました（exit 情報を確認してください）。stderr 末尾: ${(execRes.stderr || '').slice(-300)}`);
    lines.push('結果: 通過未確認');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }
  const sessMatch = /session id:\s*([0-9a-fA-F-]{36})/.exec(`${execRes.stdout || ''}\n${execRes.stderr || ''}`);
  const execSessionId = sessMatch ? sessMatch[1] : null;
  const ourCwd = process.cwd();
  // パス事前絞り込み: inspect（IO が重い）は候補だけに実行する。
  const prefilter = (r) => {
    if (execSessionId && r.path.includes(execSessionId)) return true;
    if (!before.has(r.path)) return true;
    return false;
  };
  const isOurs = (filePath, info) => {
    if (execSessionId && (filePath.includes(execSessionId) || info.sessionIds.includes(execSessionId))) return true;
    if (!execSessionId && !before.has(filePath)) {
      // session id 不明時のフォールバック: 新規ファイルかつ cwd 一致
      // （同時起動の別セッション混入を抑止。cwd 無記録は許容）。
      if (!info.cwd || info.cwd === ourCwd) return true;
    }
    return false;
  };
  let matched = [];
  for (let i = 0; i < 10; i += 1) {
    matched = listRollouts()
      .filter(prefilter)
      .map((c) => ({ c, info: inspectRollout(c.path) }))
      .filter((x) => x.info.responseIds.length > 0 && isOurs(x.c.path, x.info))
      .sort((a, b) => b.c.mtimeMs - a.c.mtimeMs);
    if (matched.length > 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const withIds = matched;
  if (withIds.length === 0) {
    lines.push('- [3/4] 実要求: [注意] codex exec は成功しましたが、応答 ID を含む rollout 記録が見つかりません（CODEX_HOME の不一致、または記録遅延の可能性。しばらくして再実行してください）。');
    lines.push('結果: 通過未確認');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }
  const { c: chosen, info } = withIds[0];
  const usedProvider = info.modelProviderId ?? info.modelProvider ?? '(不明)';
  lines.push(`- [3/4] 実要求: [OK] Codex が応答しました（rollout の provider=${usedProvider}）`);
  if (usedProvider !== provider) {
    lines.push(`  [注意] 実要求のプロバイダが buchi 設定 (${provider}) と異なります。直接接続の疑いがあります。`);
  }
  if (info.responseIds.length === 0) {
    lines.push('- [4/4] 実際の通過: [未確認] rollout から応答 ID を取得できませんでした。');
    lines.push('結果: 通過未確認');
    return { text: sanitizeText(lines.join('\n'), secrets) };
  }
  const respId = info.responseIds[info.responseIds.length - 1];
  const seen = await querySeenResponse(sp.gatewayUrl, sp.token, respId);
  if (seen.ok && seen.seen && usedProvider === provider) {
    lines.push(`- [4/4] 実際の通過: [OK] 通過確認済み（ゲートウェイがこの verify の実要求（新規 codex exec プロセス）の応答 ID を観測。response_id=${respId}）`);
    lines.push('結果: 通過確認済み（稼働中の別セッションは status の反映確認と併せて判断してください）');
    recordLastVerify(true, respId);
  } else if (seen.ok && seen.seen) {
    lines.push(`- [4/4] 実際の通過: [注意] ゲートウェイは応答を観測しましたが、要求プロバイダ (${usedProvider}) が buchi 設定と異なります。`);
    lines.push('結果: 通過未確認（設定の競合を確認してください）');
    recordLastVerify(false, respId);
  } else if (seen.ok && seen.unauthorized) {
    lines.push('- [4/4] 実際の通過: [未確認] 照会時にゲートウェイがトークンを拒否しました（[2b] 通過後の変化。レート制限・日次上限・失効の可能性。doctor で確認してください）。');
    lines.push('結果: 通過未確認');
    recordLastVerify(false, respId);
  } else {
    lines.push(`- [4/4] 実際の通過: [未確認] ゲートウェイがこの Codex 要求を観測していません（直接接続の疑い）。${seen.ok ? '' : `照会エラー: ${seen.error}`}`);
    lines.push('結果: 通過未確認');
    recordLastVerify(false, respId);
  }
  return { text: sanitizeText(lines.join('\n'), secrets) };
}

/**
 * [2b] 受理プローブ: プレースホルダ鍵で POST /v1/responses（コスト 0）。
 * ゲートウェイの 401 (type=unauthorized) と上流の 401 を区別する。
 * Returns { accepted: bool, line }.
 */
async function probeResponsesAccept(gatewayUrl, token) {
  const target = `${String(gatewayUrl).replace(/\/+$/, '')}/c/${token}/v1/responses`;
  const res = await httpPostJson(target,
    { model: 'gpt-5', input: 'buchi gateway probe (ignore)', max_output_tokens: 1 },
    { Authorization: `Bearer ${PLACEHOLDER_KEY}` }, 15000);
  if (!res.ok) return { accepted: false, line: `[NG] プローブ送信に失敗: ${res.error}` };
  // 401 以外の 4xx/5xx はゲートウェイ側の拒否・障害の可能性が高いため、有料の
  // 実要求を発行せず doctor へ誘導する（無駄な exec を出さない。403/404 も含む）。
  if (res.status !== 401 && (res.status === 400 || res.status === 403 || res.status === 404 || res.status === 429 || res.status >= 500)) {
    return { accepted: false, line: `[NG] ゲートウェイ/上流が要求を拒否しました（HTTP ${res.status}）。doctor で確認してください（実要求は発行していません）。` };
  }
  if (res.status === 401) {
    let isGwReject = false;
    try {
      const o = JSON.parse(res.body);
      isGwReject = o?.error?.type === 'unauthorized';
    } catch { /* non-JSON 401: treat as gateway-side */ isGwReject = true; }
    if (isGwReject) return { accepted: false, line: '[NG] ゲートウェイがトークンを拒否しました（invalid gateway token）' };
    return { accepted: true, line: '[OK] ゲートウェイ受理（上流がプレースホルダ鍵を拒否=転送到達。通常コスト 0 ですが構成により課金され得ます）' };
  }
  if (res.status >= 200 && res.status < 300) {
    return { accepted: true, line: '[OK] ゲートウェイ受理（2xx 応答。構成により課金され得ます）' };
  }
  return { accepted: true, line: `[注意] ゲートウェイ受理（HTTP ${res.status}。上流側の応答とみなします。通常はコスト 0 ですが構成により課金され得ます）` };
}

async function querySeenResponse(gatewayUrl, token, respId) {
  if (!RESP_ID_RE.test(respId)) return { ok: false, error: '応答 ID の形式が不正です' };
  const clean = `${String(gatewayUrl).replace(/\/+$/, '')}/c/${token}/_buchi/seen-response?id=${encodeURIComponent(respId)}`;
  const res = await httpGetJson(clean, 10000);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.status === 401) return { ok: true, seen: false, unauthorized: true };
  if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
  try {
    const o = JSON.parse(res.body);
    return { ok: true, seen: o?.seen === true };
  } catch {
    return { ok: false, error: '応答が JSON ではありません' };
  }
}

function recordLastVerify(passed, responseId) {
  try {
    const r = readState();
    const st = (r.exists && r.json && typeof r.json === 'object') ? r.json : {};
    st.last_verify = { at: new Date().toISOString(), passed: !!passed, response_id: responseId };
    writeState(st);
  } catch { /* best-effort; verify 結果の記録失敗は本体結果に影響させない */ }
}

// ---------------------------------------------------------------------------
// MCP stdio dispatch
// ---------------------------------------------------------------------------

const TOOLS = [
  { name: 'buchi_setup', description: 'Codex を buchi AI ゲートウェイへ接続します（差分 dry-run → plan_hash + apply:true で適用）。', inputSchema: { type: 'object', properties: { gateway_url: { type: 'string' }, gateway_token: { type: 'string' }, auth: { type: 'string', enum: ['api', 'subscription'] }, apply: { type: 'boolean' }, overwrite: { type: 'boolean' }, plan_hash: { type: 'string' } }, required: ['gateway_url', 'auth'] } },
  { name: 'buchi_status', description: '現在の接続状態を表示します（設定値・反映状態・healthz 疎通。トークンはマスク表示）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'buchi_doctor', description: '設定・競合・疎通・認証方式を診断します（D1〜D7。トークンは送信しません）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'buchi_off', description: '接続を解除し、setup 前の状態へ復元します（差分 dry-run → apply:true で適用）。state.json 不在時は force:true が必要です。', inputSchema: { type: 'object', properties: { apply: { type: 'boolean' }, force: { type: 'boolean' } } } },
  { name: 'buchi_on', description: '解除後にゲートウェイへ再接続します（setup 済みが前提。plan_hash + apply:true で適用）。', inputSchema: { type: 'object', properties: { gateway_token: { type: 'string' }, apply: { type: 'boolean' }, plan_hash: { type: 'string' } } } },
  { name: 'buchi_verify', description: '実際にゲートウェイを通過しているか確認します（confirm:true で Codex 実要求を 1 回発行=課金し得ます）。', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } },
];

async function dispatch(name, args) {
  switch (name) {
    case 'buchi_setup': return toolSetup(args ?? {});
    case 'buchi_status': return toolStatus();
    case 'buchi_doctor': return toolDoctor();
    case 'buchi_off': return toolOff(args ?? {});
    case 'buchi_on': return toolOn(args ?? {});
    case 'buchi_verify': return toolVerify(args ?? {});
    default: return { text: `未知のツールです: ${name}`, isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin });
let buf = '';
// A broken stdout pipe means our host is gone; exit quietly instead of
// crashing with an unhandled EPIPE (MCP servers are stateless per call).
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
  throw e;
});
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleMessage(msg).catch(() => {});
  }
});

async function handleMessage(msg) {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const id = msg.id;
  try {
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'buchiai-gateway', version: '0.1.0' } } });
    } else if (msg.method === 'notifications/initialized') {
      // no reply
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const out = await dispatch(name, args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  } catch (e) {
    try {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: sanitizeText(`内部エラー: ${e.message}`, []) } });
    } catch { /* last resort */ }
  }
}
