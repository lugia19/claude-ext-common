// bridge.js (claude-ext-common)
// Messaging from content scripts to the extension, from either world:
//
//   ClaudeExtBridge.sendBackgroundMessage(app, message)   -> Promise of the background's reply
//   ClaudeExtBridge.call(app, type, data)                 -> Promise of this app's ISOLATED handler's reply
//   ClaudeExtBridge.serve(app, { handlers, background })  ISOLATED only: answer the two above from MAIN
//
// In the ISOLATED world sendBackgroundMessage is runtime.sendMessage, retried while the background is
// still waking up. The MAIN world has no extension APIs, so there it posts to the same app's ISOLATED
// world (matched by `app`, since every extension's ISOLATED world hears the page's messages), which
// forwards it and posts the answer back. `call` is the general form: MAIN asks an ISOLATED handler.
//
// serve() is the security boundary. Page scripts share the MAIN world and can post these messages too,
// so the ISOLATED side only runs the handlers it was given and only forwards background messages whose
// `type` is in its `background` allow-list. Everything else is answered with an error. If MAIN code
// sends during page load, the serving script must load at document_start.
//
// Like net.js, this is an IIFE publishing one versioned namespace, globalThis.ClaudeExtBridge: both
// extensions load it into the shared MAIN world, the NEWEST copy wins whatever the load order, and
// callers look members up at call time. Bump VERSION with every change; never break older callers.
(function () {
	'use strict';

	const VERSION = 1;

	const existing = globalThis.ClaudeExtBridge;
	if (existing && (existing.VERSION ?? 0) >= VERSION) return;
	const bridge = existing ?? (globalThis.ClaudeExtBridge = {});
	bridge.VERSION = VERSION;

	const CHANNEL = 'CLAUDE_EXT_BRIDGE';
	const BACKGROUND = '__background';
	const RETRIES = 10;
	const RETRY_DELAY_MS = 200;

	// The extension API in an ISOLATED world, null in MAIN (no runtime id there, even in Chrome).
	function extensionApi() {
		const api = globalThis.browser ?? globalThis.chrome;
		return api?.runtime?.id ? api : null;
	}

	const isReply = (data) => 'reply' in data || 'error' in data;

	bridge.sendBackgroundMessage = async function (app, message, { timeout } = {}) {
		const api = extensionApi();
		if (!api) return bridge.call(app, BACKGROUND, message, { timeout });
		for (let attempt = 1; ; attempt++) {
			try {
				return await api.runtime.sendMessage(message);
			} catch (e) {
				if (attempt >= RETRIES || !String(e?.message).includes('Receiving end does not exist')) throw e;
				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
			}
		}
	};

	// ======== MAIN side: calls waiting for an answer ========

	const pending = new Map(); // id -> { app, resolve, reject, timer }
	let nextId = 0;
	let listening = false;

	function listenForReplies() {
		if (listening) return;
		listening = true;
		window.addEventListener('message', (event) => {
			const data = event.data;
			if (event.source !== window || data?.channel !== CHANNEL || !isReply(data)) return;
			const call = pending.get(data.id);
			if (!call || call.app !== data.app) return;
			pending.delete(data.id);
			clearTimeout(call.timer);
			if ('error' in data) call.reject(new Error(data.error));
			else call.resolve(data.reply);
		});
	}

	bridge.call = function (app, type, data, { timeout = 10000 } = {}) {
		listenForReplies();
		const id = `${app}:${++nextId}:${Math.random().toString(36).slice(2)}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`ClaudeExtBridge: no answer to ${type} from ${app}`));
			}, timeout);
			pending.set(id, { app, resolve, reject, timer });
			window.postMessage({ channel: CHANNEL, app, id, type, data }, window.location.origin);
		});
	};

	// ======== ISOLATED side: answering ========

	const served = new Map(); // app -> { handlers, background: Set }

	bridge.serve = function (app, { handlers = {}, background = [] } = {}) {
		if (!extensionApi()) throw new Error('ClaudeExtBridge.serve: ISOLATED world only');
		let service = served.get(app);
		if (!service) {
			service = { handlers: {}, background: new Set() };
			served.set(app, service);
			window.addEventListener('message', (event) => answer(app, service, event));
		}
		Object.assign(service.handlers, handlers);
		for (const type of background) service.background.add(type);
	};

	async function answer(app, service, event) {
		const data = event.data;
		if (event.source !== window || event.origin !== window.location.origin) return;
		if (data?.channel !== CHANNEL || data.app !== app || typeof data.type !== 'string' || isReply(data)) return;
		const respond = (result) => window.postMessage({ channel: CHANNEL, app, id: data.id, ...result }, window.location.origin);
		try {
			let reply;
			if (data.type === BACKGROUND) {
				if (!service.background.has(data.data?.type)) throw new Error(`${data.data?.type} may not be sent to the background from the page`);
				reply = await bridge.sendBackgroundMessage(app, data.data);
			} else if (Object.prototype.hasOwnProperty.call(service.handlers, data.type)) {
				reply = await service.handlers[data.type](data.data);
			} else {
				throw new Error(`no handler for ${data.type}`);
			}
			respond({ reply: reply ?? null });
		} catch (e) {
			respond({ error: String(e?.message ?? e) });
		}
	}
})();
