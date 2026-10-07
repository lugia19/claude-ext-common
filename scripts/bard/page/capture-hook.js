// capture-hook.js (claude-ext-common)
// Page snippet: records claude.ai API traffic, including binary Connect-RPC bodies and every chunk
// of streamed responses, into window.__recon. Install it before the page's own code runs, e.g.
// chrome-devtools MCP navigate_page({ type: 'reload', initScript: <this file> }).
//
// Export it afterwards with evaluate_script and a `filePath`:
//   () => JSON.stringify(window.__recon.filter(r => r.url && r.url.includes('claudeai-rpc')))
// then decode with `node scripts/bard/decode-capture.mjs <file>`.
//
// The records hold request bodies verbatim. Don't commit captures.
(() => {
	window.__recon = [];
	const b64 = (u8) => {
		let s = '';
		for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
		return btoa(s);
	};
	const toBytes = async (body) => {
		if (body == null) return null;
		if (typeof body === 'string') return new TextEncoder().encode(body);
		if (body instanceof Uint8Array) return body;
		if (body instanceof ArrayBuffer) return new Uint8Array(body);
		if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
		if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
		return new TextEncoder().encode('[unhandled body ' + Object.prototype.toString.call(body) + ']');
	};
	const interesting = (u) => /claudeai-rpc|\/api\/|\/v1\//.test(u) && !/assets-proxy|statsig|sentry|intercom|segment/.test(u);

	const origFetch = window.fetch;
	window.fetch = async function (input, init) {
		const url = typeof input === 'string' ? input : (input && input.url) || String(input);
		if (!interesting(url)) return origFetch.apply(this, arguments);
		const rec = { t: Date.now(), url, method: (init && init.method) || (input && input.method) || 'GET' };
		try {
			let body = init && init.body;
			if (body == null && input instanceof Request) body = await input.clone().arrayBuffer();
			const bytes = await toBytes(body);
			if (bytes) {
				rec.reqB64 = b64(bytes);
				rec.reqLen = bytes.length;
			}
			rec.reqCT = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined)).get('content-type');
		} catch (e) {
			rec.reqErr = String(e);
		}
		window.__recon.push(rec);
		const resp = await origFetch.apply(this, arguments);
		rec.status = resp.status;
		rec.respCT = resp.headers.get('content-type');
		rec.chunks = [];
		(async () => {
			const reader = resp.clone().body.getReader();
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				rec.chunks.push({ dt: Date.now() - rec.t, b: b64(value) });
				total += value.length;
				if (total > 8e6) break;
			}
			rec.done = Date.now();
		})().catch(e => { rec.respErr = String(e); });
		return resp;
	};
})();
