// logger.js (claude-ext-common)
// Always-on logging shared by the claude.ai extensions. Every entry goes to the console and to the
// extension's own chrome.storage.local 'debug_logs' (the last MAX_ENTRIES), which the shared viewer
// (common/log/viewer.html) displays. Storage is per extension, so the two extensions' logs never mix.
//
// Classic script, no IIFE: plain globals of the loading world (createLogger, configureLogger), so per
// the README only one extension may load it into MAIN. Also works in an ES-module background through a
// side-effect import (it publishes onto globalThis).
//
//   configureLogger({ app: 'qol', prefix: '[QoL]' });   // once per context, before logging
//   const log = createLogger('Forking');
//   log('Forked', data); log.warn('...'); log.error('...', err); log.debug('...');
//   log('warn', '...');                                  // a leading level also works
//
// The MAIN world has no chrome.storage: there, entries are posted to the page and the ISOLATED world
// of the same app (matched by `app`) stores them.

const _LOG_MAX_ENTRIES = 1000;
const _LOG_MAX_MESSAGE = 2000;
const _LOG_FLUSH_MS = 1000;
const _LOG_RELAY_TYPE = 'CLAUDE_EXT_LOG';
const _LOG_LEVELS = ['debug', 'warn', 'error'];

const _logConfig = { app: 'ext', prefix: '[Ext]' };
let _logPending = [];
let _logFlushTimer = null;
let _logRelayInstalled = false;

function _logStorage() {
	return (globalThis.browser ?? globalThis.chrome)?.storage?.local ?? null;
}

function _logStringify(arg) {
	if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
	if (arg === null) return 'null';
	if (typeof arg !== 'object') return String(arg);
	try {
		// A seen-set guards against circular graphs. (Not a property allowlist: that would apply at every
		// nesting level and hollow out nested objects.)
		const seen = new WeakSet();
		return JSON.stringify(arg, (key, value) => {
			if (typeof value === 'object' && value !== null) {
				if (seen.has(value)) return '[Circular]';
				seen.add(value);
			}
			return value;
		}, 2);
	} catch (e) {
		return String(arg);
	}
}

// Read fresh and append, so entries written meanwhile by the extension's other contexts (other tabs,
// the background) survive. If storage is full, keep only the newest batch so it heals itself.
async function _logFlush() {
	_logFlushTimer = null;
	if (!_logPending.length) return;
	const batch = _logPending;
	_logPending = [];

	const storage = _logStorage();
	if (!storage) {
		// MAIN world: hand the batch to this app's ISOLATED world.
		globalThis.postMessage?.({ type: _LOG_RELAY_TYPE, app: _logConfig.app, entries: batch }, globalThis.location?.origin ?? '*');
		return;
	}
	try {
		const { debug_logs: logs = [] } = await storage.get('debug_logs');
		logs.push(...batch);
		await storage.set({ debug_logs: logs.slice(-_LOG_MAX_ENTRIES) });
	} catch (e) {
		try {
			await storage.set({ debug_logs: batch.slice(-100) });
		} catch (e2) { /* better to lose logs than to break anything */ }
	}
}

function _logQueue(entries) {
	_logPending.push(...entries);
	if (_logPending.length > _LOG_MAX_ENTRIES) _logPending = _logPending.slice(-_LOG_MAX_ENTRIES);
	_logFlushTimer ??= setTimeout(_logFlush, _LOG_FLUSH_MS);
}

// In an ISOLATED content script: store the entries this app's MAIN-world scripts post.
function _logInstallRelay() {
	if (_logRelayInstalled || !_logStorage() || typeof window === 'undefined' || !window.addEventListener) return;
	_logRelayInstalled = true;
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.data?.type !== _LOG_RELAY_TYPE) return;
		if (event.data.app !== _logConfig.app || !Array.isArray(event.data.entries)) return;
		_logQueue(event.data.entries);
	});
}

function configureLogger({ app, prefix } = {}) {
	if (app) _logConfig.app = app;
	if (prefix) _logConfig.prefix = prefix;
	_logInstallRelay();
}

function _logWrite(sender, level, args) {
	const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
	console[consoleMethod](`${_logConfig.prefix}[${sender}]`, ...args);

	let message = args.map(_logStringify).join(' ');
	if (message.length > _LOG_MAX_MESSAGE) {
		message = message.slice(0, _LOG_MAX_MESSAGE) + `…[truncated ${message.length - _LOG_MAX_MESSAGE} chars]`;
	}
	_logQueue([{ timestamp: new Date().toISOString(), sender, level, message }]);
}

// A logger for one area of the extension. Returns log(...args) with .debug/.warn/.error; a leading
// 'debug' | 'warn' | 'error' argument also sets the level.
function createLogger(sender) {
	const log = (...args) => {
		const level = typeof args[0] === 'string' && _LOG_LEVELS.includes(args[0]) ? args.shift() : 'debug';
		_logWrite(sender, level, args);
	};
	log.debug = (...args) => _logWrite(sender, 'debug', args);
	log.warn = (...args) => _logWrite(sender, 'warn', args);
	log.error = (...args) => _logWrite(sender, 'error', args);
	return log;
}

// Declarations above are only globals in a classic script; publish them for ES-module importers.
Object.assign(globalThis, { createLogger, configureLogger });
