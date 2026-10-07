// timeline.mjs (claude-ext-common)
// Prints a decoded capture (decode-capture.mjs output) as one compact line per event, in time
// order: PerformAction requests, StreamTimeline events (heartbeats dropped) and other RPC calls.
// Long strings are cut, UUIDs shortened, and the per-tool MCP maps collapsed.
//
//   node scripts/bard/timeline.mjs <capture.decoded.json> [--width N]
import fs from 'node:fs';

const args = process.argv.slice(2);
const wAt = args.indexOf('--width');
const width = wAt >= 0 ? Number(args.splice(wAt, 2)[1]) : 600;
const records = JSON.parse(fs.readFileSync(args[0], 'utf8'));

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
function compact(value) {
	return JSON.stringify(value, (k, v) => {
		if (k === 'enabled_mcp_tools') return `[${Object.keys(v.tools ?? {}).length} tools]`;
		if (k === 'conversation_id') return undefined;
		if (typeof v === 'string' && v.length > 120) return v.slice(0, 100) + `…(${v.length})`;
		return v;
	}).replace(UUID, '$1');
}

function conversationSummary(c) {
	const s = c.settings ?? {};
	return {
		status: c.status, model: c.model?.identifier, leaf: c.current_leaf_message_id,
		thinking: s.thinking_mode_token, effort: s.effort_level_token, title: c.title,
	};
}

const lines = [];
for (const r of records) {
	if (r.method === 'StreamTimeline') {
		for (const f of r.response ?? []) {
			const e = f.event;
			if (!e || e.heartbeat) continue;
			const { version, lease_epoch, ...ev } = e;
			if (ev.update?.conversation) ev.update = { ...ev.update, conversation: conversationSummary(ev.update.conversation) };
			if (ev.append?.text_delta) ev.append = { ...ev.append, text_delta: `${ev.append.text_delta.length}ch` };
			lines.push([r.t + (f.dt ?? 0), 'stream', compact(ev)]);
		}
	} else if (r.method === 'PerformAction') {
		const { header, ...action } = r.request ?? {};
		lines.push([r.t, 'action', compact(action)]);
	} else {
		lines.push([r.t, r.method, compact({ request: r.request, response: r.response })]);
	}
}
lines.sort((a, b) => a[0] - b[0]);
for (const [t, kind, text] of lines) {
	console.log(`${new Date(t).toISOString().slice(11, 22)} ${kind.padEnd(8)} ${text.slice(0, width)}`);
}
