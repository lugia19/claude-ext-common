// translate-i18n.js (claude-ext-common)
// Machine-translates the language tables (<lang>.js) from en.js into every I18N_LOCALES language,
// through headless Claude Code (`claude -p`, Opus by default, on the logged-in subscription).
//
//   node common/scripts/translate-i18n.js [--dry-run] [--lang <tag>[,<tag>]...] [--model <model>]
//                                          [--concurrency <n>] [<dir>]...
//
// Paths are relative to the repo containing the submodule. Default dirs: as build-i18n.js (whichever
// of common/i18n, content/i18n and i18n exist). --dry-run lists what would be translated and calls
// nothing. --lang limits the run to those languages. --concurrency caps simultaneous calls (4).
// Rebuilds each dir's all.js afterwards.
//
// Only what changed is translated. Each dir keeps a committed .translations.json, whose `source`
// maps each key to the English its translations are of. A key of a language is translated when the
// language's table lacks it or its English differs from `source`; a changed key that isn't
// retranslated (failed, or outside --lang) is removed, so it shows the current English until a
// later run translates it. A translation edited by hand stays until its English changes. A key
// `source` doesn't know yet (a dir's first run) adopts whatever the tables have.
//
// Each output passes checks before it's written: same {placeholders} and line breaks as the
// English, same HTML tags, not empty. A key failing them is retried once, then left out (the UI
// falls back to English, and check-i18n.js reports the key missing). The tables are written from
// en.js as a template: same key order, comments and blank lines.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
	build, tableFiles, loadTables, placeholders, readText, writeIfChanged, defaultDirs, I18N_LOCALES,
} = require('./build-i18n.js');

const root = path.join(__dirname, '..', '..');
const MANIFEST = '.translations.json';
const CHUNK = 120; // keys per call
const MAX_ATTEMPTS = 2;

// ---- Arguments ----

const opts = { dryRun: false, langs: null, model: 'opus', concurrency: 4, dirs: [] };
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === '--dry-run') opts.dryRun = true;
	else if (a === '--lang') opts.langs = process.argv[++i].split(',').map(s => s.trim()).filter(Boolean);
	else if (a === '--model') opts.model = process.argv[++i];
	else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(process.argv[++i]) || 1);
	else if (a.startsWith('--')) throw new Error(`Unknown argument ${a}`);
	else opts.dirs.push(path.resolve(root, a));
}
if (!opts.dirs.length) opts.dirs = defaultDirs();

const ALL_LANGS = I18N_LOCALES.filter(l => l !== 'en');
if (opts.langs) {
	const unknown = opts.langs.filter(l => !ALL_LANGS.includes(l));
	if (unknown.length) throw new Error(`Not in I18N_LOCALES (or en): ${unknown.join(', ')}`);
}
const LANGS = opts.langs || ALL_LANGS;
const englishName = new Intl.DisplayNames(['en'], { type: 'language' });

// ---- Tables ----

const ENTRY = /^(\s*)"([^"\\]+)":\s*".*"(,?)\s*$/;
const isAssign = line => line.startsWith('Object.assign(');

// en.js split into lines, with the entries marked. Every entry must be on a line of its own.
function parseTemplate(dir, en) {
	const lines = readText(path.join(dir, 'en.js')).split('\n');
	const assignAt = lines.findIndex(isAssign);
	const seen = new Set();
	const body = lines.slice(assignAt + 1).map(line => {
		const m = ENTRY.exec(line);
		if (!m) return { line };
		seen.add(m[2]);
		return { line, indent: m[1], key: m[2], comma: m[3] };
	});
	const unparsed = Object.keys(en).filter(k => !seen.has(k));
	if (unparsed.length) throw new Error(`${dir}/en.js: entries not on a line of their own: ${unparsed.join(', ')}`);
	return { assign: lines[assignAt], body, en };
}

// The table file for lang, built from en.js. Keeps an existing file's header comment.
function renderTable(file, template, lang, table) {
	const existing = readText(file)?.split('\n');
	const assignAt = existing ? existing.findIndex(isAssign) : -1;
	const header = assignAt > 0 ? existing.slice(0, assignAt)
		: [`// ${englishName.of(lang)} - keys mirror en.js. Machine-translated by common/scripts/translate-i18n.js: a hand edit stays until the English changes.`];
	const body = template.body.flatMap(p => (!p.key ? [p.line]
		: p.key in table ? [`${p.indent}${JSON.stringify(p.key)}: ${JSON.stringify(table[p.key])}${p.comma}`] : []));
	return [...header, template.assign.replace("['en']", `['${lang}']`), ...body].join('\n');
}

// ---- Validation ----

const tags = s => [...s.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)].map(m => m[1] + m[2].toLowerCase()).sort().join(' ');
const breaks = s => (s.match(/\n/g) || []).length;

function problem(english, translated) {
	if (typeof translated !== 'string' || !translated.trim()) return 'empty';
	const need = placeholders(english).join(' ');
	if (need !== placeholders(translated).join(' ')) return `placeholders differ (need ${need.replace(/\S+/g, p => `{${p}}`) || 'none'})`;
	if (tags(english) !== tags(translated)) return 'HTML tags differ';
	if (breaks(english) !== breaks(translated)) return `line breaks differ (need ${breaks(english)})`;
	return null;
}

// ---- Claude ----

const SYSTEM_PROMPT = `You translate the user interface strings of two browser extensions for claude.ai (Claude Usage Tracker, which shows usage limits, token counts and conversation costs; and Claude QoL, which adds features such as conversation forking, export, search, text-to-speech and speech-to-text). The strings appear inside claude.ai's own interface, next to its labels.

You get a JSON object: the target language, and "strings", a map from message key to English text. Return every key, translated. The key names say where a string is used (sidebar labels, tooltips, settings, notifications, buttons).

Rules:
- Write natural, idiomatic UI text for that language, as a native software localizer would. Match the terminology claude.ai itself uses in that language where you know it.
- Keep labels and button texts as short as the English. Keep the English casing style only where it fits the language.
- Copy {placeholders} exactly as they are, untranslated, each one exactly as many times as in the English. Move them where the grammar needs them.
- Keep HTML tags, line breaks (\\n), leading and trailing punctuation such as ":" or "...", emoji, symbols and units like "5h", "%", "$" in the same roles. Localize abbreviations such as "d"/"h"/"m" for days/hours/minutes only where the language normally does.
- Do not translate product and brand names: Claude, Claude.ai, Claude Code, Claude QoL, Anthropic, Opus, Sonnet, Haiku, Fable, Ko-fi, GitHub, Firefox, Chrome, Electron, ElevenLabs, OpenAI, Markdown, JSON.
- If a "notes" map is present, it explains why an earlier attempt at that key was rejected: fix that.`;

const SCHEMA = JSON.stringify({
	type: 'object',
	properties: { translations: { type: 'object', additionalProperties: { type: 'string' } } },
	required: ['translations'],
});

// claude on Windows is usually an npm .cmd shim, which can't be spawned without a shell (and a shell
// would mangle the arguments): run the exe it points at, or a native install's claude.exe.
// CLAUDE_BIN overrides.
function findClaude() {
	if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
	if (process.platform !== 'win32') return 'claude';
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		const shimmed = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
		if (fs.existsSync(path.join(dir, 'claude.cmd')) && fs.existsSync(shimmed)) return shimmed;
		if (fs.existsSync(path.join(dir, 'claude.exe'))) return path.join(dir, 'claude.exe');
	}
	throw new Error('claude not found on PATH; set CLAUDE_BIN');
}

// Set up once, before the first call: the binary, and a temp dir holding the system prompt, which
// is also the calls' working dir, so no project CLAUDE.md or settings are anywhere near them.
let claude = null;
function prepareCalls() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-i18n-'));
	process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
	claude = { bin: findClaude(), dir, promptFile: path.join(dir, 'system.txt') };
	fs.writeFileSync(claude.promptFile, SYSTEM_PROMPT);
}

// At most opts.concurrency calls at once, across languages and chunks.
let active = 0;
const waiting = [];
async function limited(fn) {
	while (active >= opts.concurrency) await new Promise(resolve => waiting.push(resolve));
	active++;
	try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const stats = { calls: 0, cost: 0 };

// One call: { key: english } in, { key: translation } out. A plain model call: no tools, MCP
// servers, settings, skills or CLAUDE.md, so nothing but the prompt goes in.
function callClaude(lang, strings, notes) {
	const payload = { language: `${englishName.of(lang)} (${lang})`, strings, ...(notes && { notes }) };
	const args = ['-p', '--model', opts.model, '--output-format', 'json', '--json-schema', SCHEMA,
		'--system-prompt-file', claude.promptFile, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
		'--disable-slash-commands', '--no-session-persistence'];
	return limited(() => new Promise((resolve, reject) => {
		const child = spawn(claude.bin, args, { cwd: claude.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		let out = '', err = '';
		child.stdout.on('data', d => { out += d; });
		child.stderr.on('data', d => { err += d; });
		child.on('error', reject);
		child.on('close', code => {
			let result;
			try { result = JSON.parse(out); } catch { return reject(new Error(`claude exited ${code}, unreadable output: ${(err || out).slice(0, 500)}`)); }
			if (result.is_error || !result.structured_output?.translations) {
				return reject(new Error(`claude failed (${result.subtype || code}): ${String(result.result || err).slice(0, 500)}`));
			}
			stats.calls++;
			stats.cost += result.total_cost_usd || 0;
			resolve(result.structured_output.translations);
		});
		child.stdin.end(JSON.stringify(payload));
	}));
}

// The entries of obj for keys, or null if there are none.
function pick(obj, keys) {
	const picked = Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
	return Object.keys(picked).length ? picked : null;
}

// Translates { key: english } into lang, its chunks in parallel. A key failing validation (or in a
// failed call) is retried, with the reason it was rejected. Returns { done, failed: { key: reason } }.
async function translateLang(lang, strings) {
	const done = {};
	const why = {};
	let pending = Object.keys(strings);
	let notes = {};
	for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length; attempt++) {
		const chunks = [];
		for (let i = 0; i < pending.length; i += CHUNK) chunks.push(pending.slice(i, i + CHUNK));
		const nextNotes = {};
		await Promise.all(chunks.map(async keys => {
			let translations;
			try {
				translations = await callClaude(lang, pick(strings, keys), pick(notes, keys));
			} catch (e) {
				console.log(`${lang}: call failed (attempt ${attempt}): ${e.message}`);
				for (const k of keys) why[k] = 'call failed';
				return;
			}
			for (const k of keys) {
				const bad = problem(strings[k], translations[k]);
				if (!bad) { done[k] = translations[k]; continue; }
				why[k] = bad;
				nextNotes[k] = `Rejected: ${bad}. You wrote: ${JSON.stringify(translations[k] ?? null)}`;
			}
		}));
		pending = pending.filter(k => !(k in done));
		notes = nextNotes;
	}
	return { done, failed: pick(why, pending) || {} };
}

// ---- Run ----

async function main() {
	// Per dir: template, tables, the keys whose English changed; and per lang the keys to translate,
	// across dirs (keys are unique across them: shared.* only in common).
	const work = Object.fromEntries(LANGS.map(l => [l, {}]));
	const sets = opts.dirs.map(dir => {
		const tables = loadTables(tableFiles(dir));
		const template = parseTemplate(dir, tables.en || {});
		const manifestPath = path.join(dir, MANIFEST);
		const source = JSON.parse(readText(manifestPath) || '{}').source || {};
		const changed = new Set(Object.keys(template.en).filter(k => k in source && source[k] !== template.en[k]));
		for (const lang of LANGS) {
			for (const [k, english] of Object.entries(template.en)) {
				if (k in (tables[lang] || {}) && !changed.has(k)) continue;
				if (k in work[lang]) throw new Error(`Key ${k} is in more than one table set`);
				work[lang][k] = english;
			}
		}
		return { dir, template, manifestPath, tables, changed };
	});

	const todo = LANGS.filter(l => Object.keys(work[l]).length);
	const total = todo.reduce((n, l) => n + Object.keys(work[l]).length, 0);
	console.log(`${total} strings in ${todo.length} languages${todo.length ? `: ${todo.map(l => `${l} ${Object.keys(work[l]).length}`).join(', ')}` : ''}`);
	if (opts.dryRun) return 0;

	const results = {};
	if (todo.length) {
		prepareCalls();
		await Promise.all(todo.map(async lang => {
			const t0 = Date.now();
			results[lang] = await translateLang(lang, work[lang]);
			const failed = Object.keys(results[lang].failed).length;
			console.log(`${lang}: ${Object.keys(results[lang].done).length} translated${failed ? `, ${failed} FAILED` : ''} (${Math.round((Date.now() - t0) / 1000)}s)`);
			// Written as each language finishes, so an interrupted run keeps what it paid for.
			writeLang(sets, lang, results[lang].done);
		}));
	}
	// Languages this run didn't translate (outside --lang) still lose their outdated translations.
	for (const lang of ALL_LANGS.filter(l => !results[l])) writeLang(sets, lang, {});

	for (const set of sets) {
		writeIfChanged(set.manifestPath, JSON.stringify({ source: set.template.en }, null, '\t') + '\n');
		console.log(`${path.relative(root, path.join(set.dir, 'all.js'))}: ${build(set.dir) ? 'written' : 'up to date'}`);
	}

	let failures = 0;
	for (const [lang, r] of Object.entries(results)) {
		for (const [k, reason] of Object.entries(r.failed)) { failures++; console.log(`FAILED ${lang} ${k}: ${reason}`); }
	}
	console.log(`${stats.calls} calls, $${stats.cost.toFixed(2)} at API list price${failures ? `, ${failures} strings failed (they stay English; re-run to retry)` : ''}`);
	return failures ? 1 : 0;
}

// Applies a language's new translations to its tables. A key whose English changed and that has no
// new translation is removed, so the UI shows the current English rather than the old meaning; it's
// missing now, so the next run translates it again.
function writeLang(sets, lang, done) {
	for (const set of sets) {
		const table = set.tables[lang] ??= {};
		for (const k of Object.keys(set.template.en)) {
			if (k in done) table[k] = done[k];
			else if (set.changed.has(k)) delete table[k];
		}
		const file = path.join(set.dir, `${lang}.js`);
		if (!Object.keys(table).length && !fs.existsSync(file)) continue;
		writeIfChanged(file, renderTable(file, set.template, lang, table)); // en.js's trailing newline included
	}
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
