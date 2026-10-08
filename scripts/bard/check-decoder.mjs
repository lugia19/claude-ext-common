// check-decoder.mjs (claude-ext-common)
// Regression test for net/net.js's bard decoding, encoding and Connect frame handling against
// protobuf-es. Sections 1, 2, 4 and 5 run over every capture in captures/ (gitignored, so against
// whatever you've captured locally; with none they're skipped with a warning); 3, 6 and 7 always run:
//
//   node scripts/bard/check-decoder.mjs [capture.json ...]
//
// 1. decodeBard() output must deep-equal protobuf-es toJson(useProtoFieldName) for every captured
//    RPC request, unary response and stream frame (net/bard-schema.js as the schema).
// 2. readConnectFrames() must yield the same frames as a whole-buffer split, with the stream cut
//    into random chunks (including mid-header), honour an early `false`, and parse end-stream
//    trailers.
// 4. Round trip: encodeBard(decodeBard(x, { keepUnknown: true })) must mean the same as x, to
//    protobuf-es and to decodeBard ($unknown included).
// 5. Drift: decoded and re-encoded under a schema missing a third of its fields, every captured
//    message must still decode (under the full schema) exactly like the original: fields we don't
//    know survive as $unknown.
// 6. Synthetic fixtures built with protobuf-es for every field kind the schema uses (well-known
//    types, Any, maps, oneofs, explicit presence, packed enums, bytes, 64-bit, NaN, unknown enum
//    values and fields) must round-trip; encodeBard must build messages from scratch, merge when
//    appended, and throw on unknown fields and double oneofs.
// 7. encodeConnectFrame and rewriteConnectStream: byte-identical pass-through, replaced / split /
//    dropped frames, inject() while the source is idle, fail-open on a throwing onFrame,
//    cancellation.
// 3. Load order: an older net.js or bard-schema.js loading after the current one changes nothing.
// Exits non-zero on any failure.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import util from 'node:util';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { loadRegistry } from './registry.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '../..');
const load = (file) => vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
load('net/bard-schema.js');
load('net/net.js');
const net = globalThis.ClaudeExtNet;

const { registry } = loadRegistry();
let failures = 0;
const fail = (msg) => {
	failures++;
	if (failures <= 20) console.log('FAIL', msg);
};

function methodOf(url) {
	const m = /\/claudeai-rpc\/([\w.]+)\/(\w+)/.exec(url ?? '');
	return m && registry.getService(m[1])?.methods.find(x => x.name === m[2]);
}

// ---- 1. decodeBard vs protobuf-es ----
const stats = { compared: 0, skipped: 0, notInTable: new Set(), byType: {} };
const captured = []; // { schema, bytes, where } for every compared message, reused by sections 4-5
const inTable = new Set(globalThis.ClaudeExtBardSchema.types.map(t => (t[0][0] === '.' ? globalThis.ClaudeExtBardSchema.prefix + t[0].slice(1) : t[0])));
function compare(schema, bytes, where) {
	if (!inTable.has(schema.typeName)) {
		stats.notInTable.add(schema.typeName.split('.').pop()); // a call gen-schema.mjs's ROOTS don't cover
		return;
	}
	let expected;
	try {
		expected = toJson(schema, fromBinary(schema, bytes), { registry, useProtoFieldName: true });
	} catch (e) {
		stats.skipped++; // protobuf-es itself can't render it (an Any type outside its registry)
		return;
	}
	let actual;
	try {
		actual = net.decodeBard(schema.typeName, bytes);
	} catch (e) {
		fail(`${where} ${schema.typeName}: threw ${e.message}`);
		return;
	}
	stats.compared++;
	if (!where.startsWith('synthetic')) captured.push({ schema, bytes, where });
	stats.byType[schema.typeName.split('.').pop()] = (stats.byType[schema.typeName.split('.').pop()] ?? 0) + 1;
	if (!util.isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)))) {
		fail(`${where} ${schema.typeName}: output differs\n  first difference: ${firstDiff(actual, expected)}`);
	}
}

function firstDiff(a, b, at = '$') {
	if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== 'object') {
		return util.isDeepStrictEqual(a, b) ? null : `${at}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
	}
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const d = firstDiff(a[k], b[k], `${at}.${k}`);
		if (d) return d;
	}
	return null;
}

const captureDir = path.join(here, 'captures');
const files = process.argv.slice(2).length
	? process.argv.slice(2)
	: fs.existsSync(captureDir)
		? fs.readdirSync(captureDir).filter(f => f.endsWith('.json') && !f.includes('decoded')).map(f => path.join(captureDir, f))
		: [];
const streams = [];
for (const file of files) {
	let records;
	try {
		records = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (typeof records === 'string') records = JSON.parse(records);
	} catch (e) {
		continue;
	}
	if (!Array.isArray(records)) continue;
	for (const [i, r] of records.entries()) {
		const method = methodOf(r.url);
		if (!method || r.truncated) continue;
		const where = `${path.basename(file)}#${i}`;
		const req = new Uint8Array(Buffer.from(r.reqB64 ?? '', 'base64'));
		if ((r.reqCT ?? '').includes('connect+')) {
			for (const f of net.splitConnectFrames(req)) if (!(f.flags & 2)) compare(method.input, f.flags & 1 ? zlib.gunzipSync(f.payload) : f.payload, where + ' req');
		} else {
			compare(method.input, req, where + ' req');
		}
		const resp = new Uint8Array(Buffer.concat((r.chunks ?? []).map(c => Buffer.from(c.b, 'base64'))));
		if ((r.respCT ?? '').includes('connect+')) {
			streams.push({ where, method, resp });
			for (const f of net.splitConnectFrames(resp)) if (!(f.flags & 2)) compare(method.output, f.flags & 1 ? zlib.gunzipSync(f.payload) : f.payload, where + ' frame');
		} else if (resp.length && r.status === 200) {
			compare(method.output, resp, where + ' resp');
		}
	}
}
console.log(`decodeBard: ${stats.compared} messages compared, ${stats.skipped} skipped (unrenderable by protobuf-es)`, stats.byType);
if (stats.notInTable.size) console.log(`  not in bard-schema.js (outside ROOTS): ${[...stats.notInTable].join(', ')}`);
if (!stats.compared) console.log('WARN no captured messages: sections 1, 2, 4 and 5 had nothing to check (capture some into captures/)');

// Synthetic: map and Struct keys are data, so '__proto__' must come out as an ordinary own key.
const own = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
const synthetic = [];
{
	const schema = registry.getMessage('anthropic.bard.api.v1alpha.McpToolSettings');
	const msg = create(schema);
	own(msg.tools, '__proto__', true);
	msg.tools.other = false;
	synthetic.push([schema, msg]);
}
{
	const schema = registry.getMessage('anthropic.bard.api.v1alpha.MessageLimit');
	const window = registry.getMessage('anthropic.bard.api.v1alpha.MessageLimitWindow');
	const msg = create(schema);
	own(msg.windows, '__proto__', create(window));
	synthetic.push([schema, msg]);
}
if (inTable.has('google.protobuf.Struct')) {
	const schema = registry.getMessage('google.protobuf.Struct');
	const value = registry.getMessage('google.protobuf.Value');
	const msg = create(schema);
	own(msg.fields, '__proto__', create(value, { kind: { case: 'stringValue', value: 'x' } }));
	synthetic.push([schema, msg]);
}
for (const [schema, msg] of synthetic) {
	const bytes = toBinary(schema, msg);
	compare(schema, bytes, 'synthetic __proto__');
	const decoded = net.decodeBard(schema.typeName, bytes);
	const map = decoded.tools ?? decoded.windows ?? decoded;
	if (!Object.prototype.hasOwnProperty.call(map, '__proto__') || Object.getPrototypeOf(map) !== Object.prototype) {
		fail(`synthetic ${schema.typeName}: '__proto__' key not kept as an own property`);
	}
}
console.log(`synthetic __proto__ keys: ${synthetic.length} messages`);

// ---- 2. readConnectFrames ----
function chunked(bytes, seed) {
	let s = seed;
	const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const parts = [];
	for (let i = 0; i < bytes.length;) {
		const n = Math.max(1, Math.floor(rand() * 64) + (rand() < 0.1 ? 4096 : 0));
		parts.push(bytes.slice(i, i + n));
		i += n;
	}
	return new ReadableStream({
		start(controller) {
			for (const p of parts) controller.enqueue(p);
			controller.close();
		},
	});
}
let framesChecked = 0;
for (const [n, { where, resp }] of streams.entries()) {
	const expected = net.splitConnectFrames(resp).map(f => ({
		endStream: !!(f.flags & 2),
		payload: Buffer.from(f.flags & 1 ? zlib.gunzipSync(f.payload) : f.payload).toString('base64'),
	}));
	const got = [];
	const complete = await net.readConnectFrames(chunked(resp, n + 1), (f) => {
		got.push({ endStream: f.endStream, payload: Buffer.from(f.payload).toString('base64') });
		if (f.endStream && (typeof f.trailers !== 'object' || f.trailers === null)) fail(`${where}: end-stream trailers not an object`);
	});
	framesChecked += got.length;
	if (!complete) fail(`${where}: readConnectFrames resolved false on a full stream`);
	if (!util.isDeepStrictEqual(got, expected)) fail(`${where}: readConnectFrames frames differ (${got.length} vs ${expected.length})`);
	if (expected.length > 1) {
		let seen = 0;
		const result = await net.readConnectFrames(chunked(resp, n + 7), () => (++seen < 1 ? undefined : false));
		if (result !== false || seen !== 1) fail(`${where}: early stop not honoured (result ${result}, ${seen} frames)`);
	}
}
console.log(`readConnectFrames: ${streams.length} streams, ${framesChecked} frames`);

// ---- helpers for 4-7 ----
const jsonOpts = { registry, useProtoFieldName: true };
const norm = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => util.isDeepStrictEqual(norm(a), norm(b));
const bytesConcat = (...parts) => new Uint8Array(Buffer.concat(parts.map(p => Buffer.from(p))));
// Hand-rolled wire records for fixtures (unknown fields, nested raw elements).
const wireVarint = (n) => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Uint8Array.from(out); };
const wireTag = (no, wt) => wireVarint((no << 3) | wt);
const wireDelimited = (no, bytes) => bytesConcat(wireTag(no, 2), wireVarint(bytes.length), bytes);
// A field's protobuf-es localName, from its proto name.
const local = (schema, protoName) => {
	const f = schema.fields.find(x => x.name === protoName);
	if (!f) throw new Error(`${schema.typeName} has no field ${protoName}`);
	return f.localName;
};
const msgType = (name) => registry.getMessage(name.includes('.') ? name : `anthropic.bard.api.v1alpha.${name}`);

// Round-trips bytes of `schema` through decodeBard(keepUnknown) + encodeBard. Returns the re-encoded
// bytes, or null after reporting a failure.
function roundTrip(schema, bytes, where) {
	let kept, re;
	try {
		kept = net.decodeBard(schema.typeName, bytes, { keepUnknown: true });
		re = net.encodeBard(schema.typeName, kept);
	} catch (e) {
		fail(`${where} ${schema.typeName}: round trip threw ${e.message}`);
		return null;
	}
	const again = net.decodeBard(schema.typeName, re, { keepUnknown: true });
	if (!same(again, kept)) fail(`${where} ${schema.typeName}: decodeBard differs after re-encoding\n  first difference: ${firstDiff(norm(again), norm(kept))}`);
	let expected = null, actual = null;
	try {
		expected = toJson(schema, fromBinary(schema, bytes), jsonOpts);
		actual = toJson(schema, fromBinary(schema, re), jsonOpts);
	} catch (e) {
		if (expected !== null) fail(`${where} ${schema.typeName}: protobuf-es can't read the re-encoded bytes: ${e.message}`);
		return re; // protobuf-es can't render this message at all (an Any outside its registry)
	}
	if (!same(actual, expected)) fail(`${where} ${schema.typeName}: protobuf-es sees a different message after re-encoding\n  first difference: ${firstDiff(norm(actual), norm(expected))}`);
	return re;
}

// ---- 4. round trip (captures) ----
for (const { schema, bytes, where } of captured) roundTrip(schema, bytes, where);
console.log(`round trip: ${captured.length} captured messages`);

// ---- 5. drift: fields the schema doesn't know survive (captures) ----
{
	const full = globalThis.ClaudeExtBardSchema;
	const trimmed = { ...full, types: full.types.map(t => (t[1] === 'm' ? [t[0], 'm', t[2].filter((f, i) => i % 3 !== 2), ...t.slice(3)] : t)) };
	let checked = 0;
	for (const { schema, bytes, where } of captured) {
		let re;
		globalThis.ClaudeExtBardSchema = trimmed;
		try {
			re = net.encodeBard(schema.typeName, net.decodeBard(schema.typeName, bytes, { keepUnknown: true }));
		} catch (e) {
			fail(`${where} ${schema.typeName}: drift round trip threw ${e.message}`);
			continue;
		} finally {
			globalThis.ClaudeExtBardSchema = full;
		}
		checked++;
		const expected = net.decodeBard(schema.typeName, bytes);
		const actual = net.decodeBard(schema.typeName, re);
		if (!same(actual, expected)) fail(`${where} ${schema.typeName}: a field unknown to the trimmed schema was lost\n  first difference: ${firstDiff(norm(actual), norm(expected))}`);
	}
	console.log(`drift (a third of all fields unknown): ${checked} captured messages`);
}

// ---- 6. synthetic fixtures ----
{
	const fixtures = []; // [label, schema, bytes]
	const add = (label, schema, msgOrBytes) => fixtures.push([label, schema, msgOrBytes instanceof Uint8Array ? msgOrBytes : toBinary(schema, msgOrBytes)]);
	const Msg = msgType('Message');
	const Att = msgType('Attachment');
	const Any = msgType('google.protobuf.Any');
	const Ts = msgType('google.protobuf.Timestamp');
	const Dur = msgType('google.protobuf.Duration');
	const ModelId = msgType('ModelId');
	const anyOf = (typeUrl, value) => create(Any, { typeUrl, value });
	const att = create(Att, { [local(Att, 'id')]: 'att-1', [local(Att, 'file_name')]: 'a.png', [local(Att, 'file_size')]: -42n });
	const base = {
		[local(Msg, 'id')]: 'msg-1',
		[local(Msg, 'role')]: 99, // a value the enum doesn't have
		[local(Msg, 'index')]: -2,
		[local(Msg, 'parent_message_id')]: '', // explicit presence, empty
		[local(Msg, 'siblings_viewable')]: true,
		[local(Msg, 'created_at')]: create(Ts, { seconds: -86401n, nanos: 250 }), // pre-1970, nanos
		[local(Msg, 'attachments')]: [att],
		[local(Msg, 'extras')]: [
			anyOf('type.googleapis.com/anthropic.bard.api.v1alpha.ModelId', toBinary(ModelId, create(ModelId, { id: { case: 'identifier', value: 'claude-x' } }))),
			anyOf('type.googleapis.com/google.protobuf.Timestamp', toBinary(Ts, create(Ts, { seconds: 1791492170n, nanos: 123456789 }))),
		],
	};
	add('message: enum unknown value, negative int32, explicit "", pre-1970 timestamp, int64, Any (bard and WKT)', Msg, create(Msg, base));
	const unknownAny = create(Msg, { ...base, [local(Msg, 'extras')]: [anyOf('type.googleapis.com/x.y.NotInTheSchema', Uint8Array.from([8, 1, 18, 2, 104, 105]))] });
	add('message: Any with a type outside the schema', Msg, unknownAny);
	// Unknown fields, top level and inside a repeated element.
	const unknownRecords = bytesConcat(
		wireTag(900, 0), wireVarint(7),
		wireDelimited(901, Buffer.from('hello')),
		wireTag(902, 5), Uint8Array.from([1, 2, 3, 4]),
		wireTag(903, 1), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
	);
	const attWithUnknown = bytesConcat(toBinary(Att, att), wireTag(950, 0), wireVarint(3));
	const withUnknown = bytesConcat(toBinary(Msg, create(Msg, base)), wireDelimited(Msg.fields.find(f => f.name === 'attachments').number, attWithUnknown), unknownRecords);
	add('message: unknown fields at the top level and inside a repeated element', Msg, withUnknown);
	{
		const decoded = net.decodeBard(Msg.typeName, withUnknown, { keepUnknown: true });
		if (!decoded.$unknown || !decoded.attachments?.[1]?.$unknown) fail('synthetic: decodeBard(keepUnknown) did not report $unknown at both levels');
		const re = net.encodeBard(Msg.typeName, decoded);
		const before = fromBinary(Msg, withUnknown), after = fromBinary(Msg, re);
		if ((before.$unknown?.length ?? 0) !== 4 || (after.$unknown?.length ?? 0) !== 4) fail(`synthetic: protobuf-es sees ${before.$unknown?.length} / ${after.$unknown?.length} unknown top-level fields, expected 4 / 4`);
		const att2 = after[local(Msg, 'attachments')][1];
		if ((att2?.$unknown?.length ?? 0) !== 1) fail('synthetic: the unknown field inside the attachment was lost');
		if (net.decodeBard(Msg.typeName, withUnknown).$unknown !== undefined) fail('synthetic: $unknown appeared without keepUnknown');
	}
	add('ModelId: oneof bool member set to false (explicit presence)', ModelId, create(ModelId, { id: { case: 'default', value: false } }));
	add('Duration: negative fractional', Dur, create(Dur, { seconds: -1n, nanos: -500000000 }));
	add('Timestamp: nanos', Ts, create(Ts, { seconds: 1791492170n, nanos: 1000 }));
	{
		const Settings = msgType('McpToolSettings');
		const tools = {};
		Object.defineProperty(tools, '__proto__', { value: true, enumerable: true, configurable: true, writable: true });
		tools.other = false;
		tools['a:b'] = true;
		add('map<string, bool> with a __proto__ key', Settings, create(Settings, { [local(Settings, 'tools')]: tools }));
	}
	{
		const Limit = msgType('MessageLimit');
		const Win = msgType('MessageLimitWindow');
		const win = (u) => create(Win, { [local(Win, 'utilization')]: u, [local(Win, 'resets_at')]: create(Ts, { seconds: 1791500000n }) });
		add('map<string, message>, double NaN/±Infinity/-0', Limit, create(Limit, { [local(Limit, 'windows')]: { '5h': win(NaN), '7d': win(Infinity), overage: win(-Infinity), zero: win(-0) } }));
	}
	{
		const Compose = msgType('CorbelMessageCompose');
		const sends = Compose.fields.find(f => f.name === 'sends');
		add('packed repeated enum (with an unknown value)', Compose, create(Compose, { [sends.localName]: [1, 2, 0, 77] }));
	}
	{
		const Header = msgType('ActionHeader');
		add('bytes', Header, create(Header, { [local(Header, 'origin_nonce')]: Uint8Array.from([0, 255, 1, 128, 64]), [local(Header, 'conversation_id')]: 'c' }));
	}
	{
		const Event = msgType('StreamEvent');
		add('oneof message member + negative int64', Event, create(Event, { [local(Event, 'lease_epoch')]: -5n, event: { case: 'heartbeat', value: create(msgType('Heartbeat')) } }));
	}
	{
		// The first uint64 field in the schema, if any, at its maximum.
		const table = globalThis.ClaudeExtBardSchema;
		const hit = table.types.find(t => t[1] === 'm' && t[2].some(f => f[2] === 's' && f[3] === 4 && !(f[4] & 1)));
		if (hit) {
			const schema = msgType(hit[0][0] === '.' ? table.prefix + hit[0].slice(1) : hit[0]);
			const f = hit[2].find(x => x[2] === 's' && x[3] === 4 && !(x[4] & 1));
			add(`uint64 max (${schema.typeName.split('.').pop()}.${f[1]})`, schema, create(schema, { [local(schema, f[1])]: 18446744073709551615n }));
		}
	}
	for (const [label, schema, bytes] of fixtures) roundTrip(schema, bytes, `synthetic [${label}]`);
	console.log(`synthetic fixtures: ${fixtures.length} round-tripped`);

	// Encode-only behaviour.
	const scratch = fromBinary(Msg, net.encodeBard('Message', { id: 'phantom-1', role: 'ROLE_USER', index: -2, is_complete: true, parent_message_id: '' }));
	if (scratch[local(Msg, 'id')] !== 'phantom-1' || scratch[local(Msg, 'role')] !== 1 || scratch[local(Msg, 'index')] !== -2 || scratch[local(Msg, 'is_complete')] !== true || scratch[local(Msg, 'parent_message_id')] !== '') {
		fail(`encodeBard from scratch: protobuf-es read ${JSON.stringify(toJson(Msg, scratch, jsonOpts))}`);
	}
	const Send = msgType('SendMessage');
	const send = toBinary(Send, create(Send, { [local(Send, 'text')]: 'hi', [local(Send, 'parent_message_id')]: 'abc' }));
	const merged = net.decodeBard('SendMessage', bytesConcat(send, net.encodeBard('SendMessage', { parent_message_id: '' })));
	if (merged.parent_message_id !== '' || merged.text !== 'hi') fail(`encodeBard append-merge: got ${JSON.stringify(merged)}`);
	const throws = (label, fn) => {
		try {
			fn();
			fail(`encodeBard should throw: ${label}`);
		} catch (e) {
			if (!String(e.message).startsWith('encodeBard:')) fail(`encodeBard ${label}: unexpected error ${e.message}`);
		}
	};
	throws('unknown field', () => net.encodeBard('Message', { idd: 'x' }));
	throws('two oneof members', () => net.encodeBard('ModelId', { default: true, identifier: 'x' }));
	throws('unknown enum name', () => net.encodeBard('Message', { role: 'ROLE_NOPE' }));
	throws('bad timestamp', () => net.encodeBard('Message', { created_at: 'yesterday' }));
	throws('string in an int field', () => net.encodeBard('Message', { index: 'two' }));
	console.log('encodeBard: from scratch, append-merge and strictness checked');
}

// ---- 7. Connect frames: encodeConnectFrame, rewriteConnectStream ----
{
	const collect = async (stream) => {
		const parts = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
		}
		return bytesConcat(...parts);
	};
	const payloads = [Buffer.from('first'), Buffer.from('second, gzipped'), Buffer.from(''), Buffer.from('fourth')];
	const plain = (p) => net.encodeConnectFrame(Uint8Array.from(p));
	const gzipped = (p) => { const z = zlib.gzipSync(p); const f = new Uint8Array(5 + z.length); f[0] = 1; new DataView(f.buffer).setUint32(1, z.length); f.set(z, 5); return f; };
	const trailers = net.encodeConnectFrame(Uint8Array.from(Buffer.from('{"metadata":{"x":["1"]}}')), { endStream: true });
	const synthetic = bytesConcat(plain(payloads[0]), gzipped(payloads[1]), plain(payloads[2]), plain(payloads[3]), trailers);

	const split = net.splitConnectFrames(synthetic);
	if (split.length !== 5 || split[4].flags !== 2 || Buffer.from(split[3].payload).toString() !== 'fourth') fail('encodeConnectFrame: splitConnectFrames does not read the frames back');

	// Identity: byte-identical, over random chunkings, synthetic and captured.
	const sources = [['synthetic', synthetic], ...streams.map(s => [s.where, s.resp])];
	for (const [n, [where, bytes]] of sources.entries()) {
		for (const seed of [1, 2, 3]) {
			const { stream } = net.rewriteConnectStream(chunked(bytes, n * 10 + seed), () => undefined);
			const out = await collect(stream);
			if (Buffer.compare(Buffer.from(out), Buffer.from(bytes)) !== 0) fail(`rewriteConnectStream identity (${where}, seed ${seed}): output differs (${out.length} vs ${bytes.length} bytes)`);
		}
	}

	// Replace, split and drop; onFrame sees gunzipped payloads and parsed trailers.
	{
		const seen = [];
		const { stream } = net.rewriteConnectStream(chunked(synthetic, 99), async (f) => {
			seen.push(f.endStream ? f.trailers : Buffer.from(f.payload).toString());
			if (seen.length === 1) return [Uint8Array.from(Buffer.from('1a')), Uint8Array.from(Buffer.from('1b'))];
			if (seen.length === 2) return Uint8Array.from(Buffer.from('two'));
			if (seen.length === 3) return [];
			return undefined;
		});
		const out = net.splitConnectFrames(await collect(stream)).map(f => [f.flags, Buffer.from(f.payload).toString()]);
		const expected = [[0, '1a'], [0, '1b'], [0, 'two'], [0, 'fourth'], [2, '{"metadata":{"x":["1"]}}']];
		if (!util.isDeepStrictEqual(out, expected)) fail(`rewriteConnectStream replace/split/drop: got ${JSON.stringify(out)}`);
		if (seen[1] !== 'second, gzipped' || seen[4]?.metadata?.x?.[0] !== '1') fail(`rewriteConnectStream: onFrame saw ${JSON.stringify(seen)}`);
	}

	// Fail open: a throwing onFrame forwards the original frame and reports the error.
	{
		const errors = [];
		const { stream } = net.rewriteConnectStream(chunked(synthetic, 7), (f) => { if (Buffer.from(f.payload).toString() === 'first') throw new Error('boom'); }, { onError: (e) => errors.push(e.message) });
		const out = await collect(stream);
		if (Buffer.compare(Buffer.from(out), Buffer.from(synthetic)) !== 0 || errors.join() !== 'boom') fail(`rewriteConnectStream fail-open: errors ${JSON.stringify(errors)}, output ${out.length} vs ${synthetic.length} bytes`);
	}

	// inject(): delivered while the source is idle, at a frame boundary, before end-of-stream; false after.
	{
		let source, cancelled = false;
		const src = new ReadableStream({ start(c) { source = c; }, cancel() { cancelled = true; } });
		const { stream, inject } = net.rewriteConnectStream(src, () => undefined);
		const reader = stream.getReader();
		source.enqueue(plain(payloads[0]).subarray(0, 3)); // half a frame first
		source.enqueue(plain(payloads[0]).subarray(3));
		const first = await reader.read();
		const pending = reader.read(); // the source has nothing more for now
		await new Promise(r => setTimeout(r, 20));
		const injectedOk = inject(Uint8Array.from(Buffer.from('ours')));
		const second = await Promise.race([pending, new Promise(r => setTimeout(() => r('timeout'), 1000))]);
		inject(Uint8Array.from(Buffer.from('ours too')));
		source.enqueue(trailers);
		source.close();
		const rest = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			rest.push(value);
		}
		const text = (v) => Buffer.from(net.splitConnectFrames(v)[0]?.payload ?? []).toString();
		if (!injectedOk || text(first.value) !== 'first' || second === 'timeout' || text(second.value) !== 'ours') fail(`rewriteConnectStream inject while idle: got ${second === 'timeout' ? 'nothing (timeout)' : text(second.value)}`);
		const tail = rest.map(v => net.splitConnectFrames(v)[0]).map(f => [f.flags, Buffer.from(f.payload).toString()]);
		if (!util.isDeepStrictEqual(tail, [[0, 'ours too'], [2, '{"metadata":{"x":["1"]}}']])) fail(`rewriteConnectStream inject before end-of-stream: got ${JSON.stringify(tail)}`);
		if (inject(Uint8Array.from([1])) !== false) fail('rewriteConnectStream: inject() after the end should return false');
		if (cancelled) fail('rewriteConnectStream: source cancelled although the stream ended normally');
	}

	// Cancellation reaches the source; inject() is refused afterwards.
	{
		let cancelled = false;
		const src = new ReadableStream({ start(c) { c.enqueue(plain(payloads[0])); }, cancel() { cancelled = true; } });
		const { stream, inject } = net.rewriteConnectStream(src, () => undefined);
		const reader = stream.getReader();
		await reader.read();
		await reader.cancel('done');
		if (!cancelled || inject(Uint8Array.from([1])) !== false) fail(`rewriteConnectStream cancel: source cancelled ${cancelled}`);
	}
	console.log(`connect frames: encode, identity over ${sources.length} stream(s), replace/split/drop, fail-open, inject, cancel`);
}

// ---- 3. load order ----
const current = { net: net.VERSION, schema: globalThis.ClaudeExtBardSchema.VERSION, decodeBard: net.decodeBard };
try {
	const older = execFileSync('git', ['-C', root, 'show', 'de43fbb:net/net.js'], { encoding: 'utf8' });
	vm.runInThisContext(older);
	if (globalThis.ClaudeExtNet.VERSION !== current.net || globalThis.ClaudeExtNet.decodeBard !== current.decodeBard) fail('an older net.js loading later replaced members');
} catch (e) {
	fail(`couldn't load the older net.js: ${e.message}`);
}
const table = globalThis.ClaudeExtBardSchema;
vm.runInThisContext(fs.readFileSync(path.join(root, 'net/bard-schema.js'), 'utf8').replace(/const VERSION = \d+;/, 'const VERSION = 0;'));
if (globalThis.ClaudeExtBardSchema !== table) fail('an older bard-schema.js loading later replaced the table');
console.log('load order: older copies leave the current ones alone');

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
