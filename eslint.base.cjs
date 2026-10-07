// eslint.base.cjs (claude-ext-common)
// The ESLint flat config shared by claude-ext-common and both extensions. Each repo's own
// eslint.config.js calls baseConfig() with what's specific to it:
//
//   const { baseConfig, manifestGroups, htmlGroups } = require('./common/eslint.base.cjs');
//   module.exports = baseConfig({
//     root: __dirname,
//     groups: [...manifestGroups(__dirname, 'manifest_chrome.json'), ...htmlGroups(__dirname, ['popup.html'])],
//     libGlobals: { 'lib/dexie.min.js': ['Dexie'] },
//     modules: ['background.js', 'bg-components/**/*.js'],
//     serviceWorker: ['background.js'],
//     ignores: ['lib/**'],
//   });
//
// Cross-file globals are derived, not declared. Plain scripts share one global scope per "group":
// a content_scripts entry (one world), the <script> tags of an extension page, or an ES-module graph
// (moduleGroup: a module background, where side-effect imports only add what they publish). Every file in a
// group is parsed for the names it declares at top level or publishes on globalThis/window/self,
// and each linted file may use the names of its group. A file loaded by several groups (a helper in
// both the MAIN and ISOLATED worlds) only gets the names all of them provide, so using something
// only one world has is an error. Load order isn't enforced: a function may call something a later
// file defines. Minified libraries aren't parsed; name their globals in libGlobals.
//
// Only extension code is linted. Dev tooling (scripts/, *.mjs, *.cjs, the ESLint configs) is
// ignored: it runs under Node, needs a different set of globals, and only has to run.
//
// Resolves @eslint/js, globals and espree from the repo that runs ESLint (an extension's
// node_modules when this is its common/ submodule).
'use strict';

const fs = require('fs');
const path = require('path');
const js = require('@eslint/js');
const globals = require('globals');
const espree = require('espree');

const posix = (p) => p.split(path.sep).join('/');

// A manifest's content scripts as groups: { name, files } with repo-relative paths. Entries in the same
// world with the same `matches` run in one scope whatever their run_at (an extension has one ISOLATED
// world per frame), so they form one group; entries matching different pages don't.
function manifestGroups(root, manifestFile) {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestFile), 'utf8'));
	const groups = new Map();
	for (const cs of manifest.content_scripts ?? []) {
		const world = cs.world ?? 'ISOLATED';
		const key = `${world} ${JSON.stringify(cs.matches ?? [])}`;
		if (!groups.has(key)) groups.set(key, { name: `${manifestFile} content_scripts (${world}) ${(cs.matches ?? []).join(' ')}`, files: [] });
		groups.get(key).files.push(...(cs.js ?? []));
	}
	return [...groups.values()];
}

// Extension pages: the local <script src> files of each HTML file, one group per page.
function htmlGroups(root, htmlFiles) {
	return htmlFiles.map((html) => {
		const text = fs.readFileSync(path.join(root, html), 'utf8');
		const dir = path.posix.dirname(posix(html));
		const files = [...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
			.map(m => m[1])
			.filter(src => !/^[a-z]+:/i.test(src))
			.map(src => path.posix.normalize(src.startsWith('/') ? src.slice(1) : path.posix.join(dir, src)));
		return { name: html, files };
	});
}

// ES-module code: every file statically imported from `entry`, transitively (relative specifiers
// only). Classic scripts reached through a side-effect import (`import './x.js'`) run as modules, so
// in this group they only contribute what they publish on globalThis/window/self, never their
// top-level declarations (which stay module-scoped).
function moduleGroup(root, entry, name = `${entry} (module graph)`) {
	const files = [];
	const seen = new Set();
	const visit = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		files.push(file);
		const full = path.join(root, file);
		if (/\.min\.js$/.test(file) || !fs.existsSync(full)) return;
		let ast;
		try {
			ast = espree.parse(fs.readFileSync(full, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
		} catch (e) {
			return;
		}
		for (const node of ast.body) {
			const spec = (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration'
				|| (node.type === 'ExportNamedDeclaration' && node.source)) ? node.source.value : null;
			if (spec && /^\.\.?\//.test(spec)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
		}
	};
	visit(posix(entry));
	return { name, files, modules: true };
}

// What a script makes global: `declared` = top-level function/class/var/let/const (globals only when
// it runs as a classic script); `published` = names assigned to globalThis/window/self anywhere
// (`globalThis.X = ...`, or `Object.assign(globalThis, { X, ... })`), global either way.
function declaredGlobals(file) {
	const source = fs.readFileSync(file, 'utf8');
	const declared = new Set();
	const published = new Set();
	let ast;
	try {
		ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
	} catch (e) {
		return { declared, published }; // not a parseable script (a module, say): it contributes nothing
	}
	const addPattern = (p) => {
		if (!p) return;
		if (p.type === 'Identifier') declared.add(p.name);
		else if (p.type === 'ObjectPattern') p.properties.forEach(q => addPattern(q.value ?? q.argument));
		else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
		else if (p.type === 'RestElement') addPattern(p.argument);
		else if (p.type === 'AssignmentPattern') addPattern(p.left);
	};
	for (const node of ast.body) {
		if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) declared.add(node.id.name);
		if (node.type === 'VariableDeclaration') node.declarations.forEach(d => addPattern(d.id));
	}
	const isGlobalObject = (n) => n?.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(n.name);
	const walk = (node) => {
		if (!node || typeof node.type !== 'string') return;
		if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed
			&& isGlobalObject(node.left.object)) {
			published.add(node.left.property.name);
		}
		if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
			&& node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object'
			&& node.callee.property.name === 'assign' && isGlobalObject(node.arguments[0])) {
			for (const arg of node.arguments.slice(1)) {
				if (arg.type !== 'ObjectExpression') continue;
				for (const prop of arg.properties) {
					if (prop.type === 'Property' && !prop.computed) published.add(prop.key.name ?? String(prop.key.value));
				}
			}
		}
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			const child = node[key];
			if (Array.isArray(child)) child.forEach(walk);
			else if (child && typeof child === 'object') walk(child);
		}
	};
	walk(ast);
	return { declared, published };
}

// { file: Set(names) } for every file in the groups: the intersection over the groups it's in, minus
// what the file declares itself (configuring those as globals would make no-redeclare fire).
function groupGlobals(root, groups, libGlobals) {
	const cache = new Map();
	const parsed = (file) => {
		if (!cache.has(file)) {
			if (libGlobals[file]) cache.set(file, { declared: new Set(), published: new Set(libGlobals[file]) });
			else if (/\.min\.js$/.test(file) || !fs.existsSync(path.join(root, file))) cache.set(file, { declared: new Set(), published: new Set() });
			else cache.set(file, declaredGlobals(path.join(root, file)));
		}
		return cache.get(file);
	};
	const contributes = (file, modules) => {
		const { declared, published } = parsed(file);
		return modules ? published : new Set([...declared, ...published]);
	};
	const perFile = new Map();
	for (const group of groups) {
		const all = new Set();
		for (const file of group.files) for (const n of contributes(file, group.modules)) all.add(n);
		for (const file of group.files) {
			const prev = perFile.get(file);
			perFile.set(file, prev ? new Set([...prev].filter(n => all.has(n))) : all);
		}
	}
	for (const [file, names] of perFile) {
		const own = contributes(file, false);
		perFile.set(file, new Set([...names].filter(n => !own.has(n))));
	}
	return perFile;
}

// Unused arguments, catch bindings and rest siblings (`const { drop, ...keep } = x`) are fine.
const unusedVars = (vars) => ['error', { vars, args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }];

// The config array. Options (paths and globs are relative to root):
//   root        the repo directory (__dirname of its eslint.config.js)
//   groups      [{ name, files, modules? }] from manifestGroups / htmlGroups / moduleGroup / by hand
//   libGlobals  { 'lib/x.min.js': ['X'] } globals of files that aren't parsed
//   modules     globs of ES-module browser files (sourceType module)
//   serviceWorker  globs of service-worker scripts: WebExtension and service-worker globals
//               (importScripts...), but not window/document
//   ignores     extra global ignores
function baseConfig({ root, groups = [], libGlobals = {}, modules = [], serviceWorker = [], ignores = [] }) {
	const perFile = groupGlobals(root, groups, libGlobals);
	const config = [
		{
			ignores: [
				'**/node_modules/**', 'debug/**', 'web-ext-artifacts/**', '**/*.min.js',
				'scripts/**', '**/*.mjs', '**/*.cjs', 'eslint.config.*',
				// An extension's copy of this repo: common lints itself, from its own root.
				'common/**',
				...ignores,
			],
		},
		js.configs.recommended,
		{
			files: ['**/*.js'],
			languageOptions: { ecmaVersion: 'latest', sourceType: 'script' },
			rules: {
				'no-undef': 'error',
				// Scripts share their top-level names with the rest of their group, so only locals count.
				'no-unused-vars': unusedVars('local'),
			},
		},
		// Globals merge across matching entries, so a service worker must not match the browser one.
		{
			files: ['**/*.js'],
			ignores: serviceWorker,
			languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
		},
		...(serviceWorker.length ? [{
			files: serviceWorker,
			languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } },
		}] : []),
		...(modules.length ? [{
			files: modules,
			languageOptions: { sourceType: 'module' },
			rules: { 'no-unused-vars': unusedVars('all') },
		}] : []),
	];
	for (const [file, names] of perFile) {
		if (!names.size) continue;
		config.push({
			files: [file],
			// writable: a shared `let` (currentLocale, say) may be reassigned from another file.
			languageOptions: { globals: Object.fromEntries([...names].map(n => [n, 'writable'])) },
		});
	}
	return config;
}

module.exports = { baseConfig, manifestGroups, htmlGroups, moduleGroup, declaredGlobals };
