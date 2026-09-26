// net.js (claude-ext-common)
// Helpers for code that intercepts claude.ai's requests: fetch arguments, API URLs, rebuilt
// responses, gzipped request bodies and SSE streams.
//
// Unlike the rest of common, this is an IIFE that publishes into ONE namespace, globalThis.ClaudeExtNet,
// member by member with ??=. Every extension may load it into the shared MAIN world (and the tracker's
// background imports it too), and whichever copy loads first provides each member. So the API is
// APPEND-ONLY: never change what a published member does or returns - add a member with a new name.
(function () {
	'use strict';

	const net = (globalThis.ClaudeExtNet ??= {});

	// ======== fetch arguments ========

	// The absolute URL of a fetch() input (string, URL or Request). Relative URLs resolve the way
	// fetch() resolves them: against the document's base URL, so 'api/x' on /chat/123 is
	// /chat/api/x. '' for anything else.
	net.getFetchUrl ??= function (input) {
		let url;
		if (typeof input === 'string') url = input;
		else if (input instanceof URL) url = input.href;
		else if (typeof Request !== 'undefined' && input instanceof Request) url = input.url;
		else return '';
		try {
			return new URL(url, globalThis.document?.baseURI ?? globalThis.location?.href).href;
		} catch (e) {
			return url;
		}
	};

	// The upper-cased HTTP method of a fetch() call: init.method, else the Request's, else GET.
	net.getFetchMethod ??= function (input, init) {
		const method = init?.method
			?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
		return String(method).toUpperCase();
	};

	// ======== claude.ai API URLs ========

	// { orgId, conversationId } from an API URL (/organizations/<id>/chat_conversations/<id>/...).
	// Either is null when the URL doesn't have it.
	net.getApiIds ??= function (url) {
		const path = String(url).split('?')[0];
		return {
			orgId: path.match(/\/organizations\/([^/]+)/)?.[1] ?? null,
			conversationId: path.match(/\/chat_conversations\/([^/]+)/)?.[1] ?? null,
		};
	};

	// Whether a URL is a message send (.../completion). With { retry: true }, also a regenerate
	// (.../retry_completion). The retry choice is explicit because callers differ on purpose.
	net.isCompletionUrl ??= function (url, { retry = false } = {}) {
		const path = String(url).split('?')[0];
		return path.endsWith('/completion') || (retry && path.endsWith('/retry_completion'));
	};

	// ======== rebuilt responses ========

	// A response's headers, minus the ones that describe the original body's encoding and length.
	// fetch() has already decoded the body by the time we read it, so a rebuilt response that kept
	// content-encoding would claim a compression its body no longer has.
	net.sanitizedHeaders ??= function (response) {
		const headers = new Headers(response.headers);
		headers.delete('content-encoding');
		headers.delete('content-length');
		headers.delete('transfer-encoding');
		return headers;
	};

	// A copy of response carrying `data` as its JSON body.
	net.jsonResponse ??= function (response, data) {
		return new Response(JSON.stringify(data), {
			status: response.status,
			statusText: response.statusText,
			headers: net.sanitizedHeaders(response),
		});
	};

	// ======== request bodies ========

	// claude.ai gzips some request bodies itself (Content-Encoding: gzip, body is bytes, not a string).
	net.isGzipRequest ??= function (init) {
		return new Headers(init?.headers || {}).get('content-encoding')?.toLowerCase() === 'gzip';
	};

	// Parse a fetch init's JSON body, whether it's a string or (gzipped) bytes.
	net.readJsonRequestBody ??= async function (init) {
		const body = init?.body;
		if (typeof body === 'string') return JSON.parse(body);
		let stream = new Response(body).body;
		if (net.isGzipRequest(init)) stream = stream.pipeThrough(new DecompressionStream('gzip'));
		return JSON.parse(await new Response(stream).text());
	};

	// A copy of init with `data` as its body, in the same encoding (plain or gzip) the original used.
	net.withJsonRequestBody ??= async function (init, data) {
		const json = JSON.stringify(data);
		if (!net.isGzipRequest(init)) return { ...init, body: json };
		const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
		return { ...init, body: await new Response(compressed).arrayBuffer() };
	};

	// Whether bytes start with the gzip magic number.
	net.isGzipBytes ??= function (bytes) {
		return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	};

	// Inflate gzipped bytes. DecompressionStream only knows gzip/deflate, not br or zstd.
	net.gunzipBytes ??= async function (bytes) {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	};

	// ======== SSE ========

	// One SSE event: { raw, event, dataText, data }. `raw` is the event's text without the blank line
	// that ended it; `data` is the data: lines parsed as JSON (null if absent or not JSON), parsed on
	// first access so callers that only look at `raw` don't pay for it.
	function parseSseEvent(raw) {
		let event = null;
		const dataLines = [];
		for (const line of raw.split(/\r?\n/)) {
			if (line.startsWith('data:')) dataLines.push(line.slice(line[5] === ' ' ? 6 : 5));
			else if (line.startsWith('event:')) event = line.slice(6).trim();
		}
		const dataText = dataLines.length ? dataLines.join('\n') : null;
		let parsed;
		return {
			raw,
			event,
			dataText,
			get data() {
				if (parsed === undefined) {
					try {
						parsed = dataText === null ? null : JSON.parse(dataText);
					} catch (e) {
						parsed = null;
					}
				}
				return parsed;
			},
		};
	}

	// Incremental SSE splitting for code that drives its own reader: push() decoded text and get
	// back the events it completed; flush() returns whatever is left once the stream ends. Events
	// end at a blank line (\n\n or \r\n\r\n), so one straddling two chunks is still whole.
	net.createSseSplitter ??= function () {
		let buffer = '';
		const boundary = /\r?\n\r?\n/;
		return {
			push(text) {
				buffer += text;
				const events = [];
				let match;
				while ((match = boundary.exec(buffer))) {
					events.push(parseSseEvent(buffer.slice(0, match.index)));
					buffer = buffer.slice(match.index + match[0].length);
				}
				return events;
			},
			flush() {
				const rest = buffer;
				buffer = '';
				return rest.trim() ? [parseSseEvent(rest)] : [];
			},
			get bufferedChars() {
				return buffer.length;
			},
		};
	};

	// Read an SSE body (a Response or a ReadableStream) to the end, calling onEvent for every event.
	// Return false from onEvent to stop early: the stream is cancelled (not awaited), so a clone or tee branch stops
	// buffering the rest of the body. Also stops (and cancels) if a single unfinished event grows past
	// maxBufferedChars. Resolves true if the stream was read to the end, false if it stopped early.
	// Stream errors (an aborted request) reject, after the events that did arrive were delivered.
	net.readSseEvents ??= async function (source, onEvent, { maxBufferedChars = Infinity } = {}) {
		const reader = (typeof Response !== 'undefined' && source instanceof Response ? source.body : source).getReader();
		const decoder = new TextDecoder();
		const splitter = net.createSseSplitter();
		// Cancel without waiting: on a clone() or tee branch the cancel only settles once the other
		// branch finishes too, which for a live completion is the end of the whole reply.
		const stop = () => { reader.cancel().catch(() => { }); };
		try {
			for (;;) {
				const { done, value } = await reader.read();
				const events = done
					? [...splitter.push(decoder.decode()), ...splitter.flush()]
					: splitter.push(decoder.decode(value, { stream: true }));
				for (const event of events) {
					if (onEvent(event) === false) {
						stop();
						return false;
					}
				}
				if (done) return true;
				if (splitter.bufferedChars > maxBufferedChars) {
					stop();
					return false;
				}
			}
		} finally {
			reader.releaseLock();
		}
	};

	// ======== misc ========

	// Whether a localStorage kill switch is set ('1'). False if storage is unavailable.
	net.isKillSwitchOn ??= function (key) {
		try {
			return globalThis.localStorage?.getItem(key) === '1';
		} catch (e) {
			return false;
		}
	};
})();
