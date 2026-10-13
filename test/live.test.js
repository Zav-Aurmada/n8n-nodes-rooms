'use strict';
/**
 * Live, FREE calls against production (https://rooms.aurmada.com). Run with ROOMS_LIVE=1.
 * Find (directory search), switchboard message to a house agent, broker quote (unpaid 402), receipt verify.
 * Never sends a payment.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const a = require('../dist/nodes/Rooms/actions.js');
const { fetchHttp } = require('./helpers.js');
const fx = require('./fixtures/broker-receipt.json');

const live = /^(1|true)$/i.test(String(require('node:process').env.ROOMS_LIVE || ''));
const B = 'https://rooms.aurmada.com';
// Guard: any request carrying a payment header fails the test run.
const http = async (r) => {
	const h = Object.keys(r.headers || {}).map((k) => k.toLowerCase());
	if (h.includes('payment-signature') || h.includes('x-payment')) throw new Error('live tests must never pay');
	return fetchHttp(r);
};

test('live: find agents', { skip: !live }, async () => {
	const r = await a.findAgents(http, B, { query: 'translate', perPage: 3 });
	assert.ok(r.total > 0 && r.listings.length > 0);
	assert.ok(r.listings.every((l) => typeof l.slug === 'string'));
	const x = await a.findAgents(http, B, { query: 'search', protocol: 'x402', perPage: 2 });
	assert.ok(x.listings.every((l) => l.protocols.includes('x402') || l.protocol === 'x402'));
});

test('live: message the translator through the switchboard', { skip: !live }, async () => {
	const r = await a.messageAgent(http, B, { to: 'translator', text: 'translate to French: thank you' });
	assert.ok(['answered', 'payment_required'].includes(r.status), JSON.stringify(r).slice(0, 300));
	if (r.status === 'answered') assert.match(r.text, /merci/i);
	assert.ok(r.answered_by || r.payment || r.status === 'payment_required');
});

test('live: quote a paid API (unpaid 402, free)', { skip: !live }, async () => {
	const q = await a.quotePaidApi(http, B, { slug: 'brave-search-api', path: '/res/v1/web/search', method: 'GET', query: { q: 'n8n' } });
	assert.match(q.price, /^\$0\.\d+/);
	assert.ok(a.usdToMicros(q.seller_price) <= 50000);
	assert.equal(q.amount_micros, a.usdToMicros(q.price));
	assert.match(q.pay_to, /^0x[0-9a-fA-F]{40}$/);
});

test('live: verify a known broker receipt locally and on the Rooms server', { skip: !live }, async () => {
	const v = await a.verifyReceipt(http, B, fx, 'both');
	assert.equal(v.valid, true, JSON.stringify(v).slice(0, 400));
	assert.equal(v.local.valid, true);
	assert.equal(v.server.valid, true);
	assert.equal(v.kind, 'rooms.broker-call');
	const bad = await a.verifyReceipt(http, B, { ...fx.receipt, payload: fx.receipt.payload.replace('GET', 'PUT') }, 'both');
	assert.equal(bad.valid, false);
	assert.equal(bad.server.valid, false);
});
