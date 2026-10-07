// registry.mjs (claude-ext-common)
// Loads descriptors.json (from page/dump-descriptors.js) into a protobuf-es registry.
//
// protobuf-es strips the `dependency` list from the descriptors it embeds (imports are passed as
// JS arguments instead), so each file's imports are rebuilt here from the type names it references.
import fs from 'node:fs';
import { fromBinary, createFileRegistry } from '@bufbuild/protobuf';
import * as wkt from '@bufbuild/protobuf/wkt';

const DEFAULT_PATH = new URL('descriptors.json', import.meta.url);

export function loadProtos(path = DEFAULT_PATH) {
	let raw = JSON.parse(fs.readFileSync(path, 'utf8'));
	// evaluate_script's filePath output wraps the returned string in JSON once more.
	if (typeof raw === 'string') raw = JSON.parse(raw);
	const protos = {};
	for (const [name, b64] of Object.entries(raw)) {
		protos[name] = fromBinary(wkt.FileDescriptorProtoSchema, Buffer.from(b64, 'base64'));
	}
	return protos;
}

function wktProtos() {
	const out = {};
	for (const v of Object.values(wkt)) if (v && v.kind === 'file') out[v.proto.name] = v.proto;
	return out;
}

// Map every fully qualified type name (".pkg.Outer.Inner") to the file defining it.
function indexTypes(files) {
	const owner = new Map();
	for (const [name, p] of Object.entries(files)) {
		const pkg = p.package ? '.' + p.package : '';
		const walk = (msgs, enums, prefix) => {
			for (const e of enums) owner.set(`${prefix}.${e.name}`, name);
			for (const m of msgs) {
				owner.set(`${prefix}.${m.name}`, name);
				walk(m.nestedType, m.enumType, `${prefix}.${m.name}`);
			}
		};
		walk(p.messageType, p.enumType, pkg);
	}
	return owner;
}

function referencedTypes(p) {
	const refs = new Set();
	const walk = (msgs) => {
		for (const m of msgs) {
			for (const f of m.field) if (f.typeName) refs.add(f.typeName);
			walk(m.nestedType);
		}
	};
	walk(p.messageType);
	for (const f of p.extension) {
		if (f.typeName) refs.add(f.typeName);
		if (f.extendee) refs.add(f.extendee);
	}
	for (const s of p.service) for (const r of s.method) refs.add(r.inputType).add(r.outputType);
	return refs;
}

// Fills in each file's dependency list, the well-known types' included (protobuf-es strips theirs
// too). Returns the type names no known file defines.
export function rebuildDependencies(protos) {
	const all = { ...wktProtos(), ...protos };
	const owner = indexTypes(all);
	const unresolved = new Set();
	for (const [name, p] of Object.entries(all)) {
		const deps = new Set();
		for (const t of referencedTypes(p)) {
			const file = owner.get(t);
			if (!file) unresolved.add(`${t} (in ${name})`);
			else if (file !== name) deps.add(file);
		}
		p.dependency = [...deps].sort();
	}
	return unresolved;
}

export function loadRegistry(path) {
	const protos = loadProtos(path);
	const unresolved = rebuildDependencies(protos);
	// createFileRegistry wants every file after its dependencies.
	const all = { ...wktProtos(), ...protos };
	const ordered = [];
	const seen = new Set();
	const visit = (name) => {
		if (seen.has(name) || !all[name]) return;
		seen.add(name);
		all[name].dependency.forEach(visit);
		ordered.push(all[name]);
	};
	Object.keys(all).forEach(visit);
	const registry = createFileRegistry({ $typeName: 'google.protobuf.FileDescriptorSet', file: ordered });
	return { registry, protos, unresolved };
}
