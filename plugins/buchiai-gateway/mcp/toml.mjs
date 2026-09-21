// Conservative TOML reader/writer for Codex config.toml (#2062).
// Zero npm dependencies. Design rules:
//   - comments, blank lines, key order, and quoting style are ALWAYS preserved;
//     we only splice the exact lines we manage.
//   - top-level scalar keys MUST precede the first [table] header (Codex
//     silently ignores misplaced top-level keys). setTopLevel inserts there.
//   - anything we do not understand ([[arrays]], dotted keys, multiline
//     values) is kept byte-for-byte as `other` lines; managed operations
//     abort on ambiguity (duplicates) instead of guessing.
//   - values we read are scalars only (string/int/float/bool). Anything else
//     is exposed as raw text and never rewritten by us.

/**
 * Parse TOML text into { lines, warnings }.
 * Line: { kind: 'blank'|'comment'|'section'|'keyval'|'other',
 *         text, section, key, value, raw, comment }
 * Throws Error(code 'EINVALIDTOML') on structural problems we refuse to touch:
 * duplicate section headers or duplicate top-level keys.
 */
export function parseToml(text) {
  const src = String(text ?? '');
  // A NUL byte or truly binary content is out of scope: refuse, don't mangle.
  if (src.includes('\u0000')) {
    const e = new Error('config.toml に NUL バイトが含まれています（バイナリの疑い）。自動編集はしません。');
    e.code = 'EINVALIDTOML';
    throw e;
  }
  const rawLines = src.split('\n');
  // Drop the single trailing empty element produced by a final newline so that
  // serialize() round-trips byte-for-byte.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = [];
  const warnings = [];
  let section = '';
  const seenSections = new Set();
  const seenTopKeys = new Set();
  rawLines.forEach((text, idx) => {
    const lineNo = idx + 1;
    const trimmed = text.trim();
    if (trimmed === '') { lines.push({ kind: 'blank', text, section, lineNo }); return; }
    if (trimmed.startsWith('#')) { lines.push({ kind: 'comment', text, section, lineNo }); return; }
    const sec = parseSectionHeader(trimmed);
    if (sec) {
      section = sec.name;
      if (seenSections.has(section)) {
        const e = new Error(`config.toml に重複したテーブルがあります: [${section}]（${lineNo} 行目）。自動編集はしません。手動で統合してください。`);
        e.code = 'EINVALIDTOML';
        throw e;
      }
      seenSections.add(section);
      lines.push({ kind: 'section', text, section, lineNo, array: sec.array });
      return;
    }
    const kv = splitKeyValue(text);
    if (kv) {
      const { key, value, comment } = kv;
      if (section === '' && seenTopKeys.has(key)) {
        const e = new Error(`config.toml に重複したトップレベルキーがあります: ${key}（${lineNo} 行目）。自動編集はしません。`);
        e.code = 'EINVALIDTOML';
        throw e;
      }
      if (section === '') seenTopKeys.add(key);
      lines.push({ kind: 'keyval', text, section, key, value, raw: value.raw, comment, lineNo });
      return;
    }
    warnings.push(`${lineNo} 行目を未解釈のまま保持します（編集対象外）: ${trimmed.slice(0, 60)}`);
    lines.push({ kind: 'other', text, section, lineNo });
  });
  return { lines, warnings };
}

/**
 * Split a `key = value [# comment]` line. Returns null when not a keyval line
 * (handles quoted keys minimally: "a b" = 1 / 'a' = 1).
 * value: { raw, parsed } where parsed is string|number|boolean|null(raw type).
 */
export function splitKeyValue(text) {
  // Strip inline comment: first '#' outside quotes.
  let inStr = null; let esc = false; let cut = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\' && inStr === '"') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '#') { cut = i; break; }
    // '=' ends the key part only when outside quotes; handled below.
  }
  const head = (cut >= 0 ? text.slice(0, cut) : text);
  const comment = (cut >= 0 ? text.slice(cut) : '');
  const eq = head.indexOf('=');
  if (eq < 0) return null;
  const rawKey = head.slice(0, eq).trim();
  const rawVal = head.slice(eq + 1).trim();
  if (rawKey === '' || rawVal === '') return null;
  // Dotted keys and [[arrays]] are out of scope for managed edits.
  if (rawKey.includes('.')) return null;
  const key = unquoteKey(rawKey);
  if (key === null) return null;
  return { key, value: parseScalar(rawVal), comment };
}

function unquoteKey(rawKey) {
  if ((rawKey.startsWith('"') && rawKey.endsWith('"') && rawKey.length >= 2) ||
      (rawKey.startsWith("'") && rawKey.endsWith("'") && rawKey.length >= 2)) {
    return rawKey.slice(1, -1);
  }
  if (/^[A-Za-z0-9_-]+$/.test(rawKey)) return rawKey;
  return null;
}

/**
 * Parse a section header line. Returns { name, array } or null.
 * Handles quoted segments with spaces ([projects."/x y"]), surrounding
 * whitespace, and [[array-of-tables]] (boundary only — never a managed match).
 * Array headers get a distinct section identity so findTable() treats them as
 * block boundaries without ever matching a plain table name.
 */
export function parseSectionHeader(trimmed) {
  const dblOpen = trimmed.startsWith('[[');
  const dblClose = trimmed.endsWith(']]');
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  if (dblOpen !== dblClose) return null;
  const array = dblOpen && dblClose;
  const inner = array ? trimmed.slice(2, -2).trim() : trimmed.slice(1, -1).trim();
  if (inner === '') return null;
  const parts = splitSectionParts(inner);
  if (!parts) return null;
  const name = array ? `[[${parts.join('.')}]]` : parts.join('.');
  return { name, array };
}

/**
 * Detect [[array-of-tables]] headers that normalize to a managed table name
 * (e.g. [[model_providers.buchi]]). Our managed edits target [single] tables
 * only; an array form would silently duplicate the definition, so callers
 * must abort loudly instead of splicing.
 */
export function findArrayManaged(parsed, managedProviders) {
  const out = [];
  for (const l of parsed.lines) {
    if (l.kind !== 'section' || !l.array) continue;
    const inner = l.section.slice(2, -2);
    for (const name of managedProviders) {
      if (inner === `model_providers.${name}`) out.push({ lineNo: l.lineNo ?? 0, name });
    }
  }
  return out;
}

function splitSectionParts(inner) {
  const parts = [];
  let cur = ''; let q = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '.') {
      if (cur.trim() === '') return null;
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (q) return null; // unbalanced quote in header
  if (cur.trim() === '') return null;
  parts.push(cur.trim());
  return parts;
}

function parseScalar(rawVal) {
  if (rawVal.length >= 2 && rawVal.startsWith('"') && rawVal.endsWith('"')) {
    try {
      return { raw: rawVal, parsed: JSON.parse(rawVal) };
    } catch { return { raw: rawVal, parsed: null }; }
  }
  if (rawVal.length >= 2 && rawVal.startsWith("'") && rawVal.endsWith("'")) {
    return { raw: rawVal, parsed: rawVal.slice(1, -1) };
  }
  if (rawVal === 'true') return { raw: rawVal, parsed: true };
  if (rawVal === 'false') return { raw: rawVal, parsed: false };
  if (/^[+-]?\d+$/.test(rawVal)) return { raw: rawVal, parsed: parseInt(rawVal, 10) };
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(rawVal)) {
    const n = Number(rawVal);
    if (Number.isFinite(n)) return { raw: rawVal, parsed: n };
  }
  return { raw: rawVal, parsed: null };
}

/** Encode a JS scalar as TOML (strings always double-quoted). */
export function tomlEncode(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error('TOML へ変換できない値の型です（string/boolean/number のみ対応）。');
}

/** Serialize parsed lines back to text (byte-for-byte except our splices). */
export function serializeToml(parsed) {
  return parsed.lines.map((l) => l.text).join('\n') + '\n';
}

/** Find a top-level keyval line. Returns { line, index } or null. */
export function findTopLevel(parsed, key) {
  for (let i = 0; i < parsed.lines.length; i += 1) {
    const l = parsed.lines[i];
    if (l.kind === 'keyval' && l.section === '' && l.key === key) return { line: l, index: i };
  }
  return null;
}

/** Find a table block [dotted]. Returns { start, end } line indexes or null. */
export function findTable(parsed, dotted) {
  let start = -1;
  for (let i = 0; i < parsed.lines.length; i += 1) {
    const l = parsed.lines[i];
    if (l.kind === 'section' && l.section === dotted) { start = i; break; }
  }
  if (start < 0) return null;
  let end = parsed.lines.length;
  for (let i = start + 1; i < parsed.lines.length; i += 1) {
    if (parsed.lines[i].kind === 'section') { end = i; break; }
  }
  return { start, end };
}

/**
 * Set a top-level scalar key. Inserts BEFORE the first [table] header
 * (Codex ignores top-level keys placed after tables). Preserves inline
 * comments on update. Returns { changed, inserted }.
 */
export function setTopLevel(parsed, key, value) {
  const encoded = `${key} = ${tomlEncode(value)}`;
  const found = findTopLevel(parsed, key);
  if (found) {
    const next = found.line.comment ? `${encoded} ${found.line.comment}` : encoded;
    const changed = found.line.text !== next;
    found.line.text = next;
    found.line.value = parseScalar(tomlEncode(value));
    found.line.raw = tomlEncode(value);
    return { changed, inserted: false };
  }
  const newline = { kind: 'keyval', text: encoded, section: '', key, value: parseScalar(tomlEncode(value)), raw: tomlEncode(value), comment: '' };
  let at = parsed.lines.length;
  for (let i = 0; i < parsed.lines.length; i += 1) {
    if (parsed.lines[i].kind === 'section') { at = i; break; }
  }
  // Keep a blank line between the inserted key and a following table header
  // for readability (no semantic effect).
  parsed.lines.splice(at, 0, newline);
  return { changed: true, inserted: true };
}

/** Delete a top-level key. Returns { changed }. */
export function deleteTopLevel(parsed, key) {
  const found = findTopLevel(parsed, key);
  if (!found) return { changed: false };
  parsed.lines.splice(found.index, 1);
  return { changed: true };
}

/**
 * Set a [dotted] table block from an ordered entries object.
 * Existing unknown lines inside the block are preserved in place; known keys
 * are updated (inline comments preserved), missing keys appended at block end.
 * A missing table is appended at file end (preceded by one blank line).
 * Returns { changed, created }.
 */
export function setTable(parsed, dotted, entries) {
  const keys = Object.keys(entries);
  const found = findTable(parsed, dotted);
  if (!found) {
    const block = [];
    if (parsed.lines.length > 0) block.push({ kind: 'blank', text: '', section: '' });
    block.push({ kind: 'section', text: `[${dotted}]`, section: dotted });
    for (const k of keys) {
      const enc = `${k} = ${tomlEncode(entries[k])}`;
      block.push({ kind: 'keyval', text: enc, section: dotted, key: k, value: parseScalar(tomlEncode(entries[k])), raw: tomlEncode(entries[k]), comment: '' });
    }
    parsed.lines.push(...block);
    return { changed: true, created: true };
  }
  let changed = false;
  const have = new Set();
  for (let i = found.start + 1; i < found.end; i += 1) {
    const l = parsed.lines[i];
    if (l.kind === 'keyval' && Object.prototype.hasOwnProperty.call(entries, l.key)) {
      have.add(l.key);
      const enc = `${l.key} = ${tomlEncode(entries[l.key])}`;
      const next = l.comment ? `${enc} ${l.comment}` : enc;
      if (l.text !== next) { l.text = next; changed = true; }
    }
  }
  for (const k of keys) {
    if (!have.has(k)) {
      const enc = `${k} = ${tomlEncode(entries[k])}`;
      parsed.lines.splice(found.end, 0, { kind: 'keyval', text: enc, section: dotted, key: k, value: parseScalar(tomlEncode(entries[k])), raw: tomlEncode(entries[k]), comment: '' });
      found.end += 1;
      changed = true;
    }
  }
  return { changed, created: false };
}

/**
 * Delete a whole [dotted] table block. Returns { changed, removedText }.
 * removedText (raw lines) is returned so callers can stash it for restore.
 */
export function deleteTable(parsed, dotted) {
  const found = findTable(parsed, dotted);
  if (!found) return { changed: false, removedText: '' };
  const removed = parsed.lines.splice(found.start, found.end - found.start);
  return { changed: true, removedText: removed.map((l) => l.text).join('\n') };
}

/**
 * Restore a previously stashed raw table block (off-restore for setup
 * overwrites). Replaces the current block or appends at file end.
 * Raw lines are re-homed to `dotted` (section field fix-up only; text kept).
 */
export function spliceTableRaw(parsed, dotted, rawBlockText) {
  const rawLines = String(rawBlockText).split('\n');
  const block = rawLines.map((text) => {
    const trimmed = text.trim();
    if (trimmed === '') return { kind: 'blank', text, section: dotted };
    if (trimmed.startsWith('#')) return { kind: 'comment', text, section: dotted };
    const sec = trimmed.match(/^\[([^\][\s]+(?:\.[^\][\s]+)*)\]$/);
    if (sec) return { kind: 'section', text, section: sec[1] };
    const kv = splitKeyValue(text);
    if (kv) return { kind: 'keyval', text, section: dotted, key: kv.key, value: kv.value, raw: kv.value.raw, comment: kv.comment };
    return { kind: 'other', text, section: dotted };
  });
  const found = findTable(parsed, dotted);
  if (!found) {
    if (parsed.lines.length > 0) parsed.lines.push({ kind: 'blank', text: '', section: '' });
    parsed.lines.push(...block);
    return { restored: true, created: true };
  }
  parsed.lines.splice(found.start, found.end - found.start, ...block);
  return { restored: true, created: false };
}

/** Read a table's keyval entries as { key: parsedValue }. Unknown lines skipped. */
export function readTable(parsed, dotted) {
  const found = findTable(parsed, dotted);
  if (!found) return null;
  const out = {};
  for (let i = found.start + 1; i < found.end; i += 1) {
    const l = parsed.lines[i];
    if (l.kind === 'keyval') out[l.key] = l.value.parsed;
  }
  return out;
}

/**
 * Validate managed Codex keys. Returns warnings[] (never throws):
 *  - model_provider stranded inside a [table] (Codex ignores non-top-level keys)
 *  - managed provider table missing name / wire_api not responses /
 *    requires_openai_auth + env_key coexistence (sub mode forbids env_key)
 */
export function validateManaged(parsed, managedProviders) {
  const warnings = [];
  // TOML では [テーブル] の後に書いた裸のキーはそのテーブルに属する。トップレベルに
  // 書くつもりの model_provider がテーブル内に迷子になっていると Codex は無警告で
  // 無視するため、検出して警告する。
  for (const l of parsed.lines) {
    if (l.kind === 'keyval' && l.key === 'model_provider' && l.section !== '') {
      warnings.push(`model_provider が [${l.section}] の中に書かれています。Codex はトップレベルの model_provider のみ読むため無視されます。テーブルの前に移動してください。`);
    }
  }
  for (const name of managedProviders) {
    const t = readTable(parsed, `model_providers.${name}`);
    if (!t) continue;
    if (!t.name) warnings.push(`[model_providers.${name}] に name がありません（設定読込が失敗します）。`);
    if (t.wire_api !== undefined && t.wire_api !== 'responses') {
      warnings.push(`[model_providers.${name}] の wire_api が "${t.wire_api}" です（responses のみ実機確認済み）。`);
    }
    if (t.requires_openai_auth === true && t.env_key !== undefined) {
      warnings.push(`[model_providers.${name}] で requires_openai_auth と env_key が併存しています（サブスク方式では env_key を併用できません）。`);
    }
  }
  return warnings;
}

/**
 * Find lines that are almost certainly broken TOML (Codex itself would reject
 * the file): unclosed section headers, empty values, unbalanced quotes.
 * Returns [{ lineNo, reason, preview }]. Exotic-but-valid TOML (dates, arrays
 * on one line) is NOT flagged — only unambiguous breakage.
 * Writers (setup/off apply) abort on any entry (fail-closed); doctor/status
 * report them as errors without writing.
 */
export function findSuspicious(parsed) {
  const out = [];
  for (const l of parsed.lines) {
    const t = l.text.trim();
    if (t === '' || t.startsWith('#')) continue;
    const lineNo = l.lineNo ?? 0;
    const preview = t.slice(0, 80);
    // Unclosed section header (valid [[array]] tables excluded).
    if (t.startsWith('[') && !/^\[[^\]]+\]$/.test(t) && !/^\[\[[^\]]+\]\]$/.test(t)) {
      out.push({ lineNo, reason: 'unclosed-section', preview });
      continue;
    }
    // key = (empty value, comment or not).
    if (/^("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(#.*)?$/.test(t)) {
      out.push({ lineNo, reason: 'empty-value', preview });
      continue;
    }
    // Unbalanced quote outside comments.
    if (hasUnbalancedQuote(t)) {
      out.push({ lineNo, reason: 'unbalanced-quote', preview });
    }
  }
  return out;
}

function hasUnbalancedQuote(text) {
  let inStr = null; let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\' && inStr === '"') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '#') break; // rest is a comment
  }
  return inStr !== null;
}
