// decode-capture.mjs (claude-ext-common)
// Decodes a capture from page/capture-hook.js into readable JSON, one record per RPC call.
// Unary calls (application/proto) are a single message each way. Streaming calls
// (application/connect+proto) are framed: 1 flag byte + 4-byte big-endian length + payload,
// where flag bit 0x01 marks a gzip-compressed payload and 0x02 the end-of-stream frame, whose
// payload is JSON (error and trailers).
//
//   node scripts/bard/decode-capture.mjs <capture.json> [--descriptors <file>] [--out <file>] [--compact]
//
// --compact replaces the per-tool enabled_mcp_tools maps (hundreds of entries, repeated in every
// conversation update) with their size.
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { loadRegistry } from './registry.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const descriptors = opt('--descriptors');
const outFile = opt('--out');
const compactAt = args.indexOf('--compact');
const compact = compactAt >= 0 && args.splice(compactAt, 1).length > 0;
const capturePath = args[0];
if (!capturePath) {
	console.error('usage: decode-capture.mjs <capture.json> [--descriptors <file>] [--out <file>]');
	process.exit(1);
}

const { registry } = loadRegistry(descriptors);
let records = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
if (typeof records === 'string') records = JSON.parse(records);

function methodOf(url) {
	const m = /\/claudeai-rpc\/([\w.]+)\/(\w+)/.exec(url);
	if (!m) return null;
	const service = registry.getService(m[1]);
	return service?.methods.find(x => x.name === m[2]) ?? { missing: `${m[1]}/${m[2]}` };
}

function decode(schema, bytes) {
	try {
		// Proto field names: the embedded descriptors carry an empty json_name, which toJson would use.
		return toJson(schema, fromBinary(schema, bytes), { registry, useProtoFieldName: true });
	} catch (e) {
		return { decodeError: e.message, b64: Buffer.from(bytes).toString('base64') };
	}
}

function* frames(buf) {
	let i = 0;
	while (i + 5 <= buf.length) {
		const flags = buf[i];
		const len = buf.readUInt32BE(i + 1);
		if (i + 5 + len > buf.length) {
			yield { truncated: true, flags, len, have: buf.length - i - 5 };
			return;
		}
		const raw = buf.subarray(i + 5, i + 5 + len);
		yield { flags, wireLen: 5 + len, payload: flags & 0x01 ? gunzipSync(raw) : raw };
		i += 5 + len;
	}
}

const out = [];
for (const r of records) {
	const method = r.url && methodOf(r.url);
	if (!method) continue;
	const rec = { method: method.name ?? method.missing, t: r.t, status: r.status };
	if (method.missing) {
		rec.note = 'method not in descriptors';
		out.push(rec);
		continue;
	}
	const req = Buffer.from(r.reqB64 ?? '', 'base64');
	const streamingReq = (r.reqCT ?? '').includes('connect+');
	rec.request = streamingReq
		? [...frames(req)].map(f => (f.payload ? decode(method.input, f.payload) : f))
		: decode(method.input, req);
	const resp = Buffer.concat((r.chunks ?? []).map(c => Buffer.from(c.b, 'base64')));
	if ((r.respCT ?? '').includes('connect+')) {
		// Arrival times: map each frame to the chunk that completed it.
		const ends = [];
		let acc = 0;
		for (const c of r.chunks ?? []) ends.push([acc += Buffer.from(c.b, 'base64').length, c.dt]);
		let offset = 0;
		rec.response = [...frames(resp)].map(f => {
			if (f.truncated) return f;
			offset += f.wireLen;
			const dt = ends.find(([end]) => end >= offset)?.[1];
			if (f.flags & 0x02) return { dt, endStream: JSON.parse(f.payload.toString('utf8') || '{}') };
			return { dt, ...decode(method.output, f.payload) };
		});
	} else if (resp.length) {
		rec.response = decode(method.output, resp);
	}
	out.push(rec);
}

const json = JSON.stringify(out, (k, v) => (compact && k === 'enabled_mcp_tools' ? `[${Object.keys(v.tools ?? {}).length} tools]` : v), 2);
if (outFile) fs.writeFileSync(outFile, json);
else console.log(json);
