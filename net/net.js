// net.js (claude-ext-common)
// Helpers for code that intercepts claude.ai's requests: fetch arguments, API URLs, rebuilt
// responses, gzipped request bodies, SSE streams, and the bard API's Connect-RPC frames and protobuf
// messages (decodeBard needs net/bard-schema.js loaded too).
//
// Unlike the rest of common, this is an IIFE that publishes into ONE namespace, globalThis.ClaudeExtNet.
// Every extension may load it into the shared MAIN world (and the tracker's background imports it too),
// so it is versioned and the NEWEST copy wins, whatever the load order: it replaces the members of an
// older copy on the same object (callers keep a reference to the object, and look members up at call
// time), and an older copy loading after it leaves everything alone. So:
// - bump VERSION with every change to this file;
// - an older extension runs your members: fix and extend them, but never remove one or change its
//   parameters or what it returns in a way an older caller would trip over.
(function () {
	'use strict';

	const VERSION = 3; // 1: the unversioned first release, which filled members with ??=; 3: bard decoding

	const existing = globalThis.ClaudeExtNet;
	if (existing && (existing.VERSION ?? 1) >= VERSION) return;
	const net = existing ?? (globalThis.ClaudeExtNet = {});
	net.VERSION = VERSION;

	// ======== fetch arguments ========

	// The absolute URL of a fetch() input (string, URL or Request). Relative URLs resolve the way
	// fetch() resolves them: against the document's base URL, so 'api/x' on /chat/123 is
	// /chat/api/x. '' for anything else.
	net.getFetchUrl = function (input) {
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
	net.getFetchMethod = function (input, init) {
		const method = init?.method
			?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
		return String(method).toUpperCase();
	};

	// ======== claude.ai API URLs ========

	// { orgId, conversationId } from an API URL (/organizations/<id>/chat_conversations/<id>/...).
	// Either is null when the URL doesn't have it.
	net.getApiIds = function (url) {
		const path = String(url).split('?')[0];
		return {
			orgId: path.match(/\/organizations\/([^/]+)/)?.[1] ?? null,
			conversationId: path.match(/\/chat_conversations\/([^/]+)/)?.[1] ?? null,
		};
	};

	// Whether a URL is a message send (.../completion). With { retry: true }, also a regenerate
	// (.../retry_completion). The retry choice is explicit because callers differ on purpose.
	net.isCompletionUrl = function (url, { retry = false } = {}) {
		const path = String(url).split('?')[0];
		return path.endsWith('/completion') || (retry && path.endsWith('/retry_completion'));
	};

	// ======== rebuilt responses ========

	// A response's headers, minus the ones that describe the original body's encoding and length.
	// fetch() has already decoded the body by the time we read it, so a rebuilt response that kept
	// content-encoding would claim a compression its body no longer has.
	net.sanitizedHeaders = function (response) {
		const headers = new Headers(response.headers);
		headers.delete('content-encoding');
		headers.delete('content-length');
		headers.delete('transfer-encoding');
		return headers;
	};

	// A copy of response carrying `data` as its JSON body.
	net.jsonResponse = function (response, data) {
		return new Response(JSON.stringify(data), {
			status: response.status,
			statusText: response.statusText,
			headers: net.sanitizedHeaders(response),
		});
	};

	// ======== request bodies ========

	// claude.ai gzips some request bodies itself (Content-Encoding: gzip, body is bytes, not a string).
	net.isGzipRequest = function (init) {
		return new Headers(init?.headers || {}).get('content-encoding')?.toLowerCase() === 'gzip';
	};

	// Parse a fetch init's JSON body, whether it's a string or (gzipped) bytes.
	net.readJsonRequestBody = async function (init) {
		const body = init?.body;
		if (typeof body === 'string') return JSON.parse(body);
		let stream = new Response(body).body;
		if (net.isGzipRequest(init)) stream = stream.pipeThrough(new DecompressionStream('gzip'));
		return JSON.parse(await new Response(stream).text());
	};

	// A copy of init with `data` as its body, in the same encoding (plain or gzip) the original used.
	net.withJsonRequestBody = async function (init, data) {
		const json = JSON.stringify(data);
		if (!net.isGzipRequest(init)) return { ...init, body: json };
		const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
		return { ...init, body: await new Response(compressed).arrayBuffer() };
	};

	// Whether bytes start with the gzip magic number.
	net.isGzipBytes = function (bytes) {
		return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	};

	// Inflate gzipped bytes. DecompressionStream only knows gzip/deflate, not br or zstd.
	net.gunzipBytes = async function (bytes) {
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
	net.createSseSplitter = function () {
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
	net.readSseEvents = async function (source, onEvent, { maxBufferedChars = Infinity } = {}) {
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

	// ======== Connect-RPC frames ========

	// Connect streaming bodies (application/connect+proto) are a run of frames:
	// flags(1) + length(4, big-endian) + payload. Flag 0x01 = gzipped payload, 0x02 = end of stream
	// (the payload is JSON trailers). Unary calls (application/proto) are one bare message instead.
	const FRAME_GZIP = 0x01;
	const FRAME_END = 0x02;
	const frameLength = (b, i) => ((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]) >>> 0;

	// The frames of an already-complete buffer (a framed request body, a captured response), as
	// { flags, payload }. Payloads are NOT gunzipped (that's async: see gunzipBytes); a truncated last
	// frame is dropped.
	net.splitConnectFrames = function (bytes) {
		const frames = [];
		let i = 0;
		while (i + 5 <= bytes.length) {
			const len = frameLength(bytes, i);
			if (i + 5 + len > bytes.length) break;
			frames.push({ flags: bytes[i], payload: bytes.subarray(i + 5, i + 5 + len) });
			i += 5 + len;
		}
		return frames;
	};

	// Read a Connect streaming body (a Response or a ReadableStream) to the end, calling onFrame for
	// every frame with { endStream, payload, trailers }: payload already gunzipped; for the end-of-stream
	// frame, trailers is its parsed JSON ({} if unparseable), otherwise null. Frames split across chunks
	// are reassembled. Return false from onFrame to stop early; a frame longer than maxFrameBytes stops
	// it too. Both cancel the stream without waiting (see readSseEvents) and resolve false. Resolves true
	// at the end of the stream. Stream errors reject, after the frames that did arrive were delivered.
	net.readConnectFrames = async function (source, onFrame, { maxFrameBytes = Infinity } = {}) {
		const reader = (typeof Response !== 'undefined' && source instanceof Response ? source.body : source).getReader();
		const stop = () => { reader.cancel().catch(() => { }); };
		let buffer = new Uint8Array(0);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return true;
				if (buffer.length) {
					const joined = new Uint8Array(buffer.length + value.length);
					joined.set(buffer);
					joined.set(value, buffer.length);
					buffer = joined;
				} else {
					buffer = value;
				}
				let i = 0;
				while (i + 5 <= buffer.length) {
					const flags = buffer[i];
					const len = frameLength(buffer, i);
					if (len > maxFrameBytes) {
						stop();
						return false;
					}
					if (i + 5 + len > buffer.length) break;
					const raw = buffer.slice(i + 5, i + 5 + len);
					i += 5 + len;
					const payload = flags & FRAME_GZIP ? await net.gunzipBytes(raw) : raw;
					let trailers = null;
					if (flags & FRAME_END) {
						try {
							trailers = payload.length ? JSON.parse(new TextDecoder().decode(payload)) : {};
						} catch (e) {
							trailers = {};
						}
					}
					if (onFrame({ endStream: !!(flags & FRAME_END), payload, trailers }) === false) {
						stop();
						return false;
					}
				}
				if (i) buffer = buffer.slice(i);
			}
		} finally {
			reader.releaseLock();
		}
	};

	// ======== protobuf decoding (bard API) ========

	// decodeBard(typeName, bytes): decode a bard API message (claude.ai's merged experience,
	// anthropic.bard.api.v1alpha) into a plain object shaped like protobuf-es's
	// toJson(..., { useProtoFieldName: true }), the format scripts/bard/decode-capture.mjs prints:
	// - proto field names; unset fields, and zero/empty fields without explicit presence, are left out;
	//   oneof members appear as plain fields;
	// - enums as value names (an unknown value as its number); 64-bit integers as decimal strings;
	//   bytes as base64; NaN/±Infinity floats as strings;
	// - Timestamp as RFC 3339, Duration as "1.5s", Struct/Value/ListValue as plain JSON, wrappers as
	//   their bare value, FieldMask as comma-joined camelCase paths, Any as { "@type", ...fields }
	//   (a well-known type's JSON goes in "value"; a type the table lacks keeps its bytes as base64
	//   "value").
	// typeName is a full name or one relative to anthropic.bard.api.v1alpha ('StreamEvent'). The schema
	// is net/bard-schema.js (globalThis.ClaudeExtBardSchema), looked up at call time; throws if it isn't
	// loaded, the type is unknown, or the bytes are malformed.
	net.decodeBard = function (typeName, bytes) {
		const schema = bardSchema();
		const index = schema.byName.get(typeName) ?? schema.byName.get(schema.prefix + typeName);
		if (index === undefined || schema.types[index][1] !== 'm') throw new Error(`decodeBard: unknown message type ${typeName}`);
		return readMessage(schema, index, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
	};

	// Name -> index (and per-type field maps), rebuilt whenever a newer schema copy replaced the table.
	let schemaCache = null;
	function bardSchema() {
		const table = globalThis.ClaudeExtBardSchema;
		if (!table) throw new Error('decodeBard: net/bard-schema.js is not loaded');
		if (schemaCache?.table !== table) {
			const names = table.types.map(t => (t[0][0] === '.' ? table.prefix + t[0].slice(1) : t[0]));
			schemaCache = {
				table,
				types: table.types,
				prefix: table.prefix,
				names,
				byName: new Map(names.map((n, i) => [n, i])),
				fieldMaps: new Map(),
			};
		}
		return schemaCache;
	}

	// ScalarType numbers (descriptor.proto's FieldDescriptorProto.Type).
	const T = { DOUBLE: 1, FLOAT: 2, INT64: 3, UINT64: 4, INT32: 5, FIXED64: 6, FIXED32: 7, BOOL: 8, STRING: 9, BYTES: 12, UINT32: 13, SFIXED32: 15, SFIXED64: 16, SINT32: 17, SINT64: 18 };
	const INT64_TYPES = [T.INT64, T.UINT64, T.SINT64, T.FIXED64, T.SFIXED64];
	const utf8 = new TextDecoder();

	function scalarZero(type) {
		if (type === T.STRING) return '';
		if (type === T.BOOL) return false;
		if (type === T.BYTES) return new Uint8Array(0);
		return INT64_TYPES.includes(type) ? '0' : 0;
	}

	// A cursor over protobuf wire bytes.
	function cursor(bytes) {
		return { bytes, pos: 0, end: bytes.length, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
	}

	function need(c, n) {
		if (c.pos + n > c.end) throw new Error('decodeBard: truncated message');
	}

	// A varint as [lo, hi] unsigned 32-bit halves.
	function varint64(c) {
		let lo = 0, hi = 0, shift = 0, b;
		do {
			need(c, 1);
			b = c.bytes[c.pos++];
			if (shift < 28) lo |= (b & 0x7f) << shift;
			else if (shift === 28) {
				lo |= (b & 0x0f) << 28;
				hi |= (b & 0x7f) >> 4;
			} else hi |= (b & 0x7f) << (shift - 32);
			shift += 7;
		} while (b & 0x80 && shift < 70);
		return [lo >>> 0, hi >>> 0];
	}
	const varint32 = (c) => varint64(c)[0];
	const u64 = (lo, hi) => (BigInt(hi) << 32n) | BigInt(lo);

	function lengthDelimited(c) {
		const len = varint32(c);
		need(c, len);
		const out = c.bytes.subarray(c.pos, c.pos + len);
		c.pos += len;
		return out;
	}

	function readScalar(c, type) {
		switch (type) {
			case T.INT32: return varint32(c) | 0;
			case T.UINT32: return varint32(c);
			case T.SINT32: { const n = varint32(c); return (n >>> 1) ^ -(n & 1); }
			case T.BOOL: { const [lo, hi] = varint64(c); return lo !== 0 || hi !== 0; }
			case T.INT64: { const [lo, hi] = varint64(c); return BigInt.asIntN(64, u64(lo, hi)).toString(); }
			case T.UINT64: { const [lo, hi] = varint64(c); return u64(lo, hi).toString(); }
			case T.SINT64: { const [lo, hi] = varint64(c); const n = u64(lo, hi); return ((n >> 1n) ^ -(n & 1n)).toString(); }
			case T.STRING: return utf8.decode(lengthDelimited(c));
			case T.BYTES: return lengthDelimited(c);
		}
		const size = type === T.DOUBLE || type === T.FIXED64 || type === T.SFIXED64 ? 8 : 4;
		need(c, size);
		const at = c.pos;
		c.pos += size;
		switch (type) {
			case T.FIXED32: return c.view.getUint32(at, true);
			case T.SFIXED32: return c.view.getInt32(at, true);
			case T.FLOAT: return c.view.getFloat32(at, true);
			case T.FIXED64: return c.view.getBigUint64(at, true).toString();
			case T.SFIXED64: return c.view.getBigInt64(at, true).toString();
			case T.DOUBLE: return c.view.getFloat64(at, true);
		}
		throw new Error(`decodeBard: unsupported scalar type ${type}`);
	}

	function skipField(c, wireType) {
		switch (wireType) {
			case 0: varint64(c); return;
			case 1: need(c, 8); c.pos += 8; return;
			case 2: lengthDelimited(c); return;
			case 5: need(c, 4); c.pos += 4; return;
			case 3: // a group: skip to its end tag
				for (;;) {
					const tag = varint32(c);
					if ((tag & 7) === 4) return;
					skipField(c, tag & 7);
				}
		}
		throw new Error(`decodeBard: bad wire type ${wireType}`);
	}

	function fieldMap(schema, typeIndex) {
		let map = schema.fieldMaps.get(typeIndex);
		if (!map) {
			map = new Map(schema.types[typeIndex][2].map(f => [f[0], f]));
			schema.fieldMaps.set(typeIndex, map);
		}
		return map;
	}

	// Raw field values, before JSON conversion: Map(field entry -> value). Scalars as JS values (bytes
	// as Uint8Array, 64-bit as strings), enums as numbers. Message values are arrays of byte slices: a
	// singular message seen twice is merged by decoding the concatenation (protobuf's merge semantics);
	// for repeated messages and map entries each element is its own one-slice array.
	function readRaw(schema, typeIndex, bytes) {
		const byNumber = fieldMap(schema, typeIndex);
		const values = new Map();
		const oneofCase = new Map();
		const list = (f) => {
			let l = values.get(f);
			if (!l) values.set(f, (l = []));
			return l;
		};
		const c = cursor(bytes);
		while (c.pos < c.end) {
			const tag = varint32(c);
			const f = byNumber.get(tag >>> 3);
			if (!f) {
				skipField(c, tag & 7);
				continue;
			}
			const [, , kind, ref, flags, oneof] = f;
			const repeated = flags & 1;
			if (oneof !== undefined) {
				const previous = oneofCase.get(oneof);
				if (previous && previous !== f) values.delete(previous);
				oneofCase.set(oneof, f);
			}
			if (kind === 'm' || kind === 'M') {
				const slice = lengthDelimited(c);
				if (repeated || kind === 'M') list(f).push([slice]);
				else list(f).push(slice);
				continue;
			}
			const type = kind === 'e' ? T.INT32 : ref;
			// Numeric repeated fields may come packed (one length-delimited run) or one value per tag.
			if (repeated && (tag & 7) === 2 && type !== T.STRING && type !== T.BYTES) {
				const run = cursor(lengthDelimited(c));
				const l = list(f);
				while (run.pos < run.end) l.push(readScalar(run, type));
				continue;
			}
			const value = readScalar(c, type);
			if (repeated) list(f).push(value);
			else values.set(f, value);
		}
		return values;
	}

	// Map and Struct keys are data: a plain assignment of '__proto__' would hit the prototype setter
	// (dropping the entry, or replacing the object's prototype) instead of adding a property.
	function setOwn(obj, key, value) {
		Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
	}

	function concat(slices) {
		if (slices.length === 1) return slices[0];
		const out = new Uint8Array(slices.reduce((n, s) => n + s.length, 0));
		let at = 0;
		for (const s of slices) {
			out.set(s, at);
			at += s.length;
		}
		return out;
	}

	function base64(bytes) {
		let s = '';
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s);
	}

	function enumJson(schema, enumIndex, number) {
		if (schema.names[enumIndex] === 'google.protobuf.NullValue') return null;
		return schema.types[enumIndex][2][number] ?? number;
	}

	function scalarJson(type, value) {
		if (type === T.BYTES) return base64(value);
		if (type === T.FLOAT || type === T.DOUBLE) {
			if (Number.isNaN(value)) return 'NaN';
			if (value === Infinity) return 'Infinity';
			if (value === -Infinity) return '-Infinity';
		}
		return value;
	}

	function isZero(schema, kind, ref, value) {
		if (kind === 'e') return value === schema.types[ref][3];
		if (ref === T.BYTES) return value.length === 0;
		if (ref === T.FLOAT || ref === T.DOUBLE) return Object.is(value, 0);
		return value === scalarZero(ref);
	}

	function valueJson(schema, kind, ref, value) {
		if (kind === 'e') return enumJson(schema, ref, value);
		if (kind === 'm') return readMessage(schema, ref, concat(value));
		return scalarJson(ref, value);
	}

	function readMessage(schema, typeIndex, bytes) {
		const name = schema.names[typeIndex];
		if (name.startsWith('google.protobuf.')) {
			const wkt = readWkt(schema, typeIndex, name, bytes);
			if (wkt !== undefined) return wkt.json;
		}
		const values = readRaw(schema, typeIndex, bytes);
		const json = {};
		for (const f of schema.types[typeIndex][2]) {
			if (!values.has(f)) continue;
			const [, fieldName, kind, ref, flags] = f;
			const value = values.get(f);
			if (kind === 'M') {
				const map = {};
				for (const [slice] of value) {
					const entry = readMapEntry(schema, ref, slice);
					setOwn(map, entry.key, entry.value);
				}
				json[fieldName] = map;
			} else if (flags & 1) {
				json[fieldName] = value.map(v => valueJson(schema, kind, ref, v));
			} else if (kind === 'm' || flags & 2 || !isZero(schema, kind, ref, value)) {
				json[fieldName] = valueJson(schema, kind, ref, value);
			}
		}
		return json;
	}

	// A map entry: key = 1, value = 2; a missing one takes its zero value.
	function readMapEntry(schema, [keyType, valueKind, valueRef], bytes) {
		const c = cursor(bytes);
		let key = scalarZero(keyType), value, slices = [];
		while (c.pos < c.end) {
			const tag = varint32(c);
			if (tag >>> 3 === 1) key = readScalar(c, keyType);
			else if (tag >>> 3 === 2 && valueKind === 'm') slices.push(lengthDelimited(c));
			else if (tag >>> 3 === 2) value = readScalar(c, valueKind === 'e' ? T.INT32 : valueRef);
			else skipField(c, tag & 7);
		}
		let json;
		if (valueKind === 'm') json = readMessage(schema, valueRef, concat(slices.length ? slices : [new Uint8Array(0)]));
		else if (valueKind === 'e') json = enumJson(schema, valueRef, value ?? 0);
		else json = scalarJson(valueRef, value ?? scalarZero(valueRef));
		return { key: String(key), value: json };
	}

	const WRAPPERS = {
		'google.protobuf.DoubleValue': T.DOUBLE,
		'google.protobuf.FloatValue': T.FLOAT,
		'google.protobuf.Int64Value': T.INT64,
		'google.protobuf.UInt64Value': T.UINT64,
		'google.protobuf.Int32Value': T.INT32,
		'google.protobuf.UInt32Value': T.UINT32,
		'google.protobuf.BoolValue': T.BOOL,
		'google.protobuf.StringValue': T.STRING,
		'google.protobuf.BytesValue': T.BYTES,
	};
	const CUSTOM_JSON = new Set([
		'google.protobuf.Any', 'google.protobuf.Timestamp', 'google.protobuf.Duration', 'google.protobuf.FieldMask',
		'google.protobuf.Struct', 'google.protobuf.Value', 'google.protobuf.ListValue', ...Object.keys(WRAPPERS),
	]);

	// Fractional seconds the way protobuf JSON writes them: 3, 6 or 9 digits.
	function nanosText(nanos) {
		const n = String(nanos).padStart(9, '0');
		return n.slice(3) === '000000' ? n.slice(0, 3) : n.slice(6) === '000' ? n.slice(0, 6) : n;
	}

	// Well-known types with their own JSON form: { json }, or undefined for a plain message.
	function readWkt(schema, typeIndex, name, bytes) {
		if (!CUSTOM_JSON.has(name)) return undefined;
		const fields = {};
		for (const [f, v] of readRaw(schema, typeIndex, bytes)) fields[f[1]] = v;
		if (name in WRAPPERS) return { json: scalarJson(WRAPPERS[name], fields.value ?? scalarZero(WRAPPERS[name])) };
		switch (name) {
			case 'google.protobuf.Timestamp': {
				const { seconds = '0', nanos = 0 } = fields;
				const z = nanos > 0 ? '.' + nanosText(nanos) + 'Z' : 'Z';
				return { json: new Date(Number(seconds) * 1000).toISOString().replace('.000Z', z) };
			}
			case 'google.protobuf.Duration': {
				const { seconds = '0', nanos = 0 } = fields;
				let text = String(seconds);
				if (nanos !== 0) {
					text += '.' + nanosText(Math.abs(nanos));
					if (nanos < 0 && Number(seconds) === 0) text = '-' + text;
				}
				return { json: text + 's' };
			}
			case 'google.protobuf.FieldMask':
				return { json: (fields.paths ?? []).map(p => p.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase())).join(',') };
			case 'google.protobuf.Struct': {
				const json = {};
				for (const [slice] of fields.fields ?? []) {
					const entry = readMapEntry(schema, [T.STRING, 'm', typeIndexOf(schema, 'google.protobuf.Value')], slice);
					setOwn(json, entry.key, entry.value);
				}
				return { json };
			}
			case 'google.protobuf.ListValue':
				return { json: (fields.values ?? []).map(slices => readMessage(schema, typeIndexOf(schema, 'google.protobuf.Value'), concat(slices))) };
			case 'google.protobuf.Value': {
				if ('null_value' in fields) return { json: null };
				if ('number_value' in fields) return { json: fields.number_value };
				if ('string_value' in fields) return { json: fields.string_value };
				if ('bool_value' in fields) return { json: fields.bool_value };
				if ('struct_value' in fields) return { json: readMessage(schema, typeIndexOf(schema, 'google.protobuf.Struct'), concat(fields.struct_value)) };
				if ('list_value' in fields) return { json: readMessage(schema, typeIndexOf(schema, 'google.protobuf.ListValue'), concat(fields.list_value)) };
				throw new Error('decodeBard: google.protobuf.Value must have a value');
			}
			case 'google.protobuf.Any': {
				const typeUrl = fields.type_url ?? '';
				if (!typeUrl) return { json: {} };
				const value = fields.value ?? new Uint8Array(0);
				const inner = schema.byName.get(typeUrl.slice(typeUrl.lastIndexOf('/') + 1));
				if (inner === undefined || schema.types[inner][1] !== 'm') return { json: { '@type': typeUrl, value: base64(value) } };
				const decoded = readMessage(schema, inner, value);
				const json = CUSTOM_JSON.has(schema.names[inner]) ? { value: decoded } : decoded;
				json['@type'] = typeUrl;
				return { json };
			}
		}
		return undefined;
	}

	function typeIndexOf(schema, name) {
		const index = schema.byName.get(name);
		if (index === undefined) throw new Error(`decodeBard: ${name} missing from the schema`);
		return index;
	}

	// ======== misc ========

	// Whether a localStorage kill switch is set ('1'). False if storage is unavailable.
	net.isKillSwitchOn = function (key) {
		try {
			return globalThis.localStorage?.getItem(key) === '1';
		} catch (e) {
			return false;
		}
	};
})();
