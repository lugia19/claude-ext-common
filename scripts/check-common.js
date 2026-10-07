// check-common.js (claude-ext-common)
// Run by each extension's build.bat before packaging, from the extension root. Stops the build
// unless common/ is exactly the commit the extension pins, and that commit matches common's main.
// This file lives in the submodule, so build.bat checks the submodule out first when it never was:
//
//   if not exist common\.git git submodule update --init common
//   node common/scripts/check-common.js || exit /b 1
'use strict';

const { execFileSync } = require('child_process');

function git(args) {
	return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(args) {
	try {
		git(args);
		return true;
	} catch (e) {
		return false;
	}
}

function fail(message) {
	console.error(`\n[check-common] ${message}\n[check-common] Build stopped.\n`);
	process.exit(1);
}

const pinned = git(['ls-tree', 'HEAD', 'common']).split(/\s+/)[2];
if (!pinned) fail('This repo has no common/ submodule in HEAD.');

// web-ext packs every file, so anything not in the commit counts, whatever the user's git config
// hides: untracked files, and ignored ones. The exceptions are ignored files under scripts/
// (scripts/bard's node_modules and captures), which every build.bat excludes from the zip, and an
// ignored node_modules/ at the root (for linting common in place), which web-ext never packs.
// Untracked files there still count, as they may be uncommitted work.
const dirty = git(['-C', 'common', 'status', '--porcelain', '--untracked-files=all', '--ignored'])
	.split('\n')
	.filter(line => line && !line.startsWith('!! scripts/') && line !== '!! node_modules/');
if (dirty.length) {
	fail('common/ has uncommitted changes or extra files. Commit them in common (and bump the pointer), or remove them.');
}

// Not fixed up automatically: this is also what an uncommitted bump looks like, which
// `git submodule update` would silently undo.
const checkedOut = git(['-C', 'common', 'rev-parse', 'HEAD']);
if (checkedOut !== pinned) {
	fail(`common/ is at ${checkedOut.slice(0, 7)}, but this commit pins ${pinned.slice(0, 7)}.\n`
		+ '  Commit the bump, or run `git submodule update common` to go back to the pinned commit.');
}

// A shallow submodule (--depth) lacks the history the ancestry check below walks.
const shallow = git(['-C', 'common', 'rev-parse', '--is-shallow-repository']) === 'true';
try {
	git(['-C', 'common', 'fetch', '--quiet', ...(shallow ? ['--unshallow'] : []), 'origin']);
} catch (e) {
	fail(`Couldn't fetch common from origin, so couldn't check it's up to date:\n  ${(e.stderr || e.message).trim()}`);
}

if (!gitOk(['-C', 'common', 'merge-base', '--is-ancestor', pinned, 'origin/main'])) {
	fail(`The pinned common commit ${pinned.slice(0, 7)} isn't on common's main (an unmerged branch?).`);
}

// Compared by content, not by commit: a common PR lands as a merge commit, so main is one commit
// past a pin on the merged branch's head while its files are identical.
if (!gitOk(['-C', 'common', 'diff', '--quiet', pinned, 'origin/main'])) {
	const missing = git(['-C', 'common', 'log', '--oneline', '--no-merges', `${pinned}..origin/main`]);
	fail(`common is behind main. Bump the pointer to origin/main first. Missing:\n${missing.replace(/^/gm, '  ')}`);
}

console.log(`[check-common] common/ is at ${pinned.slice(0, 7)}, up to date with main.`);
