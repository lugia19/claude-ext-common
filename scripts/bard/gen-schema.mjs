// gen-schema.mjs (claude-ext-common)
// Writes net/bard-schema.js: the part of the bard API schema that net.js's decodeBard() needs, as a
// compact table. Run it after re-extracting descriptors.json, and commit both:
//
//   node scripts/bard/gen-schema.mjs [--descriptors <file>] [--out <file>]
//
// The table covers the transitive closure of ROOTS, plus every bard message no field refers to:
// those can only travel inside a google.protobuf.Any (Message.extras and friends), so they're
// included for unpacking. VERSION in the output is bumped only when the table changes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ScalarType } from '@bufbuild/protobuf';
import { loadRegistry } from './registry.mjs';

const PREFIX = 'anthropic.bard.api.v1alpha.';

// What the extensions read: sends, the timeline stream, and full conversation reads.
const ROOTS = [
	'PerformActionRequest',
	'PerformActionResponse',
	'StreamTimelineRequest',
	'StreamTimelineResponse',
	'StreamEvent',
	'ReadConversationRequest',
	'ReadConversationResponse',
	'ReadConversationHistoryRequest',
	'ReadConversationHistoryResponse',
];

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const descriptors = opt('--descriptors');
const outFile = opt('--out') ?? new URL('../../net/bard-schema.js', import.meta.url);

const { registry } = loadRegistry(descriptors);
const allMessages = [...registry].filter(t => t.kind === 'message');

// Bard messages that no field references: Any payloads. RPC request/response envelopes are
// unreferenced too, but only ever travel as a call's body; the ones we read are in ROOTS.
const referenced = new Set();
for (const m of allMessages) {
	for (const f of m.fields) if (f.message) referenced.add(f.message.typeName);
}
const anyTargets = allMessages
	.filter(m => m.typeName.startsWith('anthropic.bard.') && !referenced.has(m.typeName))
	.filter(m => !/(Request|Response)$/.test(m.typeName))
	.map(m => m.typeName);

// Closure, in a stable order: discovery order from sorted roots.
const messages = new Map();
const enums = new Map();
const queue = [...ROOTS.map(r => PREFIX + r), ...anyTargets.sort()];
while (queue.length) {
	const name = queue.shift();
	if (messages.has(name)) continue;
	const desc = registry.getMessage(name);
	if (!desc) throw new Error(`unknown message ${name}`);
	messages.set(name, desc);
	for (const f of desc.fields) {
		if (f.message) queue.push(f.message.typeName);
		if (f.enum) enums.set(f.enum.typeName, f.enum);
	}
}

// One index space for messages then enums; names stored once, the bard prefix shortened to ".".
const order = [...messages.keys(), ...[...enums.keys()].sort()];
const index = new Map(order.map((n, i) => [n, i]));
const short = (n) => (n.startsWith(PREFIX) ? '.' + n.slice(PREFIX.length) : n);

// field: [number, name, kind, ref, flags, oneof?]
//   kind 's' scalar (ref = ScalarType), 'e' enum, 'm' message (ref = type index),
//        'M' map (ref = [keyScalarType, valueKind, valueRef])
//   flags: 1 repeated, 2 explicit presence
function fieldEntry(f, oneofs) {
	let kind, ref;
	if (f.fieldKind === 'map') {
		const valueKind = f.mapKind === 'scalar' ? 's' : f.mapKind === 'enum' ? 'e' : 'm';
		const valueRef = f.mapKind === 'scalar' ? f.scalar : index.get((f.enum ?? f.message).typeName);
		kind = 'M';
		ref = [f.mapKey, valueKind, valueRef];
	} else if (f.enum) {
		kind = 'e';
		ref = index.get(f.enum.typeName);
	} else if (f.message) {
		kind = 'm';
		ref = index.get(f.message.typeName);
	} else {
		kind = 's';
		ref = f.scalar;
	}
	const repeated = f.fieldKind === 'list' ? 1 : 0;
	const explicit = f.fieldKind !== 'list' && f.fieldKind !== 'map' && (f.oneof || f.presence !== 2) ? 2 : 0;
	const entry = [f.number, f.name, kind, ref, repeated | explicit];
	if (f.oneof) {
		if (!oneofs.includes(f.oneof.name)) oneofs.push(f.oneof.name);
		entry.push(oneofs.indexOf(f.oneof.name));
	}
	return entry;
}

const types = order.map((name) => {
	if (messages.has(name)) {
		const desc = messages.get(name);
		const oneofs = [];
		const fields = desc.fields.concat().sort((a, b) => a.number - b.number).map(f => fieldEntry(f, oneofs));
		return oneofs.length ? [short(name), 'm', fields, oneofs] : [short(name), 'm', fields];
	}
	const e = enums.get(name);
	const values = {};
	for (const v of e.values) values[v.number] = v.name;
	return [short(name), 'e', values, e.values[0].number];
});

const table = JSON.stringify(types);
const hash = crypto.createHash('sha256').update(table).digest('hex').slice(0, 8);

// Keep VERSION when the table is unchanged; bump it otherwise.
let version = 1;
try {
	const previous = fs.readFileSync(outFile, 'utf8');
	const prevVersion = Number(/const VERSION = (\d+);/.exec(previous)?.[1]);
	const prevHash = /snapshot: '[^']*-([0-9a-f]{8})'/.exec(previous)?.[1];
	if (prevVersion) version = prevHash === hash ? prevVersion : prevVersion + 1;
} catch (e) {
	// First run.
}
let snapshot = `${new Date().toISOString().slice(0, 10)}-${hash}`;
try {
	const previous = fs.readFileSync(outFile, 'utf8');
	const prev = /snapshot: '([^']*)'/.exec(previous)?.[1];
	if (prev?.endsWith(hash)) snapshot = prev;
} catch (e) {
	// First run.
}

const S = ScalarType;
const out = `// bard-schema.js (claude-ext-common)
// GENERATED by scripts/bard/gen-schema.mjs from scripts/bard/descriptors.json. Do not edit by hand:
// re-extract the descriptors, rerun the script, commit both.
//
// The bard API schema subset that ClaudeExtNet.decodeBard() (net/net.js) reads: ${messages.size} messages and
// ${enums.size} enums, the closure of the PerformAction, StreamTimeline and ReadConversation[History] messages
// plus every Any payload type. Load it wherever decodeBard is called; net.js looks it up at call time.
//
// Like net.js, it's versioned and the NEWEST copy wins, whatever the load order (both extensions may
// load it into the shared MAIN world): a newer table replaces an older one; an older one loading later
// does nothing.
//
// types[i]: [name, 'm', fields, oneofNames?] or [name, 'e', { number: name }, firstValueNumber]
//   name: a leading '.' stands for '${PREFIX}'
//   field: [number, name, kind, ref, flags, oneofIndex?]
//     kind 's' scalar (ref: ScalarType, e.g. ${S.STRING} string, ${S.INT64} int64, ${S.BOOL} bool), 'e' enum / 'm' message
//     (ref: index into types), 'M' map (ref: [keyScalarType, valueKind, valueRef])
//     flags: 1 repeated, 2 explicit presence
(function () {
	'use strict';

	const VERSION = ${version};

	const existing = globalThis.ClaudeExtBardSchema;
	if (existing && existing.VERSION >= VERSION) return;
	globalThis.ClaudeExtBardSchema = {
		VERSION,
		snapshot: '${snapshot}',
		prefix: '${PREFIX}',
		types: ${table},
	};
})();
`;
fs.writeFileSync(outFile, out);
console.log(`bard-schema.js: VERSION ${version}, ${messages.size} messages (${anyTargets.length} Any targets), ${enums.size} enums, ${(out.length / 1024).toFixed(1)} KB`);
