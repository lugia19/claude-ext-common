// render-protos.mjs (claude-ext-common)
// Renders descriptors.json back into .proto source under scripts/bard/proto/, so schema changes
// between claude.ai deploys show up as a readable git diff. Custom options are not rendered.
//
//   node scripts/bard/render-protos.mjs [descriptors.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFieldSet } from '@bufbuild/protobuf';
import { FieldDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { loadProtos, rebuildDependencies } from './registry.mjs';

const SCALARS = {
	1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool',
	9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64',
};
const LABEL_REPEATED = 3;

const strip = (n) => n.replace(/^\./, '');
const typeOf = (f) => (f.typeName ? strip(f.typeName) : SCALARS[f.type]);
const inOneof = (f) => isFieldSet(f, FieldDescriptorProtoSchema.field.oneofIndex) && !f.proto3Optional;

function renderField(f, ind) {
	const label = f.proto3Optional ? 'optional ' : f.label === LABEL_REPEATED ? 'repeated ' : '';
	return `${ind}${label}${typeOf(f)} ${f.name} = ${f.number};`;
}

function renderEnum(e, ind) {
	return [`${ind}enum ${e.name} {`, ...e.value.map(v => `${ind}  ${v.name} = ${v.number};`), `${ind}}`];
}

function renderMessage(m, ind) {
	const lines = [`${ind}message ${m.name} {`];
	const mapEntries = new Map(m.nestedType.filter(n => n.options?.mapEntry).map(n => [n.name, n]));
	for (const e of m.enumType) lines.push(...renderEnum(e, ind + '  '));
	for (const n of m.nestedType) if (!mapEntries.has(n.name)) lines.push(...renderMessage(n, ind + '  '));
	const oneofs = m.oneofDecl.map(() => []);
	for (const f of m.field) {
		const entry = f.label === LABEL_REPEATED && f.typeName && mapEntries.get(strip(f.typeName).split('.').pop());
		if (entry) {
			const [k, v] = entry.field;
			lines.push(`${ind}  map<${typeOf(k)}, ${typeOf(v)}> ${f.name} = ${f.number};`);
		} else if (inOneof(f)) {
			oneofs[f.oneofIndex].push(f);
		} else {
			lines.push(renderField(f, ind + '  '));
		}
	}
	m.oneofDecl.forEach((o, i) => {
		if (!oneofs[i].length) return;
		lines.push(`${ind}  oneof ${o.name} {`, ...oneofs[i].map(f => renderField(f, ind + '    ')), `${ind}  }`);
	});
	lines.push(`${ind}}`);
	return lines;
}

function renderFile(p) {
	const lines = [`syntax = "${p.syntax || 'proto2'}";`, '', `package ${p.package};`, ''];
	if (p.dependency.length) lines.push(...p.dependency.map(d => `import "${d}";`), '');
	for (const e of p.enumType) lines.push(...renderEnum(e, ''), '');
	for (const m of p.messageType) lines.push(...renderMessage(m, ''), '');
	for (const s of p.service) {
		lines.push(`service ${s.name} {`);
		for (const r of s.method) {
			const req = (r.clientStreaming ? 'stream ' : '') + strip(r.inputType);
			const res = (r.serverStreaming ? 'stream ' : '') + strip(r.outputType);
			lines.push(`  rpc ${r.name}(${req}) returns (${res});`);
		}
		lines.push('}', '');
	}
	return lines.join('\n');
}

const protos = loadProtos(process.argv[2]);
const unresolved = rebuildDependencies(protos);
const outDir = fileURLToPath(new URL('proto/', import.meta.url));
fs.rmSync(outDir, { recursive: true, force: true });
for (const [name, p] of Object.entries(protos)) {
	const file = path.join(outDir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, renderFile(p));
}
console.log(`${Object.keys(protos).length} files written to ${outDir}`);
if (unresolved.size) console.log('Unresolved types (descriptor missing; load more of the app and re-dump):\n  ' + [...unresolved].join('\n  '));
