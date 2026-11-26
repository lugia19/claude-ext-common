// translate-i18n.js (claude-ext-common)
// Machine-translates the language tables (<lang>.js) from en.js into every I18N_LOCALES language,
// through headless Claude Code (`claude -p`, Opus by default, on the logged-in subscription).
//
//   node common/scripts/translate-i18n.js [--dry-run] [--lang <tag>[,<tag>]...] [--model <model>]
//                                          [--concurrency <n>] [<dir>]...
//
// Paths are relative to the repo containing the submodule. Default dirs: as build-i18n.js (whichever
// of common/i18n, content/i18n and i18n exist). --dry-run lists what would be translated and calls
// nothing. --lang limits the run to those languages. Rebuilds each dir's all.js afterwards.
//
// Only what changed is translated. Each dir keeps a committed .translations.json:
//   source: { key: <the English text the translations are of> }
//   stale:  { lang: [keys whose English changed but whose retranslation failed or was skipped] }
// A key of a language is translated when the language's table lacks it, its English differs from
// `source`, or it's listed in `stale`. So a translation edited by hand stays until its English
// changes. A key `source` doesn't know yet (a dir's first run) adopts whatever the tables have.
//
// Each output passes checks before it's written: same {placeholders} and line breaks as the
// English, same HTML tags, not empty. A key failing them is retried once, then left out (the UI
// falls back to English, and check-i18n.js reports the key missing). The tables are written from
// en.js as a template: same key order, comments and blank lines.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { build, isTable, defaultDirs } = require('./build-i18n.js');

const commonDir = path.join(__dirname, '..');
const root = path.join(commonDir, '..');
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

// ---- The language list, from i18n-core.js itself ----

const core = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(commonDir, 'i18n', 'i18n-core.js'), 'utf8'), core);
const ALL_LANGS = core.I18N_LOCALES.filter(l => l !== 'en');
if (opts.langs) {
	const unknown = opts.langs.filter(l => !ALL_LANGS.includes(l));
	if (unknown.length) throw new Error(`Not in I18N_LOCALES (or en): ${unknown.join(', ')}`);
}
const LANGS = opts.langs || ALL_LANGS;
const englishName = new Intl.DisplayNames(['en'], { type: 'language' });

// ---- Tables ----

function loadTable(file) {
	const sandbox = {};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
	const tables = sandbox.CLAUDE_EXT_I18N || {};
	return Object.values(tables)[0] || {};
}

const ENTRY = /^(\s*)"([^"\\]+)":\s*(".*")(,?)\s*$/;

// en.js split into lines, with the entries marked. Every entry must be on a line of its own.
function parseTemplate(dir) {
	const lines = fs.readFileSync(path.join(dir, 'en.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');
	const en = loadTable(path.join(dir, 'en.js'));
	const seen = new Set();
	const parsed = lines.map(line => {
		const m = ENTRY.exec(line);
		if (!m) return { line };
		seen.add(m[2]);
		return { line, indent: m[1], key: m[2], comma: m[4] };
	});
	const unparsed = Object.keys(en).filter(k => !seen.has(k));
	if (unparsed.length) throw new Error(`${dir}/en.js: entries not on a line of their own: ${unparsed.join(', ')}`);
	return { parsed, en };
}

// The table file for lang, built from en.js. Keeps an existing file's header comment.
function renderTable(dir, template, lang, table) {
	const target = path.join(dir, `${lang}.js`);
	let header = null;
	if (fs.existsSync(target)) {
		const existing = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n').split('\n');
		const start = existing.findIndex(l => l.startsWith('Object.assign('));
		if (start > 0) header = existing.slice(0, start);
	}
	const out = [];
	let inHeader = true;
	for (const p of template.parsed) {
		if (inHeader) {
			if (!p.line.startsWith('Object.assign(')) continue;
			inHeader = false;
			out.push(...(header || [`// ${englishName.of(lang)} - keys mirror en.js. Machine-translated by common/scripts/translate-i18n.js: a hand edit stays until the English changes.`]));
			out.push(p.line.replace("['en']", `['${lang}']`));
			continue;
		}
		if (!p.key) out.push(p.line);
		else if (p.key in table) out.push(`${p.indent}${JSON.stringify(p.key)}: ${JSON.stringify(table[p.key])}${p.comma}`);
	}
	return out.join('\n');
}

// ---- Validation ----

const sorted = (arr) => arr.sort().join('\u0000');
const placeholders = s => sorted([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
const tags = s => sorted([...s.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)].map(m => m[0].startsWith('</') ? `/${m[1].toLowerCase()}` : m[1].toLowerCase()));
const breaks = s => (s.match(/\n/g) || []).length;

function problem(english, translated) {
	if (typeof translated !== 'string' || !translated.trim()) return 'empty';
	if (placeholders(english) !== placeholders(translated)) return `placeholders differ (need ${placeholders(english).split('\u0000').map(p => `{${p}}`).join(' ') || 'none'})`;
	if (tags(english) !== tags(translated)) return 'HTML tags differ';
	if (breaks(english) !== breaks(translated)) return `line breaks differ (need ${breaks(english)})`;
	return null;
}

// ---- Claude ----

// claude on Windows is an npm .cmd shim, which can't be spawned without a shell (and a shell would
// mangle the arguments): run the exe it points at. CLAUDE_BIN overrides.
function claudeBinary() {
	if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
	if (process.platform !== 'win32') return 'claude';
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		if (!fs.existsSync(path.join(dir, 'claude.cmd'))) continue;
		const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
		if (fs.existsSync(exe)) return exe;
	}
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		const exe = path.join(dir, 'claude.exe');
		if (fs.existsSync(exe)) return exe;
	}
	throw new Error('claude not found on PATH; set CLAUDE_BIN');
}

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

let systemPromptFile = null;
function writeSystemPrompt() {
	const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'translate-i18n-'));
	systemPromptFile = path.join(dir, 'system.txt');
	fs.writeFileSync(systemPromptFile, SYSTEM_PROMPT);
	process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}

// One call: { key: english } in, { key: translation } out. A plain model call: no tools, MCP
// servers, settings, skills or CLAUDE.md, so nothing but the prompt goes in.
function callClaude(lang, strings, notes) {
	const payload = { language: `${englishName.of(lang)} (${lang})`, strings, ...(notes && { notes }) };
	const args = ['-p', '--model', opts.model, '--output-format', 'json', '--json-schema', SCHEMA,
		'--system-prompt-file', systemPromptFile, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
		'--disable-slash-commands', '--no-session-persistence'];
	return new Promise((resolve, reject) => {
		// Run from the OS temp dir, so no project CLAUDE.md or settings are anywhere near it.
		const child = spawn(claudeBinary(), args, { cwd: path.dirname(systemPromptFile), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
			resolve({ translations: result.structured_output.translations, cost: result.total_cost_usd || 0 });
		});
		child.stdin.end(JSON.stringify(payload, null, '\t'));
	});
}

// Translates { key: english } into lang, retrying keys that fail validation (or a failed call).
// Returns { done: { key: translation }, failed: { key: reason } }.
async function translateLang(lang, strings, log) {
	const done = {};
	let pending = { ...strings };
	let notes = null;
	const failed = {};
	for (let attempt = 1; attempt <= MAX_ATTEMPTS && Object.keys(pending).length; attempt++) {
		const keys = Object.keys(pending);
		const retry = {};
		const nextNotes = {};
		for (let i = 0; i < keys.length; i += CHUNK) {
			const chunk = Object.fromEntries(keys.slice(i, i + CHUNK).map(k => [k, pending[k]]));
			const chunkNotes = notes && Object.fromEntries(Object.keys(chunk).filter(k => notes[k]).map(k => [k, notes[k]]));
			let translations;
			try {
				const r = await callClaude(lang, chunk, chunkNotes && Object.keys(chunkNotes).length ? chunkNotes : null);
				translations = r.translations;
				stats.cost += r.cost;
				stats.calls++;
			} catch (e) {
				log(`${lang}: call failed (attempt ${attempt}): ${e.message}`);
				for (const k of Object.keys(chunk)) { retry[k] = chunk[k]; failed[k] = 'call failed'; }
				continue;
			}
			for (const [k, english] of Object.entries(chunk)) {
				const bad = problem(english, translations[k]);
				if (bad) { retry[k] = english; nextNotes[k] = `Rejected: ${bad}. You wrote: ${JSON.stringify(translations[k] ?? null)}`; failed[k] = bad; }
				else { done[k] = translations[k]; delete failed[k]; }
			}
		}
		pending = retry;
		notes = nextNotes;
	}
	return { done, failed };
}

// ---- Run ----

const stats = { calls: 0, cost: 0 };

async function pool(items, n, fn) {
	const queue = [...items];
	await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
		while (queue.length) await fn(queue.shift());
	}));
}

async function main() {
	// Per dir: template, tables, manifest, and per lang the keys to translate.
	const sets = opts.dirs.map(dir => {
		const template = parseTemplate(dir);
		const manifestPath = path.join(dir, MANIFEST);
		const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { source: {}, stale: {} };
		manifest.source ??= {};
		manifest.stale ??= {};
		const tables = {};
		for (const lang of ALL_LANGS) {
			const file = path.join(dir, `${lang}.js`);
			tables[lang] = fs.existsSync(file) ? loadTable(file) : {};
		}
		const strays = fs.readdirSync(dir).filter(isTable).map(f => f.slice(0, -3)).filter(l => l !== 'en' && !ALL_LANGS.includes(l));
		if (strays.length) console.warn(`${path.relative(root, dir)}: tables for languages not in I18N_LOCALES: ${strays.join(', ')}`);
		const changed = new Set(Object.keys(template.en).filter(k => k in manifest.source && manifest.source[k] !== template.en[k]));
		const dirty = {};
		for (const lang of LANGS) {
			const stale = new Set(manifest.stale[lang] || []);
			dirty[lang] = Object.keys(template.en).filter(k => !(k in tables[lang]) || changed.has(k) || stale.has(k));
		}
		return { dir, template, manifestPath, manifest, tables, changed, dirty };
	});

	// Keys are unique across dirs (shared.* only in common), so a language goes out in one batch.
	const work = {};
	for (const lang of LANGS) {
		work[lang] = {};
		for (const set of sets) {
			for (const k of set.dirty[lang]) {
				if (k in work[lang]) throw new Error(`Key ${k} is in more than one table set`);
				work[lang][k] = set.template.en[k];
			}
		}
	}
	const todo = LANGS.filter(l => Object.keys(work[l]).length);
	const total = todo.reduce((n, l) => n + Object.keys(work[l]).length, 0);
	console.log(`${total} strings in ${todo.length} languages${todo.length ? `: ${todo.map(l => `${l} ${Object.keys(work[l]).length}`).join(', ')}` : ''}`);
	if (opts.dryRun || !todo.length) {
		if (!opts.dryRun) updateManifests(sets, {});
		return 0;
	}

	writeSystemPrompt();
	const results = {};
	const log = msg => console.log(msg);
	await pool(todo, opts.concurrency, async lang => {
		const t0 = Date.now();
		results[lang] = await translateLang(lang, work[lang], log);
		const failedKeys = Object.keys(results[lang].failed);
		log(`${lang}: ${Object.keys(results[lang].done).length} translated${failedKeys.length ? `, ${failedKeys.length} FAILED` : ''} (${Math.round((Date.now() - t0) / 1000)}s)`);
		// Written as each language finishes, so an interrupted run keeps what it paid for.
		writeLang(sets, lang, results[lang].done);
	});

	updateManifests(sets, results);
	for (const set of sets) {
		console.log(`${path.relative(root, path.join(set.dir, 'all.js'))}: ${build(set.dir) ? 'written' : 'up to date'}`);
	}

	let failures = 0;
	for (const [lang, r] of Object.entries(results)) {
		for (const [k, why] of Object.entries(r.failed)) { failures++; console.log(`FAILED ${lang} ${k}: ${why}`); }
	}
	console.log(`${stats.calls} calls, $${stats.cost.toFixed(2)} at API list price${failures ? `, ${failures} strings failed (they stay English; re-run to retry)` : ''}`);
	return failures ? 1 : 0;
}

function writeLang(sets, lang, done) {
	for (const set of sets) {
		const table = set.tables[lang];
		let touched = false;
		for (const k of set.dirty[lang]) {
			if (k in done) { table[k] = done[k]; touched = true; }
		}
		if (!touched && !set.dirty[lang].length) continue;
		const file = path.join(set.dir, `${lang}.js`);
		const content = renderTable(set.dir, set.template, lang, table); // en.js's trailing newline included
		const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
		if (content !== current) fs.writeFileSync(file, content);
	}
}

// source <- the current English; stale <- the keys whose English changed and that no language
// covered by this run translated (languages outside --lang included).
function updateManifests(sets, results) {
	for (const set of sets) {
		const { manifest, template } = set;
		const keys = Object.keys(template.en);
		const stale = {};
		for (const lang of ALL_LANGS) {
			const s = new Set((manifest.stale[lang] || []).filter(k => k in template.en));
			for (const k of keys) {
				const translatedNow = k in (results[lang]?.done || {});
				if (translatedNow) s.delete(k);
				else if (set.changed.has(k) && k in set.tables[lang]) s.add(k);
			}
			if (s.size) stale[lang] = keys.filter(k => s.has(k));
		}
		const next = JSON.stringify({ source: Object.fromEntries(keys.map(k => [k, template.en[k]])), stale }, null, '\t') + '\n';
		// Unchanged apart from line endings (a CRLF checkout) is unchanged.
		const current = fs.existsSync(set.manifestPath) ? fs.readFileSync(set.manifestPath, 'utf8').replace(/\r\n/g, '\n') : null;
		if (next !== current) fs.writeFileSync(set.manifestPath, next);
	}
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
