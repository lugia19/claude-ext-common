// dump-descriptors.js (claude-ext-common)
// Page snippet: run in a logged-in claude.ai tab (merged experience) to pull the bard API schemas
// out of the JS bundle. protobuf-es embeds every .proto as a base64 FileDescriptorProto string
// literal, so this fetches each loaded asset chunk, decodes every long base64 literal and keeps the
// ones that are FileDescriptorProtos. Returns a JSON string {"<file>.proto": "<base64>", ...}.
//
// Only chunks the page has loaded are scanned, so open a conversation first: some descriptors live
// in lazily loaded chunks.
//
//   chrome-devtools MCP: evaluate_script with this file's contents as `function`, plus `filePath`
//                        pointing at scripts/bard/descriptors.json
//   DevTools console:    copy(await (<paste>)()) and save the clipboard as descriptors.json
async () => {
	const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name)
		.filter(u => /assets-proxy.*\.js$/.test(u)))];
	const out = {};
	await Promise.all(urls.map(async u => {
		let text;
		try {
			text = await (await fetch(u)).text();
		} catch (e) {
			return;
		}
		const re = /["'`]([A-Za-z0-9+/]{100,}={0,2})["'`]/g;
		let m;
		while ((m = re.exec(text))) {
			let bin;
			try {
				bin = atob(m[1]);
			} catch (e) {
				continue;
			}
			// FileDescriptorProto field 1 (name) comes first: tag 0x0a, then a one-byte length.
			if (bin.charCodeAt(0) !== 0x0a) continue;
			const name = bin.slice(2, 2 + bin.charCodeAt(1));
			if (/^[\w/.]+\.proto$/.test(name)) out[name] = m[1];
		}
	}));
	const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify(sorted, null, '\t');
}
