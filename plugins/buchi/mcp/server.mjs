#!/usr/bin/env node
// buchi MCP stdio server — Phase 2 (core implementation).
//
// Zero npm dependencies: only Node builtins, via ./lib.mjs. (Phase 1 avoided
// even builtin imports; Phase 2 requires fs/http for settings IO and healthz.)
//
// Token handling contract (Phase 0 spike + coordinator correction):
//   - PRIMARY / authoritative: explicit `env` mapping in `.mcp.json`
//     (`BUCHI_GATEWAY_TOKEN` <- `${user_config.gateway_token}`). This is the
//     only mechanism empirically confirmed to deliver userConfig values
//     (including sensitive ones) to an MCP stdio subprocess.
//   - FALLBACK (best-effort only, never relied upon): `CLAUDE_PLUGIN_OPTION_*`
//     is read defensively; empirical measurement (spike-v1 09) showed 0 such
//     vars reach MCP subprocesses today.
//
// Secret-safety invariant: the raw token value must never be written to
// stdout, stderr, or any tool response. Every response text passes through
// sanitizeText() as the final step (masks the configured token and any
// residual `/c/<token>` segment), on top of explicit maskToken()/maskUrl()
// calls at each formatting site.
//
// What setup writes (coordinator decision #1):
//   settings.json -> env.ANTHROPIC_BASE_URL = "<gateway_url>/c/<gateway_token>"
//   (no /v1 suffix for Claude; that suffix is for OpenAI-compatible clients).
//   ANTHROPIC_AUTH_TOKEN is NOT written: the current gateway has no Bearer
//   auth. TODO(O-1): revisit when the saas mode contract (tenant subdomain +
//   ANTHROPIC_AUTH_TOKEN=buchi_...) is finalized.

import path from 'node:path';
import {
  maskToken, maskUrl, sanitizeText,
  normalizeGateway, buildBaseUrl, splitBaseUrl,
  resolveSettingsPath, readSettings, writeSettingsAtomic, backupSettings, listBackups,
  acquireLock, releaseLock,
  resolveStateDir, statePath, readState, writeState,
  healthCheck, describeHealth, compareVersions,
  probeMessages, describeProbe,
} from './lib.mjs';

const SERVER_NAME = 'buchi';
const SERVER_VERSION = '0.5.0'; // keep in sync with .claude-plugin/plugin.json
const MANAGED_KEY = 'ANTHROPIC_BASE_URL';
const MIN_CLAUDE_VERSION = '2.1.154'; // D1: userConfig support floor

/** Captured from the initialize request (used by doctor D1). */
let clientInfo = null;

function readConfig(primaryKey, fallbackOptionKey) {
  const primary = process.env[primaryKey];
  if (primary !== undefined && primary !== '') return primary;
  return process.env[fallbackOptionKey];
}

const config = {
  gatewayUrl: readConfig('BUCHI_GATEWAY_URL', 'CLAUDE_PLUGIN_OPTION_GATEWAY_URL'),
  gatewayToken: readConfig('BUCHI_GATEWAY_TOKEN', 'CLAUDE_PLUGIN_OPTION_GATEWAY_TOKEN'),
  mode: readConfig('BUCHI_MODE', 'CLAUDE_PLUGIN_OPTION_MODE'),
  settingsScope: readConfig('BUCHI_SETTINGS_SCOPE', 'CLAUDE_PLUGIN_OPTION_SETTINGS_SCOPE'),
};

// ---------------------------------------------------------------------------
// Known effective tokens (FIX-B)
// ---------------------------------------------------------------------------
// The env-provided gateway_token alone is NOT sufficient for the literal-match
// sweep: in the primary user flow the token often arrives EMBEDDED in
// gateway_url (gateway_token empty), and old/foreign tokens surface from
// settings.json and state.json. Every value we ever parse a token out of is
// registered here, and respondText() sweeps ALL of them.
const knownSecrets = new Set();

function registerSecret(value) {
  // Minimum length guard: sweeping ultra-short strings would corrupt unrelated
  // text; such values are still covered by the unconditional /c/<segment> mask.
  if (typeof value === 'string' && value.length >= 4) knownSecrets.add(value);
}

/** Register the token embedded in any BASE_URL-shaped value. */
function registerFromBaseUrl(value) {
  const split = splitBaseUrl(value);
  if (split) registerSecret(split.token);
}

registerSecret(config.gatewayToken);
registerFromBaseUrl(String(config.gatewayUrl ?? '').trim().replace(/\/+$/, ''));

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    apply: {
      type: 'boolean',
      description: 'true で実際に書き込みます。省略時は dry-run（差分表示のみ・一切書き込まない）。',
    },
  },
};

const TOOLS = [
  {
    name: 'buchi_setup',
    description: 'ぶちゲートウェイ接続をセットアップします。settings.json の env.ANTHROPIC_BASE_URL を書き換えます（既定は dry-run。apply: true で書込）。',
    inputSchema: APPLY_SCHEMA,
  },
  {
    name: 'buchi_off',
    description: 'ぶちゲートウェイ接続を解除し、退避しておいた元の値へ完全復元します（既定は dry-run。apply: true で書込）。',
    inputSchema: APPLY_SCHEMA,
  },
  {
    name: 'buchi_on',
    description: 'ぶちゲートウェイへ再接続します（過去に buchi_setup 実行済みであることが前提。既定は dry-run。apply: true で書込）。',
    inputSchema: APPLY_SCHEMA,
  },
  {
    name: 'buchi_status',
    description: '現在の接続状態を表示します（設定値・反映状態・healthz 疎通。トークンはマスク表示）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'buchi_doctor',
    description: '接続診断 D1〜D7 を実行します（バージョン・JSON 妥当性・env 競合・疎通・既知の制約）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'buchi_verify',
    description: '無害なテスト要求（max_tokens=1 の "ping"）を送り、「設定済み」「疎通成功」「実際にゲートウェイを通過した」を区別して確認します。既定はプレースホルダ鍵で送るためコスト 0（上流は認証エラーを返す）。full: true で現プロセス env の ANTHROPIC_API_KEY を使い上流応答まで確認します（出力 1 トークン分の課金）。',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: '現プロセス env の ANTHROPIC_API_KEY で実際に上流まで往復する（既定 false）' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Every tool response goes through here: final sanitize sweep, then send. */
function respondText(id, text, isError = false) {
  // FIX-B: sweep every known effective token (env-provided AND extracted from
  // URLs/settings/state), not just the env-provided one.
  const safe = sanitizeText(text, knownSecrets);
  const result = { content: [{ type: 'text', text: safe }] };
  if (isError) result.isError = true;
  send({ jsonrpc: '2.0', id, result });
}

function getEnvKey(settingsJson) {
  const env = settingsJson.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) return env[MANAGED_KEY];
  return undefined;
}

// ---------------------------------------------------------------------------
// State layout v2 (FIX-C): stash keyed by canonical settings path
// ---------------------------------------------------------------------------
// v1 kept a single plugin-global {saved, last_applied}, so a setup in project A
// followed by a setup in project B stashed nothing for B, and an off in B
// would "restore" A's value into B — breaking the full-restore promise.
// v2 keys every stash/last_applied by path.resolve(settingsPath).

function newState() {
  return { version: 2, managed_keys: [`env.${MANAGED_KEY}`], targets: {} };
}

/** Canonical per-target key. */
function targetKeyFor(settingsPath) {
  return path.resolve(settingsPath);
}

/** Migrate any prior state layout to v2. fallbackPath keys orphan v1 data. */
function migrateState(json, fallbackPath) {
  if (!json) return newState();
  if (json.version === 2 && json.targets && typeof json.targets === 'object') return json;
  const st = newState();
  const hadData = (json.saved && Object.keys(json.saved).length > 0) || json.last_applied;
  if (hadData) {
    // v1 recorded the path it was applied to in last_applied.settings_path;
    // fall back to the currently-targeted path for stash-only v1 states.
    const key = targetKeyFor((json.last_applied && json.last_applied.settings_path) || fallbackPath);
    st.targets[key] = { saved: json.saved || {}, last_applied: json.last_applied || null };
  }
  return st;
}

/** Get (or lazily create) the per-settings-path slice of the state. */
function targetSlice(st, settingsPath) {
  const key = targetKeyFor(settingsPath);
  if (!st.targets[key]) st.targets[key] = { saved: {}, last_applied: null };
  return st.targets[key];
}

/** Common precondition block for setup/on. Returns { error } or context. */
function prepareSetupContext() {
  // Error paths first.
  if (config.mode === 'saas') {
    // TODO(O-1): saas モード（テナントサブドメイン + ANTHROPIC_AUTH_TOKEN）は
    // 実ゲートウェイ側で未提供。v1 は byok（パスベース認証）のみ実装対象。
    return { error: 'saas モードは現在未提供です（O-1 確定待ち）。/plugin から mode を byok に変更してください。' };
  }
  if (config.mode && config.mode !== 'byok') {
    return { error: `mode の値が不正です: "${config.mode}"。有効な値は byok / saas です（/plugin から設定）。` };
  }
  const norm = normalizeGateway(config.gatewayUrl, config.gatewayToken);
  if (!norm.ok) return { error: norm.error, warnings: norm.warnings };
  registerSecret(norm.token); // FIX-B: effective token (may originate from the URL)
  let settingsPath;
  try {
    settingsPath = resolveSettingsPath(config.settingsScope); // FIX-D: throws on invalid scope
  } catch (err) {
    return { error: err.message };
  }
  let settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    if (err.code === 'EINVALIDJSON') {
      return { error: `${settingsPath} を書き換えずに中断しました: ${err.message}\n手動で JSON を修復してから再実行してください（バックアップ: ${listBackups(settingsPath).slice(0, 3).join(', ') || 'なし'}）。` };
    }
    throw err;
  }
  let state;
  try {
    state = readState();
  } catch (err) {
    return { error: `退避ファイルが壊れています: ${err.message}\n場所: ${statePath()}。内容を確認・修復してから再実行してください。` };
  }
  return { norm, settingsPath, settings, state };
}

/**
 * setup / on shared core.
 * Sequence on apply (crash-safe ordering):
 *   lock -> backup -> state write #1 (stash old value) -> settings atomic write
 *        -> state write #2 (record last_applied) -> unlock -> healthz probe.
 */
async function runSetup(args, { viaOn = false } = {}) {
  const ctx = prepareSetupContext();
  if (ctx.error) {
    const w = (ctx.warnings || []).map((s) => `注意: ${s}`).join('\n');
    return { text: w ? `${w}\n${ctx.error}` : ctx.error, isError: true };
  }
  const { norm, settingsPath, settings, state } = ctx;
  const apply = args && args.apply === true;
  const lines = [];
  const warnings = [...norm.warnings];

  // FIX-C: all stash bookkeeping is per-settings-path.
  const st = migrateState(state.json, settingsPath);
  const tgt = targetSlice(st, settingsPath);

  if (viaOn) {
    if (!tgt.last_applied && !tgt.saved[MANAGED_KEY]) {
      return {
        text: 'この設定ファイルに対する初回セットアップが未実施です（退避情報が見つかりません）。buchi_setup を実行してください。',
        isError: true,
      };
    }
  }

  const current = getEnvKey(settings.json);
  registerFromBaseUrl(current); // FIX-B
  registerFromBaseUrl(process.env[MANAGED_KEY]);
  const newBase = buildBaseUrl(norm.url, norm.token);

  // Idempotency (W: 冪等性): same value -> normal exit, no writes.
  if (current === newBase) {
    const h = await healthCheck(norm.url);
    return {
      text: [
        `変更なし: env.${MANAGED_KEY} は既に目的の値です（${maskUrl(newBase)}）。`,
        `healthz: ${describeHealth(h)}`,
      ].join('\n'),
      isError: false,
    };
  }

  // Conflict / foreign-value warnings (design §6.1 競合検知・既存値の保護).
  const currentIsOurs = !!(tgt.last_applied && tgt.last_applied.base_url === current);
  const hasStash = !!tgt.saved[MANAGED_KEY];
  if (current !== undefined && !currentIsOurs) {
    warnings.push(hasStash
      ? `既存の env.${MANAGED_KEY}（${maskUrl(current)}）を上書きします。復元用の退避値は初回セットアップ時のものを維持します（直前の値は settings.json のバックアップから回収可能です）。`
      : `既存の env.${MANAGED_KEY}（${maskUrl(current)}）が設定済みです。上書き前に旧値を state.json へ退避します。`);
  }
  const procEnv = process.env[MANAGED_KEY];
  if (procEnv !== undefined && procEnv !== newBase) {
    warnings.push(`現在のプロセス環境に ${MANAGED_KEY} が存在します（シェルの export 等）。settings.json の値が優先されますが、混乱を避けるため export の削除を推奨します。`);
  }

  lines.push(viaOn ? 'buchi_on（buchi_setup 再実行相当）' : 'buchi_setup');
  lines.push(`対象: ${settingsPath}（scope: ${config.settingsScope || 'user'}）`);
  lines.push('差分:');
  lines.push(`  env.${MANAGED_KEY}: ${current === undefined ? '(未設定)' : maskUrl(current)} → ${maskUrl(newBase)}`);
  for (const w of warnings) lines.push(`注意: ${w}`);

  if (!apply) {
    lines.unshift('[DRY-RUN] まだ何も書き込んでいません。');
    lines.push('適用するには apply: true を指定して再実行してください。');
    return { text: lines.join('\n'), isError: false };
  }

  // ---- apply ----
  const lock = acquireLock(settingsPath);
  if (!lock.ok) return { text: lock.error, isError: true };
  if (lock.warning) lines.push(`注意: ${lock.warning}`);
  let backupPath = null;
  try {
    backupPath = backupSettings(settingsPath);
    // Stash the pre-buchi value (W4). An existing stash is NEVER overwritten
    // (not by our own writes, not by externally drifted values): the stash must
    // keep pointing at the true pre-buchi original until buchi_off clears it,
    // otherwise off could "restore" an intermediate drifted value. Drifted
    // values remain recoverable from the settings.json backups (W3).
    if (!hasStash) {
      tgt.saved[MANAGED_KEY] = {
        had_value: current !== undefined,
        old_value: current === undefined ? null : current,
        saved_at: new Date().toISOString(),
      };
    }
    writeState(st); // state write #1 (before touching settings)

    const nextSettings = { ...settings.json };
    nextSettings.env = { ...(settings.json.env || {}), [MANAGED_KEY]: newBase };
    writeSettingsAtomic(settingsPath, nextSettings);

    tgt.last_applied = { base_url: newBase, applied_at: new Date().toISOString(), settings_path: settingsPath };
    writeState(st); // state write #2
  } catch (err) {
    return { text: `書き込み中にエラーが発生しました（settings.json は tmp→rename 方式のため中途半端な状態にはなりません）: ${err.message}`, isError: true };
  } finally {
    releaseLock(lock.lockPath);
  }

  lines.push(`適用しました: env.${MANAGED_KEY} を更新（chmod 600 / アトミック書込）。`);
  lines.push(`バックアップ: ${backupPath || '(元ファイルなし・新規作成のためバックアップなし)'}`);
  lines.push(`旧値の退避先: ${statePath()}`);

  // Post-write connectivity check: NG keeps the setting, warn only (design 異常系).
  const h = await healthCheck(norm.url);
  lines.push(`healthz: ${describeHealth(h)}`);
  if (!h.ok) lines.push('注意: 疎通に失敗しましたが設定は残しています。復旧しない場合は buchi_off で元に戻せます。');
  lines.push('反映には Claude Code の再起動が必要です。');
  return { text: lines.join('\n'), isError: false };
}

/**
 * buchi_off: restore the stashed original value (delete the key if it was
 * originally unset). Never requires gateway config to be valid — off must work
 * even when the user has since broken/cleared their plugin settings.
 */
async function runOff(args) {
  const apply = args && args.apply === true;
  let settingsPath;
  try {
    settingsPath = resolveSettingsPath(config.settingsScope); // FIX-D
  } catch (err) {
    return { text: err.message, isError: true };
  }
  let settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    if (err.code === 'EINVALIDJSON') {
      const backups = listBackups(settingsPath).slice(0, 3);
      return {
        text: [
          `${settingsPath} が不正な JSON のため書き換えずに中断しました: ${err.message}`,
          backups.length
            ? `バックアップからの手動復元を検討してください（新しい順）:\n${backups.map((b) => `  cp "${b}" "${settingsPath}"`).join('\n')}`
            : 'バックアップは見つかりませんでした。手動で JSON を修復してください。',
        ].join('\n'),
        isError: true,
      };
    }
    throw err;
  }

  let state;
  try {
    state = readState();
  } catch (err) {
    return { text: `退避ファイルが壊れています: ${err.message}\n場所: ${statePath()}`, isError: true };
  }
  // FIX-C: restore strictly from THIS settings path's stash — never from
  // another project's/scope's entry.
  const st = migrateState(state.json, settingsPath);
  const tgt = targetSlice(st, settingsPath);
  const saved = tgt.saved[MANAGED_KEY];
  if (!saved) {
    const backups = listBackups(settingsPath).slice(0, 3);
    return {
      text: [
        `この設定ファイル（${settingsPath}）に対する退避情報が見つかりません: ${statePath()}`,
        backups.length
          ? `settings.json のバックアップからの復元を提案します（新しい順）:\n${backups.map((b) => `  cp "${b}" "${settingsPath}"`).join('\n')}`
          : 'バックアップも見つかりません。settings.json の env.ANTHROPIC_BASE_URL を手動で確認してください。',
      ].join('\n'),
      isError: true,
    };
  }

  const current = getEnvKey(settings.json);
  registerFromBaseUrl(current); // FIX-B
  registerFromBaseUrl(saved.old_value);
  registerFromBaseUrl(tgt.last_applied && tgt.last_applied.base_url);
  const targetDesc = saved.had_value ? maskUrl(saved.old_value) : '(キー削除)';
  const alreadyRestored = saved.had_value ? current === saved.old_value : current === undefined;

  const lines = ['buchi_off', `対象: ${settingsPath}`];
  lines.push('差分:');
  lines.push(`  env.${MANAGED_KEY}: ${current === undefined ? '(未設定)' : maskUrl(current)} → ${targetDesc}`);

  if (alreadyRestored && !apply) {
    return { text: `変更なし: env.${MANAGED_KEY} は既に復元済みの状態です。退避情報の掃除には apply: true を指定してください。`, isError: false };
  }
  if (!apply) {
    lines.unshift('[DRY-RUN] まだ何も書き込んでいません。');
    lines.push('適用するには apply: true を指定して再実行してください。');
    return { text: lines.join('\n'), isError: false };
  }

  const lock = acquireLock(settingsPath);
  if (!lock.ok) return { text: lock.error, isError: true };
  if (lock.warning) lines.push(`注意: ${lock.warning}`);
  try {
    if (!alreadyRestored) {
      backupSettings(settingsPath);
      const nextSettings = { ...settings.json };
      const env = { ...(nextSettings.env || {}) };
      if (saved.had_value) env[MANAGED_KEY] = saved.old_value;
      else delete env[MANAGED_KEY];
      nextSettings.env = env; // keep the env object (non-destructive bias) even if empty
      writeSettingsAtomic(settingsPath, nextSettings);
    }
    delete tgt.saved[MANAGED_KEY];
    tgt.last_applied = null;
    if (Object.keys(tgt.saved).length === 0) delete st.targets[targetKeyFor(settingsPath)];
    writeState(st);
  } catch (err) {
    return { text: `復元中にエラーが発生しました: ${err.message}`, isError: true };
  } finally {
    releaseLock(lock.lockPath);
  }

  lines.push(alreadyRestored ? '設定は既に復元済みだったため、退避情報のみ削除しました。' : '復元しました（アトミック書込 / chmod 600 / 事前バックアップ作成済み）。');
  lines.push('反映には Claude Code の再起動が必要です。');
  return { text: lines.join('\n'), isError: false };
}

// ---------------------------------------------------------------------------
// status (design §6.4: config keys, restart-pending divergence, healthz)
// ---------------------------------------------------------------------------

/** Best-effort gateway root for healthz: config first, else derive from a BASE_URL. */
function healthTarget(settingsValue) {
  const raw = String(config.gatewayUrl ?? '').trim().replace(/\/+$/, '');
  if (raw !== '') {
    const m = raw.match(/^(.*?)\/c\/[^/]+(\/v1)?$/);
    return m ? m[1].replace(/\/+$/, '') : raw;
  }
  const split = splitBaseUrl(settingsValue);
  return split ? split.gatewayUrl : null;
}

/**
 * Classify settings-vs-process-env divergence. From inside an MCP subprocess we
 * cannot fully distinguish "restart pending" from "shell export overriding":
 * report both honestly (design D3 wording: settings.json が優先される).
 */
function reflectionStatus(settingsValue, procValue) {
  if (settingsValue !== undefined && procValue === undefined) {
    return '[注意] 乖離: settings.json の値がプロセス環境に未反映です（再起動待ち）。Claude Code を再起動してください。';
  }
  if (settingsValue !== undefined && procValue !== undefined) {
    if (settingsValue === procValue) return '[OK] 一致: 設定はプロセス環境へ反映済みです。';
    return '[注意] 乖離: プロセス環境の値が settings.json と異なります（再起動待ち、またはシェルの export 残存。settings.json が優先されます）。';
  }
  if (settingsValue === undefined && procValue !== undefined) {
    return `[注意] settings.json は未設定ですが、プロセス環境に ${MANAGED_KEY} が存在します（シェルの export 等）。`;
  }
  return '[OK] 未接続: settings.json・プロセス環境とも未設定です。';
}

async function runStatus() {
  let settingsPath;
  try {
    settingsPath = resolveSettingsPath(config.settingsScope); // FIX-D
  } catch (err) {
    return { text: err.message, isError: true };
  }
  const lines = ['buchi 状態', `- 設定ファイル: ${settingsPath}（scope: ${config.settingsScope || 'user'}）`];

  let settingsValue;
  let settingsReadable = true;
  try {
    const settings = readSettings(settingsPath);
    settingsValue = getEnvKey(settings.json);
    registerFromBaseUrl(settingsValue); // FIX-B
    if (!settings.exists) lines.push('- settings.json: (ファイルなし)');
  } catch (err) {
    settingsReadable = false;
    lines.push(`- [NG] settings.json が不正な JSON です: ${err.message}（buchi_doctor / 手動修復を推奨）`);
  }

  let managedNote = '';
  try {
    const state = readState();
    const st = migrateState(state.json, settingsPath);
    const tgt = st.targets[targetKeyFor(settingsPath)]; // FIX-C: this path's slice only
    if (settingsReadable && settingsValue !== undefined) {
      const ours = !!(tgt && tgt.last_applied && tgt.last_applied.base_url === settingsValue);
      managedNote = ours ? '（buchi が設定した値）' : '（buchi 管理外の値の可能性）';
    }
    const saved = tgt && tgt.saved && tgt.saved[MANAGED_KEY];
    if (saved) registerFromBaseUrl(saved.old_value); // FIX-B
    lines.push(saved
      ? `- 退避情報: あり（${saved.saved_at} 時点の旧値を保持 / ${statePath()}）`
      : '- 退避情報: なし');
  } catch (err) {
    lines.push(`- [注意] 退避ファイルが読めません: ${err.message}`);
  }

  if (settingsReadable) {
    lines.splice(2, 0, `- env.${MANAGED_KEY}: ${settingsValue === undefined ? '(未設定)' : maskUrl(settingsValue)} ${managedNote}`.trimEnd());
  }
  const procValue = process.env[MANAGED_KEY];
  registerFromBaseUrl(procValue); // FIX-B
  lines.push(`- 現プロセス env: ${procValue === undefined ? '(未設定)' : maskUrl(procValue)}`);
  if (settingsReadable) lines.push(`- 反映状態: ${reflectionStatus(settingsValue, procValue)}`);

  const target = healthTarget(settingsValue);
  if (target) {
    const h = await healthCheck(target);
    lines.push(`- healthz (${maskUrl(target)}/healthz): ${describeHealth(h)}`);
  } else {
    lines.push('- healthz: スキップ（gateway_url 未設定かつ BASE_URL からも導出不可）');
  }
  return { text: lines.join('\n'), isError: false };
}

// ---------------------------------------------------------------------------
// verify: 設定済み / 疎通成功 / 実際の通過確認 を分けて報告する
// ---------------------------------------------------------------------------
// status は「settings.json に URL がある」「healthz が 200」までしか示せない。稼働中の
// Claude Code がその設定を使っているか、ゲートウェイがトークンを受理して転送して
// いるかは別問題なので、本ツールは (1) 設定 (2) 疎通 (3a) 稼働セッションの env
// (3b) /v1/messages プローブ、の順に判定し、各段を独立に OK/NG 表示する。
// (3b) は稼働セッションの env 値を優先して叩く(= 実際に使われている経路を検証)。

async function runVerify(args) {
  let settingsPath;
  try {
    settingsPath = resolveSettingsPath(config.settingsScope); // FIX-D
  } catch (err) {
    return { text: err.message, isError: true };
  }
  const full = !!(args && args.full === true);
  const lines = ['buchi 通過確認（verify）', `- 設定ファイル: ${settingsPath}（scope: ${config.settingsScope || 'user'}）`];

  // [1/3] 設定済み
  let settingsValue;
  let settingsReadable = true;
  try {
    const settings = readSettings(settingsPath);
    settingsValue = getEnvKey(settings.json);
    registerFromBaseUrl(settingsValue); // FIX-B
  } catch (err) {
    settingsReadable = false;
    lines.push(`[1/3] 設定済み: [NG] settings.json が不正な JSON です: ${err.message}（buchi_doctor を推奨）`);
  }
  if (!settingsReadable) {
    // 既に NG 行を出した。二重に「未設定」と出さない。
  } else if (settingsValue === undefined) {
    lines.push(`[1/3] 設定済み: [NG] env.${MANAGED_KEY} が未設定です（/buchi:setup を実行してください）`);
  } else if (!splitBaseUrl(settingsValue)) {
    lines.push(`[1/3] 設定済み: [注意] env.${MANAGED_KEY} = ${maskUrl(settingsValue)} は /c/<token> 形式ではありません（buchi 管理外の値）`);
  } else {
    lines.push(`[1/3] 設定済み: [OK] env.${MANAGED_KEY} = ${maskUrl(settingsValue)}`);
  }

  // [2/3] 疎通成功（healthz）
  const target = healthTarget(settingsValue);
  if (target) {
    const h = await healthCheck(target);
    lines.push(`[2/3] 疎通成功: ${h.ok ? '[OK]' : '[NG]'} ${maskUrl(target)}/healthz → ${describeHealth(h)}`);
  } else {
    lines.push('[2/3] 疎通成功: [NG] スキップ（gateway_url 未設定かつ BASE_URL からも導出不可）');
  }

  // [3/3] 実際の通過確認
  const procValue = process.env[MANAGED_KEY];
  registerFromBaseUrl(procValue); // FIX-B
  if (procValue === undefined) {
    lines.push(`[3/3a] 稼働セッション: [NG] 現プロセス env に ${MANAGED_KEY} がありません（設定はあっても、この Claude Code セッションはゲートウェイを使っていません。再起動してください）`);
  } else if (settingsValue !== undefined && procValue !== settingsValue) {
    lines.push(`[3/3a] 稼働セッション: [注意] 現プロセス env (${maskUrl(procValue)}) が settings.json と異なります（再起動待ち、またはシェルの export 残存）。以下のプローブは現プロセス env の値で行います`);
  } else {
    lines.push(`[3/3a] 稼働セッション: [OK] 現プロセス env = ${maskUrl(procValue)}`);
  }
  const probeTarget = procValue !== undefined ? procValue : settingsValue;
  if (probeTarget === undefined || !splitBaseUrl(probeTarget)) {
    lines.push('[3/3b] プローブ: [NG] スキップ（/c/<token> 形式の BASE_URL がありません）');
    lines.push('結果: 通過未確認');
    return { text: lines.join('\n'), isError: false };
  }
  const apiKey = full ? process.env.ANTHROPIC_API_KEY : undefined;
  // 上流/中間プロキシがリクエストヘッダを echo する実装でも鍵が応答文に載らないよう、
  // 既知シークレット集合に登録して最終 sanitize sweep の対象にする。
  if (apiKey) registerSecret(apiKey);
  if (full && !apiKey) {
    lines.push('[3/3b] プローブ: [注意] full: true ですが現プロセス env に ANTHROPIC_API_KEY が無いため、プレースホルダ鍵で送ります（サブスク/OAuth 利用時はこれが正常です）');
  }
  const p = await probeMessages(probeTarget, { apiKey });
  lines.push(`[3/3b] プローブ: POST ${maskUrl(probeTarget)}/v1/messages（max_tokens=1, "ping"${apiKey ? '、env の API キー使用' : '、プレースホルダ鍵・コスト 0'}） → ${describeProbe(p)}`);
  const passed = !!p.passed;
  const configured = settingsReadable && settingsValue !== undefined;
  const sessionOk = procValue !== undefined && (!configured || procValue === settingsValue);
  if (passed && sessionOk && configured) lines.push('結果: 実際の通過確認済み（この Claude Code セッションの要求はゲートウェイを通過しています）');
  else if (passed && sessionOk) lines.push('結果: 実際の通過確認済み（ただし settings.json は未設定/不正で、シェルの export 等の env のみで接続しています。恒久化するには /buchi:setup を実行してください）');
  else if (passed) lines.push('結果: ゲートウェイは通過可能ですが、稼働セッションの設定が未反映/相違です。Claude Code を再起動してから再確認してください');
  else lines.push('結果: 通過未確認（上の [NG] 行を確認してください）');
  return { text: lines.join('\n'), isError: false };
}

// ---------------------------------------------------------------------------
// doctor (design §6.5 D1-D7; D6/D7 are ALWAYS displayed)
// ---------------------------------------------------------------------------

async function runDoctor() {
  const lines = ['buchi 診断（D1〜D7）'];

  // D1: Claude Code version (from initialize clientInfo; userConfig floor 2.1.154)
  if (clientInfo && clientInfo.version) {
    const ok = compareVersions(clientInfo.version, MIN_CLAUDE_VERSION) >= 0;
    lines.push(ok
      ? `D1 [OK] Claude Code バージョン: ${clientInfo.version}（>= ${MIN_CLAUDE_VERSION}）`
      : `D1 [NG] Claude Code バージョン: ${clientInfo.version} は ${MIN_CLAUDE_VERSION} 未満のため userConfig 非対応です。アップデートしてください。`);
  } else {
    lines.push('D1 [注意] Claude Code バージョンを取得できませんでした（initialize の clientInfo なし）。判定をスキップします。');
  }

  // D2: settings.json JSON validity
  let settingsPath;
  try {
    settingsPath = resolveSettingsPath(config.settingsScope); // FIX-D
  } catch (err) {
    return { text: `buchi 診断を中断しました: ${err.message}`, isError: true };
  }
  let settingsValue;
  try {
    const settings = readSettings(settingsPath);
    settingsValue = getEnvKey(settings.json);
    registerFromBaseUrl(settingsValue); // FIX-B
    registerFromBaseUrl(process.env[MANAGED_KEY]);
    lines.push(settings.exists
      ? `D2 [OK] settings.json は妥当な JSON です（${settingsPath}）`
      : `D2 [OK] settings.json は未作成です（${settingsPath}。setup 時に作成されます）`);
  } catch (err) {
    lines.push(`D2 [NG] settings.json が破損しています（手編集による破損を検知）: ${err.message}\n     バックアップ: ${listBackups(settingsPath).slice(0, 3).join(', ') || 'なし'}`);
  }

  // D3: shell env conflict
  const procValue = process.env[MANAGED_KEY];
  if (procValue !== undefined && settingsValue !== undefined && procValue !== settingsValue) {
    lines.push(`D3 [注意] プロセス環境の ${MANAGED_KEY} が settings.json と異なります。シェル rc（.zshrc 等）の export が残っている可能性があります（settings.json が優先されます）。再起動直後も乖離する場合は export を削除してください。`);
  } else if (procValue !== undefined && settingsValue === undefined) {
    lines.push(`D3 [注意] settings.json は未設定ですが、シェル環境に ${MANAGED_KEY} の export が存在します（${maskUrl(procValue)}）。`);
  } else {
    lines.push('D3 [OK] シェル env との競合はありません。');
  }

  // D4: /healthz connectivity with DNS/TLS/proxy triage
  const target = healthTarget(settingsValue);
  if (target) {
    const h = await healthCheck(target);
    lines.push(`D4 ${h.ok ? '[OK]' : '[NG]'} healthz (${maskUrl(target)}/healthz): ${describeHealth(h)}`);
    const proxies = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']
      .filter((k) => process.env[k] !== undefined && process.env[k] !== '');
    if (proxies.length > 0) {
      // Values are intentionally not shown (proxy URLs may embed credentials).
      lines.push(`     プロキシ環境変数が設定されています: ${proxies.join(', ')}（値は表示しません）。疎通 NG の場合は NO_PROXY の対象を確認してください。`);
    }
  } else {
    lines.push('D4 [注意] healthz: スキップ（gateway_url 未設定かつ BASE_URL からも導出不可）。');
  }

  // D5: token validity — doctor 自体はトークンを送信しない方針を維持し、実際の
  // 受理/転送の確認は buchi_verify（/v1/messages へのコスト 0 プローブ）に委ねる。
  lines.push('D5 [注意] トークン有効性: doctor では未検証です（doctor はトークンを送信しません）。/buchi:verify で「設定済み / 疎通 / 実際の通過」を分けて確認できます。');

  // D6: ALWAYS — Remote Control incompatibility (#230)
  lines.push('D6 [注意] Remote Control 非互換（#230）: BASE_URL 変更中は claude.ai からのセッション起動・Slack 連携・定期実行が動作しません。');

  // D7: ALWAYS — honest cost expectation for subscription (OAuth) users
  lines.push('D7 [情報] コスト効果の期待値: サブスク（OAuth）利用時は圧縮による金銭的削減はありません。目的は DLP と可視化です。');

  return { text: lines.join('\n'), isError: false };
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function handleToolCall(name, args, id) {
  const known = TOOLS.some((t) => t.name === name);
  if (!known) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } });
    return;
  }
  let out;
  try {
    if (name === 'buchi_setup') out = await runSetup(args);
    else if (name === 'buchi_on') out = await runSetup(args, { viaOn: true });
    else if (name === 'buchi_off') out = await runOff(args);
    else if (name === 'buchi_status') out = await runStatus();
    else if (name === 'buchi_verify') out = await runVerify(args);
    else out = await runDoctor();
  } catch (err) {
    out = { text: `内部エラー: ${err && err.message ? err.message : String(err)}`, isError: true };
  }
  respondText(id, out.text, out.isError);
}

// Serialize tool calls: settings.json mutations must never interleave.
let queue = Promise.resolve();

function handle(msg) {
  if (msg.method === 'initialize') {
    clientInfo = (msg.params && msg.params.clientInfo) || null;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    queue = queue.then(() => handleToolCall(name, args, msg.id)).catch((err) => {
      respondText(msg.id, `内部エラー: ${err && err.message ? err.message : String(err)}`, true);
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => {
  // Let any in-flight (queued) tool call finish before exiting.
  queue.finally(() => process.exit(0));
});
