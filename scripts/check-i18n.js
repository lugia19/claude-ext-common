// check-i18n.js (claude-ext-common)
// Reports i18n table problems. Warnings only, exit code is always 0.
//
//   node common/scripts/check-i18n.js [--tables <dir>]... [--src <dir>]...
//
// Paths are relative to the repo containing the submodule. Defaults: --tables content/i18n,
// --src content. The common tables (common/i18n) are always checked as well.
// - keys missing from / extra in each language vs en, for common and for the extension separately
// - extension tables defining shared.* keys, which belong to common
// - localize('...') / translate(x, '...') keys used in the sources that no en table defines
// - {placeholder} mismatches between en and a translation
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const commonDir = path.join(__dirname, '..');
const root = path.join(commonDir, '..');

const args = { tables: [], src: [] };
for (let i = 2; i < process.argv.length; i++) {
	const flag = process.argv[i].replace(/^--/, '');
	if (!(flag in args)) throw new Error(`Unknown argument ${process.argv[i]}`);
	args[flag].push(path.resolve(root, process.argv[++i]));
}
if (!args.tables.length) args.tables.push(path.join(root, 'content', 'i18n'));
if (!args.src.length) args.src.push(path.join(root, 'content'));

// Run the table files of the given dirs in a fresh sandbox and return the merged tables.
function loadTables(dirs) {
	const sandbox = {};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	for (const dir of dirs) {
		for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
			vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), sandbox, { filename: file });
		}
	}
	return sandbox.CLAUDE_EXT_I18N || {};
}

const commonTables = loadTables([path.join(commonDir, 'i18n')]);
const extTables = loadTables(args.tables);
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

let problems = 0;
const warn = msg => { problems++; console.log(msg); };

function checkSet(label, tables) {
	const en = tables.en || {};
	for (const [lang, table] of Object.entries(tables)) {
		if (lang === 'en') continue;
		const missing = Object.keys(en).filter(k => !(k in table));
		const extra = Object.keys(table).filter(k => !(k in en));
		if (missing.length) warn(`[${label}/${lang}] missing ${missing.length}: ${missing.join(', ')}`);
		if (extra.length) warn(`[${label}/${lang}] extra ${extra.length}: ${extra.join(', ')}`);
		for (const [k, v] of Object.entries(table)) {
			if (k in en && placeholders(v) !== placeholders(en[k])) {
				warn(`[${label}/${lang}] placeholder mismatch in ${k}: "${v}"`);
			}
		}
	}
}
checkSet('common', commonTables);
checkSet('ext', extTables);

for (const [lang, table] of Object.entries(extTables)) {
	const shared = Object.keys(table).filter(k => k.startsWith('shared.'));
	if (shared.length) warn(`[ext/${lang}] defines common keys: ${shared.join(', ')}`);
}

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}
const known = { ...(commonTables.en || {}), ...(extTables.en || {}) };
const sources = [...args.src, path.join(commonDir, 'ui')].filter(fs.existsSync).flatMap(d => walk(d));
for (const file of sources) {
	const src = fs.readFileSync(file, 'utf8');
	for (const m of src.matchAll(/(?:localize\(|translate\([^,()]+,)\s*['"`]([\w.-]+)['"`]/g)) {
		if (!(m[1] in known)) warn(`[en] undefined key ${m[1]} used in ${path.relative(root, file)}`);
	}
}

console.log(problems ? `\n${problems} problem(s).` : 'i18n OK');
