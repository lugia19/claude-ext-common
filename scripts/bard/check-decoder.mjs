// check-decoder.mjs (claude-ext-common)
// Regression test for net/net.js's bard decoding against protobuf-es, over every capture in
// captures/ (gitignored, so it runs against whatever you've captured locally):
//
//   node scripts/bard/check-decoder.mjs [capture.json ...]
//
// 1. decodeBard() output must deep-equal protobuf-es toJson(useProtoFieldName) for every captured
//    RPC request, unary response and stream frame (net/bard-schema.js as the schema).
// 2. readConnectFrames() must yield the same frames as a whole-buffer split, with the stream cut
//    into random chunks (including mid-header), honour an early `false`, and parse end-stream
//    trailers.
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
if (!stats.compared) fail('no captured messages to compare (capture some into captures/ first)');

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
