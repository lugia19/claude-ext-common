// check-i18n.js (claude-ext-common)
// Reports i18n table problems. Warnings only, exit code is always 0.
//
//   node common/scripts/check-i18n.js [--tables <dir>]... [--src <dir>]...
//
// Paths are relative to the repo containing the submodule. --src takes directories or single files
// (node_modules, debug and common are skipped inside directories). Defaults: --tables content/i18n,
// --src content. The common tables (common/i18n) are always checked as well.
// - I18N_LOCALES languages with no table (translate-i18n.js makes them)
// - keys missing from / extra in each language vs en, for common and for the extension separately
// - extension tables defining shared.* keys, which belong to common
// - localize('...') / translate(x, '...') keys used in the sources that no en table defines
// - {placeholder} mismatches between en and a translation
// - a generated all.js (build-i18n.js) that no longer matches its tables
const fs = require('fs');
const path = require('path');
const { tableFiles, loadTables, placeholders: placeholderList, I18N_LOCALES, isStale, BUNDLE } = require('./build-i18n.js');

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

const commonTables = loadTables(tableFiles(path.join(commonDir, 'i18n')));
const extTables = loadTables(args.tables.flatMap(tableFiles));
const placeholders = s => placeholderList(s).join(',');

let problems = 0;
const warn = msg => { problems++; console.log(msg); };

function checkSet(label, tables) {
	const en = tables.en || {};
	const absent = I18N_LOCALES.filter(l => !(l in tables));
	if (absent.length) warn(`[${label}] no table for ${absent.join(', ')}: run node common/scripts/translate-i18n.js`);
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

const SKIP_DIRS = new Set(['node_modules', 'debug', 'common', '.git']);
function walk(target, out = []) {
	if (!fs.statSync(target).isDirectory()) {
		if (target.endsWith('.js')) out.push(target);
		return out;
	}
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		walk(path.join(target, entry.name), out);
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

// Generated bundles (build-i18n.js) must match their tables, or the extension loads stale strings.
for (const dir of [path.join(commonDir, 'i18n'), ...args.tables]) {
	if (fs.existsSync(path.join(dir, BUNDLE)) && isStale(dir)) warn(`[bundle] ${path.relative(root, path.join(dir, BUNDLE))} is stale: run node common/scripts/build-i18n.js`);
}

console.log(problems ? `\n${problems} problem(s).` : 'i18n OK');
