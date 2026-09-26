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
//   configureLogger({ app: 'qol', prefix: '[QoL]', role: 'background' });   // in the background
//   const log = createLogger('Forking');
//   log('Forked', data); log.warn('...'); log.error('...', err); log.debug('...');
//   log('warn', '...');                                  // a leading level also works
//
// Never log conversation text, prompts, file contents or API keys: the log is persisted and shown in
// the viewer. Log ids, counts and lengths instead.
//
// Where entries go:
//   - background (role 'background'): the only writer of debug_logs. It appends one batch at a time,
//     so batches arriving together from several tabs can't overwrite each other.
//   - ISOLATED content scripts: batch for up to a second, then runtime.sendMessage the batch to the
//     background (written directly only if no background answers). Also flushed on pagehide and when
//     the page is hidden, so the entries logged just before a navigation or close aren't lost.
//   - MAIN world (no extension APIs): each entry is posted straight away to the ISOLATED world of the
//     same app (matched by `app`), which batches it with its own.

const _LOG_MAX_ENTRIES = 1000;
const _LOG_MAX_MESSAGE = 2000;
const _LOG_FLUSH_MS = 1000;
const _LOG_RELAY_TYPE = 'CLAUDE_EXT_LOG';          // MAIN -> ISOLATED, via window.postMessage
const _LOG_APPEND_TYPE = 'CLAUDE_EXT_LOG_APPEND';  // content -> background, via runtime.sendMessage
const _LOG_LEVELS = ['debug', 'warn', 'error'];

const _logConfig = { app: 'ext', prefix: '[Ext]', role: 'content' };
let _logPending = [];
let _logFlushTimer = null;
let _logListenersInstalled = false;
let _logWriteChain = Promise.resolve();

function _logExtApi() {
	return globalThis.browser ?? globalThis.chrome;
}

// Null in the MAIN world, which has no extension APIs.
function _logStorage() {
	return _logExtApi()?.storage?.local ?? null;
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

// Append a batch to debug_logs. Chained, so one context never interleaves two read-modify-writes.
// If storage is full, keep only the newest entries so it heals itself.
function _logAppend(entries) {
	_logWriteChain = _logWriteChain.then(async () => {
		const storage = _logStorage();
		try {
			const { debug_logs: logs = [] } = await storage.get('debug_logs');
			logs.push(...entries);
			await storage.set({ debug_logs: logs.slice(-_LOG_MAX_ENTRIES) });
		} catch (e) {
			try {
				await storage.set({ debug_logs: entries.slice(-100) });
			} catch (e2) { /* better to lose logs than to break anything */ }
		}
	});
	return _logWriteChain;
}

function _logFlush() {
	clearTimeout(_logFlushTimer);
	_logFlushTimer = null;
	if (!_logPending.length) return;
	const batch = _logPending;
	_logPending = [];
	if (_logConfig.role === 'background') {
		_logAppend(batch);
		return;
	}
	// Sent, not awaited: this also runs from pagehide, where the page won't wait for a reply.
	Promise.resolve(_logExtApi().runtime.sendMessage({ type: _LOG_APPEND_TYPE, entries: batch }))
		.catch(() => _logAppend(batch)); // no background listening: write directly, best effort
}

function _logQueue(entries) {
	_logPending.push(...entries);
	if (_logPending.length > _LOG_MAX_ENTRIES) _logPending = _logPending.slice(-_LOG_MAX_ENTRIES);
	_logFlushTimer ??= setTimeout(_logFlush, _LOG_FLUSH_MS);
}

function _logInstallListeners() {
	if (_logListenersInstalled || !_logStorage()) return;
	_logListenersInstalled = true;
	const ext = _logExtApi();

	if (_logConfig.role === 'background') {
		// Batches from this extension's content scripts. No reply: other listeners may answer.
		ext.runtime.onMessage.addListener((message, sender) => {
			if (message?.type !== _LOG_APPEND_TYPE || sender?.id !== ext.runtime.id || !Array.isArray(message.entries)) return;
			_logAppend(message.entries);
		});
		return;
	}
	if (typeof window === 'undefined' || !window.addEventListener) return;

	// Entries from this app's MAIN-world scripts.
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.data?.type !== _LOG_RELAY_TYPE) return;
		if (event.data.app !== _logConfig.app || !Array.isArray(event.data.entries)) return;
		_logQueue(event.data.entries);
	});
	// Don't lose the last second of entries to a navigation, reload or close.
	window.addEventListener('pagehide', _logFlush);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') _logFlush();
	});
}

// Call once per context, before logging. role: 'background' in the extension's background.
function configureLogger({ app, prefix, role } = {}) {
	if (app) _logConfig.app = app;
	if (prefix) _logConfig.prefix = prefix;
	if (role) _logConfig.role = role;
	_logInstallListeners();
}

function _logWrite(sender, level, args) {
	const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
	console[consoleMethod](`${_logConfig.prefix}[${sender}]`, ...args);

	let message = args.map(_logStringify).join(' ');
	if (message.length > _LOG_MAX_MESSAGE) {
		message = message.slice(0, _LOG_MAX_MESSAGE) + `…[truncated ${message.length - _LOG_MAX_MESSAGE} chars]`;
	}
	const entry = { timestamp: new Date().toISOString(), sender, level, message };
	if (_logStorage()) {
		_logQueue([entry]);
	} else {
		// MAIN world: hand it to this app's ISOLATED world now, rather than holding it in a page that
		// might be about to go away.
		globalThis.postMessage?.({ type: _LOG_RELAY_TYPE, app: _logConfig.app, entries: [entry] }, globalThis.location?.origin ?? '*');
	}
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
