'use strict';
/** fetch-based implementation of the node's tiny Http interface, for tests. */
const UA = 'n8n-nodes-rooms-test/0.1.0';
async function fetchHttp(req) {
	const u = new URL(req.url);
	for (const [k, v] of Object.entries(req.qs || {})) u.searchParams.set(k, String(v));
	const headers = { accept: 'application/json', 'user-agent': UA, ...(req.headers || {}) };
	let body;
	if (req.body !== undefined && req.method !== 'GET') {
		headers['content-type'] = 'application/json';
		body = JSON.stringify(req.body);
	}
	const res = await fetch(u, { method: req.method, headers, body, signal: AbortSignal.timeout(req.timeout || 30000) });
	const text = await res.text();
	let parsed = text;
	try { parsed = JSON.parse(text); } catch { /* keep text */ }
	const h = {};
	res.headers.forEach((v, k) => { h[k] = v; });
	return { status: res.status, headers: h, body: parsed };
}
module.exports = { fetchHttp, UA };
