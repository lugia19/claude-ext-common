// publish.js (claude-ext-common)
// Ships a release that release.js drafted, from the extension root, once its zips have been tested:
//
//   node common/scripts/publish.js <X.Y.Z> [--only=chrome,firefox,github]
//
// Uses the zips attached to the draft GitHub release vX.Y.Z (exactly what was tested, not a rebuild):
//   1. chrome:  uploads the Chrome zip to the Chrome Web Store and submits it for review
//   2. firefox: uploads the Firefox zip to AMO as a new listed version, with the draft's notes
//   3. github:  publishes the draft release (the Electron zip lives there)
// Asks you to type the version first. --only re-runs just some steps, e.g. after one failed.
//
// Credentials stay out of the repos, in %USERPROFILE%\.claude-ext-publish.json:
//   {
//     "chrome": {
//       "serviceAccountKeyFile": "C:\\path\\to\\service-account-key.json",
//       "publisherId": "<Chrome Web Store publisher id>",
//       "itemIds": { "<gecko id from manifest_firefox.json>": "<Chrome Web Store item id>" }
//     },
//     "amo": { "apiKey": "user:12345:67", "apiSecret": "..." }
//   }
// Chrome: a Google Cloud service account with the Chrome Web Store API enabled, its email added in
// the developer dashboard (Account), and a JSON key. AMO: addons.mozilla.org/developers/addon/api/key/
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CREDENTIALS = path.join(os.homedir(), '.claude-ext-publish.json');
const CWS = 'https://chromewebstore.googleapis.com';
const AMO = 'https://addons.mozilla.org';
const STEPS = ['chrome', 'firefox', 'github'];

function run(cmd, args) {
	return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fail(message) {
	console.error(`\n[publish] ${message}\n`);
	process.exit(1);
}
const step = (message) => console.log(`[publish] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base64url = (data) => Buffer.from(data).toString('base64url');

// A fetch that fails loudly, with the response body.
async function request(url, options, what) {
	const response = await fetch(url, options);
	const text = await response.text();
	if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${text.slice(0, 1000)}`);
	return text ? JSON.parse(text) : {};
}

// ======== arguments and checks ========

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail('Usage: node common/scripts/publish.js <X.Y.Z> [--only=chrome,firefox,github]');
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const selected = onlyArg ? onlyArg.slice('--only='.length).split(',') : STEPS;
const unknown = selected.filter((s) => !STEPS.includes(s));
if (unknown.length) fail(`Unknown step(s) ${unknown.join(', ')}: use ${STEPS.join(', ')}.`);
// Always in STEPS order, whatever --only says: GitHub goes public only after the stores.
const steps = STEPS.filter((s) => selected.includes(s));
const tag = `v${version}`;

// Only the store steps need credentials and the add-on id: --only=github works without them.
const storeSteps = steps.some((s) => s === 'chrome' || s === 'firefox');
let credentials = {};
let geckoId = null;
if (storeSteps) {
	if (!fs.existsSync(CREDENTIALS)) fail(`No credentials at ${CREDENTIALS} (see the top of this script).`);
	credentials = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
	geckoId = JSON.parse(fs.readFileSync('manifest_firefox.json', 'utf8')).browser_specific_settings?.gecko?.id;
	if (!geckoId) fail('No browser_specific_settings.gecko.id in manifest_firefox.json.');
}

if (steps.includes('chrome')) {
	const c = credentials.chrome;
	if (!c?.serviceAccountKeyFile || !c?.publisherId || !c?.itemIds?.[geckoId]) {
		fail(`${CREDENTIALS} needs chrome.serviceAccountKeyFile, chrome.publisherId and chrome.itemIds["${geckoId}"].`);
	}
	if (!fs.existsSync(c.serviceAccountKeyFile)) fail(`Service account key not found: ${c.serviceAccountKeyFile}`);
}
if (steps.includes('firefox') && (!credentials.amo?.apiKey || !credentials.amo?.apiSecret)) {
	fail(`${CREDENTIALS} needs amo.apiKey and amo.apiSecret.`);
}

let release;
try {
	release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'isDraft,body,name,url,assets']));
} catch (e) {
	fail(`No GitHub release ${tag} (run release.js first): ${(e.stderr || e.message).trim()}`);
}
if (!release.isDraft && steps.includes('github')) fail(`Release ${tag} is already published.`);
const assetFor = (target) => release.assets.find((a) => a.name.endsWith(`-${version}-${target}.zip`))?.name;
for (const target of ['chrome', 'firefox'].filter((t) => steps.includes(t))) {
	if (!assetFor(target)) fail(`Release ${tag} has no ${target} zip.`);
}
// The draft's body is "- line" bullets from update_patchnotes.txt, possibly edited on GitHub since.
const releaseNotes = release.body.trim();

// ======== confirmation ========

async function confirm() {
	console.log(`\nAbout to publish ${tag} "${release.name}" (${release.url})`);
	console.log(`Steps: ${steps.join(', ')}\n\nRelease notes:\n${releaseNotes}\n`);
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise((resolve) => rl.question(`Type ${version} to publish: `, resolve));
	rl.close();
	if (answer.trim() !== version) fail('Not confirmed, nothing published.');
}

// ======== Chrome Web Store (API v2, service account) ========

async function chromeToken() {
	const key = JSON.parse(fs.readFileSync(credentials.chrome.serviceAccountKeyFile, 'utf8'));
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = base64url(JSON.stringify({
		iss: key.client_email,
		scope: 'https://www.googleapis.com/auth/chromewebstore',
		aud: 'https://oauth2.googleapis.com/token',
		iat: now,
		exp: now + 3600,
	}));
	const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key).toString('base64url');
	const { access_token: token } = await request('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: `${header}.${claims}.${signature}`,
		}),
	}, 'Google token');
	return token;
}

async function publishChrome(zipPath) {
	const item = `publishers/${credentials.chrome.publisherId}/items/${credentials.chrome.itemIds[geckoId]}`;
	const token = await chromeToken();
	const auth = { Authorization: `Bearer ${token}` };

	step('Chrome: uploading...');
	let upload = await request(`${CWS}/upload/v2/${item}:upload?uploadType=media`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/zip' },
		body: fs.readFileSync(zipPath),
	}, 'Chrome upload');
	let state = upload.uploadState;
	for (let i = 0; state === 'IN_PROGRESS' && i < 60; i++) {
		await sleep(5000);
		upload = await request(`${CWS}/v2/${item}:fetchStatus`, { headers: auth }, 'Chrome status');
		state = upload.lastAsyncUploadState;
	}
	if (state !== 'SUCCEEDED') throw new Error(`Chrome upload ended as ${state}: ${JSON.stringify(upload)}`);
	if (upload.crxVersion && upload.crxVersion !== version) {
		throw new Error(`Chrome processed version ${upload.crxVersion}, expected ${version}.`);
	}

	step('Chrome: submitting for review...');
	const published = await request(`${CWS}/v2/${item}:publish`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
	}, 'Chrome publish');
	const warnings = published.warningInfo?.warnings?.map((w) => `${w.reason}: ${w.description}`) ?? [];
	step(`Chrome: submitted (${published.state}).${warnings.length ? ` Warnings:\n  ${warnings.join('\n  ')}` : ''}`);
}

// ======== addons.mozilla.org (API v5) ========

function amoAuth() {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const claims = base64url(JSON.stringify({
		iss: credentials.amo.apiKey, jti: crypto.randomUUID(), iat: now, exp: now + 60,
	}));
	const signature = crypto.createHmac('sha256', credentials.amo.apiSecret).update(`${header}.${claims}`).digest('base64url');
	return { Authorization: `JWT ${header}.${claims}.${signature}` };
}

async function publishFirefox(zipPath) {
	step('Firefox: uploading...');
	const form = new FormData();
	form.append('upload', new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }), path.basename(zipPath));
	form.append('channel', 'listed');
	let upload = await request(`${AMO}/api/v5/addons/upload/`, { method: 'POST', headers: amoAuth(), body: form }, 'AMO upload');
	for (let i = 0; !upload.processed && i < 60; i++) {
		await sleep(5000);
		upload = await request(`${AMO}/api/v5/addons/upload/${upload.uuid}/`, { headers: amoAuth() }, 'AMO upload status');
	}
	if (!upload.processed) throw new Error('AMO validation didn\'t finish in 5 minutes.');
	if (!upload.valid) {
		const messages = upload.validation?.messages?.filter((m) => m.type === 'error').map((m) => `${m.message} (${m.file || ''})`) ?? [];
		throw new Error(`AMO validation failed:\n  ${messages.join('\n  ') || JSON.stringify(upload.validation).slice(0, 1000)}`);
	}
	if (upload.version !== version) throw new Error(`AMO parsed version ${upload.version}, expected ${version}.`);

	step('Firefox: creating the version...');
	const created = await request(`${AMO}/api/v5/addons/addon/${encodeURIComponent(geckoId)}/versions/`, {
		method: 'POST',
		headers: { ...amoAuth(), 'Content-Type': 'application/json' },
		body: JSON.stringify({ upload: upload.uuid, release_notes: { 'en-US': releaseNotes } }),
	}, 'AMO version');
	step(`Firefox: version ${created.version} submitted (${created.file?.status ?? 'awaiting review'}).`);
}

// ======== main ========

(async () => {
	await confirm();

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `publish-${tag}-`));
	try {
		const zip = (target) => {
			run('gh', ['release', 'download', tag, '--pattern', assetFor(target), '--dir', dir, '--clobber']);
			return path.join(dir, assetFor(target));
		};
		for (const name of steps) {
			try {
				if (name === 'chrome') await publishChrome(zip('chrome'));
				if (name === 'firefox') await publishFirefox(zip('firefox'));
				if (name === 'github') {
					run('gh', ['release', 'edit', tag, '--draft=false', '--latest']);
					step(`GitHub: ${tag} published.`);
				}
			} catch (e) {
				const rest = steps.slice(steps.indexOf(name));
				fail(`${name} failed: ${e.message}\nFix it, then: node common/scripts/publish.js ${version} --only=${rest.join(',')}`);
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	step('Done.');
})();
