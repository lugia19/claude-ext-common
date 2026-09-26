// check-common.js (claude-ext-common)
// Run by each extension's build.bat before packaging, from the extension root. Stops the build
// unless common/ is exactly the commit the extension pins, and that commit matches common's main.
//
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

// An uninitialized submodule has nothing to lose: check out the pinned commit. (Also, until then
// `git -C common` would run against the extension repo itself.)
if (git(['submodule', 'status', 'common']).startsWith('-')) {
	console.log('[check-common] Initializing common/...');
	git(['submodule', 'update', '--init', 'common']);
}

const pinned = git(['ls-tree', 'HEAD', 'common']).split(/\s+/)[2];
if (!pinned) fail('This repo has no common/ submodule in HEAD.');

if (git(['-C', 'common', 'status', '--porcelain'])) {
	fail('common/ has uncommitted changes. Commit them in common (and bump the pointer), or discard them.');
}

// Not fixed up automatically: this is also what an uncommitted bump looks like, which
// `git submodule update` would silently undo.
const checkedOut = git(['-C', 'common', 'rev-parse', 'HEAD']);
if (checkedOut !== pinned) {
	fail(`common/ is at ${checkedOut.slice(0, 7)}, but this commit pins ${pinned.slice(0, 7)}.\n`
		+ '  Commit the bump, or run `git submodule update common` to go back to the pinned commit.');
}

try {
	git(['-C', 'common', 'fetch', '--quiet', 'origin']);
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
