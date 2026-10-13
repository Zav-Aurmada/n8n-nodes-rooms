'use strict';
/** Runs the actual n8n node class with a minimal IExecuteFunctions stand-in (live free calls when ROOMS_LIVE=1). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Rooms } = require('../dist/nodes/Rooms/Rooms.node.js');
const { RoomsApi } = require('../dist/credentials/RoomsApi.credentials.js');
const { RoomsX402WalletApi } = require('../dist/credentials/RoomsX402WalletApi.credentials.js');
const fx = require('./fixtures/broker-receipt.json');

const live = /^(1|true)$/i.test(String(require('node:process').env.ROOMS_LIVE || ''));

function ctx(params, { creds = {} } = {}) {
	const requests = [];
	const self = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, def) => (name in params ? params[name] : def),
		getNode: () => ({ name: 'Rooms', type: 'n8n-nodes-rooms.rooms', typeVersion: 1, parameters: {} }),
		continueOnFail: () => false,
		getCredentials: async (name) => { if (!creds[name]) throw new Error('no credentials'); return creds[name]; },
		helpers: {
			httpRequest: async (o) => {
				requests.push(o);
				const h = Object.keys(o.headers || {}).map((k) => k.toLowerCase());
				if (h.includes('payment-signature') || h.includes('x-payment')) throw new Error('test must never pay');
				const u = new URL(o.url);
				for (const [k, v] of Object.entries(o.qs || {})) u.searchParams.set(k, String(v));
				const res = await fetch(u, { method: o.method, headers: { ...o.headers, ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
				const t = await res.text(); let b = t; try { b = JSON.parse(t); } catch { /* text */ }
				const hd = {}; res.headers.forEach((v, k) => { hd[k] = v; });
				return { statusCode: res.status, headers: hd, body: b };
			},
			httpRequestWithAuthentication: async () => { throw new Error('not used in this test'); },
		},
		requests,
	};
	return self;
}

test('node description is well-formed', () => {
	const d = new Rooms().description;
	assert.equal(d.name, 'rooms');
	assert.equal(d.usableAsTool, true);
	const ops = d.properties.filter((p) => p.name === 'operation').flatMap((p) => p.options.map((o) => o.value));
	assert.deepEqual(ops.sort(), ['call', 'find', 'message', 'quote', 'verify']);
	assert.equal(new RoomsX402WalletApi().properties[0].typeOptions.password, true);
	assert.equal(new RoomsApi().properties[0].typeOptions.password, true);
	const wallet = d.credentials.find((c) => c.name === 'roomsX402WalletApi');
	assert.deepEqual(wallet.displayOptions.show, { resource: ['paidApi'], operation: ['call'] });
});

test('node: find (live, free)', { skip: !live }, async () => {
	const c = ctx({ resource: 'agent', operation: 'find', query: 'web search', protocol: 'any', limit: 3, splitIntoItems: true, findOptions: {} });
	const [out] = await new Rooms().execute.call(c);
	assert.ok(out.length > 0 && out.length <= 3);
	assert.ok(out[0].json.slug);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
});

test('node: quote (live, free)', { skip: !live }, async () => {
	const c = ctx({ resource: 'paidApi', operation: 'quote', slug: 'brave-search-api', path: '/res/v1/web/search', method: 'GET', query: '{"q":"n8n"}', body: '{}' });
	const [out] = await new Rooms().execute.call(c);
	assert.match(out[0].json.price, /^\$/);
	assert.ok(Array.isArray(out[0].json.accepts));
});

test('node: verify receipt (live, free)', { skip: !live }, async () => {
	const c = ctx({ resource: 'receipt', operation: 'verify', receipt: JSON.stringify(fx.receipt), checkWith: 'both' });
	const [out] = await new Rooms().execute.call(c);
	assert.equal(out[0].json.valid, true);
});
