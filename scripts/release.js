// release.js (claude-ext-common)
// Prepares a release, from the extension root, and stops at a DRAFT GitHub release:
//
//   node common/scripts/release.js <major|minor|patch|X.Y.Z> "<release title>"
//
// Bumps the version in the three manifests and commits it with update_patchnotes.txt (write the notes
// first), pushes, tags vX.Y.Z, runs build.bat, and creates the draft release with the patch notes as
// its body and the three zips attached. Nothing reaches the stores: that's publish.js, once the draft
// has been tested.
//
// Re-running with the exact version (release.js X.Y.Z "<title>") resumes: the bump is skipped when the
// manifests already have the version, the tag when it's already on HEAD. Every failure after the bump
// prints that command. Windows only (build.bat); needs gh, logged in.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFESTS = ['manifest_chrome.json', 'manifest_firefox.json', 'manifest_electron.json'];
const TARGETS = ['chrome', 'firefox', 'electron'];
const NOTES = 'update_patchnotes.txt';

function run(cmd, args, { inherit = false } = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })?.trim();
}
const git = (...args) => run('git', args);
function ok(cmd, args) {
	try {
		run(cmd, args);
		return true;
	} catch (e) {
		return false;
	}
}
function fail(message) {
	console.error(`\n[release] ${message}\n`);
	process.exit(1);
}
const step = (message) => console.log(`[release] ${message}`);

// ======== arguments ========

const [bump, title] = process.argv.slice(2);
if (!bump || !title) fail('Usage: node common/scripts/release.js <major|minor|patch|X.Y.Z> "<release title>"');

const versions = MANIFESTS.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).version);
if (new Set(versions).size !== 1) fail(`The manifests disagree on the version: ${MANIFESTS.map((f, i) => `${f} ${versions[i]}`).join(', ')}`);
const current = versions[0];

function nextVersion() {
	if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
	const [major, minor, patch] = current.split('.').map(Number);
	if (bump === 'major') return `${major + 1}.0.0`;
	if (bump === 'minor') return `${major}.${minor + 1}.0`;
	if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
	fail(`Unknown bump "${bump}": use major, minor, patch or X.Y.Z.`);
}
const version = nextVersion();
const tag = `v${version}`;
const resume = `node common/scripts/release.js ${version} "${title}"`;

// ======== checks, before anything changes ========

if (!ok('gh', ['auth', 'status'])) fail('gh isn\'t installed or logged in (gh auth login).');
if (git('branch', '--show-current') !== 'main') fail('Not on main.');
try {
	git('fetch', '--quiet', '--tags', 'origin');
} catch (e) {
	fail(`Couldn't fetch origin: ${(e.stderr || e.message).trim()}`);
}
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main isn\'t in sync with origin/main (pull or push first).');

// A symbolic bump right after an unfinished release would bump again: finish that one instead.
// (Unfinished = no release, or only a draft that an earlier run left partway.)
if (!/^\d/.test(bump) && git('log', '-1', '--format=%s') === `chore: release ${current}`) {
	let published = false;
	try {
		published = !JSON.parse(run('gh', ['release', 'view', `v${current}`, '--json', 'isDraft'])).isDraft;
	} catch (e) { /* no release at all */ }
	if (!published) {
		fail(`HEAD is the unfinished release of ${current} (not published on GitHub yet). To finish it:\n  node common/scripts/release.js ${current} "${title}"`);
	}
}

const dirty = git('status', '--porcelain').split('\n').filter(Boolean).map((line) => line.slice(3));
const unexpected = dirty.filter((file) => file !== NOTES);
if (unexpected.length) fail(`Uncommitted changes besides ${NOTES}:\n  ${unexpected.join('\n  ')}`);

// The notes must have changed since the previous release (a forgotten update would announce old news).
const previousTag = (() => {
	try {
		return git('describe', '--tags', '--abbrev=0', '--exclude', tag);
	} catch (e) {
		return null;
	}
})();
if (previousTag) {
	let before = null;
	try {
		before = git('show', `${previousTag}:${NOTES}`);
	} catch (e) { /* no notes file back then */ }
	if (before !== null && before.trim() === fs.readFileSync(NOTES, 'utf8').trim()) {
		fail(`${NOTES} is unchanged since ${previousTag}. Write this release's notes first.`);
	}
}
const notes = fs.readFileSync(NOTES, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
if (!notes.length) fail(`${NOTES} is empty.`);

// A draft for this tag is left by an earlier run that failed partway (gh creates the draft, then
// uploads the zips separately): reuse it. A published one means this version is done.
const existingRelease = (() => {
	try {
		return JSON.parse(run('gh', ['release', 'view', tag, '--json', 'isDraft']));
	} catch (e) {
		return null;
	}
})();
if (existingRelease && !existingRelease.isDraft) fail(`GitHub release ${tag} is already published.`);

const tagAt = (() => {
	try {
		return git('rev-parse', `${tag}^{commit}`);
	} catch (e) {
		return null;
	}
})();

try {
	run('node', ['common/scripts/check-common.js'], { inherit: true });
} catch (e) {
	process.exit(1); // check-common already said why
}

// ======== bump, commit, push ========

if (current === version) {
	step(`The manifests are already at ${version}: no bump.`);
	if (dirty.includes(NOTES)) fail(`${NOTES} has uncommitted changes, but the version is already bumped. Commit them first.`);
} else {
	if (tagAt) fail(`Tag ${tag} already exists, but the manifests are at ${current}.`);
	for (const file of MANIFESTS) {
		const text = fs.readFileSync(file, 'utf8');
		const from = `"version": "${current}"`;
		if (!text.includes(from)) fail(`Couldn't find ${from} in ${file}.`);
		fs.writeFileSync(file, text.replace(from, `"version": "${version}"`)); // keeps the line endings
	}
	git('add', ...MANIFESTS, NOTES);
	git('commit', '--quiet', '-m', `chore: release ${version}`);
	git('push', '--quiet', 'origin', 'main');
	step(`Bumped ${current} -> ${version}, committed and pushed.`);
}

// ======== tag ========

const head = git('rev-parse', 'HEAD');
if (tagAt && tagAt !== head) fail(`Tag ${tag} already exists on another commit (${tagAt.slice(0, 7)}).`);
if (!tagAt) git('tag', tag);
git('push', '--quiet', 'origin', tag);
step(`Tagged ${tag} and pushed the tag.`);

// ======== build ========

step('Building...');
try {
	run('cmd', ['/c', 'build.bat'], { inherit: true });
} catch (e) {
	fail(`build.bat failed. The version and tag are done; fix it and resume with:\n  ${resume}`);
}
const artifacts = fs.readdirSync('web-ext-artifacts');
const zips = TARGETS.map((target) => {
	const zip = artifacts.find((file) => file.endsWith(`-${version}-${target}.zip`));
	if (!zip) fail(`No ${target} zip for ${version} in web-ext-artifacts/.`);
	return path.join('web-ext-artifacts', zip);
});

// ======== draft release ========

const notesFile = path.join(os.tmpdir(), `release-notes-${tag}.md`);
fs.writeFileSync(notesFile, notes.map((line) => `- ${line}`).join('\n') + '\n');
try {
	if (existingRelease) {
		run('gh', ['release', 'edit', tag, '--title', title, '--notes-file', notesFile]);
		run('gh', ['release', 'upload', tag, ...zips, '--clobber']);
	} else {
		run('gh', ['release', 'create', tag, '--draft', '--verify-tag', '--title', title, '--notes-file', notesFile, ...zips]);
	}
} catch (e) {
	fail(`The draft release failed: ${(e.stderr || e.message).trim()}\nResume with:\n  ${resume}`);
} finally {
	fs.rmSync(notesFile, { force: true });
}
const url = run('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url']);
step(`Draft release ${tag} "${title}" ${existingRelease ? 'updated' : 'created'}: ${url}`);
step(`Test the zips from it, then: node common/scripts/publish.js ${version}`);
