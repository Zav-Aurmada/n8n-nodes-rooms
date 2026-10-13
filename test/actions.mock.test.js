'use strict';
/** Offline: the paid-call flow against a mocked broker. No network, no money. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const a = require('../dist/nodes/Rooms/actions.js');
const x = require('../dist/nodes/Rooms/x402.js');
const { privateKeyToAccount } = require('viem/accounts');
const { recoverTypedDataAddress } = require('viem');

const B = 'https://rooms.example';
const PAY_TO = '0xEf56E1Fa792B8F3e87dcB09fA36261D213c10a09';
const { privateKey: edPriv, publicKey: edPub } = crypto.generateKeyPairSync('ed25519');
const keyDoc = { kid: 'k1', jwk: { ...edPub.export({ format: 'jwk' }) } };
const sign = (payload) => ({ alg: 'Ed25519', kid: 'k1', payload, signature: crypto.sign(null, Buffer.from(payload), edPriv).toString('base64url') });

function broker({ seller = '$0.005', price = '$0.006', amount = '6000', paidStatus = 200, funded = true } = {}) {
	const calls = [];
	const req = { scheme: 'exact', network: 'eip155:8453', amount, asset: x.BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };
	const pr = { x402Version: 2, resource: { url: `${B}/x402/v1/broker/brave-search-api` }, accepts: [req] };
	const http = async (r) => {
		calls.push(r);
		if (r.url.endsWith('/x402/v1/receipt-key')) return { status: 200, headers: {}, body: keyDoc };
		if (r.url.includes('/x402/v1/broker/')) {
			const sig = r.headers && r.headers['PAYMENT-SIGNATURE'];
			if (!sig) return { status: 402, headers: { 'payment-required': x.encodeB64Json(pr) }, body: { x402Version: 1, price, seller_price: seller, rooms_fee: '$0.001', name: 'Brave Search API', broker_funded: funded, accepts: [] } };
			if (paidStatus !== 200) return { status: paidStatus, headers: {}, body: { error: 'seller_failed', message: 'Brave answered 500.' } };
			const payload = JSON.stringify({ kind: 'rooms.broker-call', listing: 'brave-search-api', price });
			return { status: 200, headers: { 'payment-response': x.encodeB64Json({ success: true, transaction: '0xabc' }) }, body: { ok: true, call_id: 'bc_1', seller: { status: 200, body: { web: [] } }, price, receipt: sign(payload) } };
		}
		return { status: 404, headers: {}, body: {} };
	};
	return { http, calls, req };
}

test('quote parses price, seller price, fee, payTo and the exact POST', async () => {
	const { http } = broker();
	const q = await a.quotePaidApi(http, B, { slug: 'brave-search-api', path: '/res/v1/web/search', method: 'GET', query: { q: 'n8n' } });
	assert.equal(q.price, '$0.006'); assert.equal(q.seller_price, '$0.005'); assert.equal(q.amount_micros, 6000);
	assert.equal(q.pay_to, PAY_TO);
	assert.deepEqual(q.call.json, { path: '/res/v1/web/search', method: 'GET', query: { q: 'n8n' } });
});

test('paid call: signs exactly the quoted amount, one paid request, receipt checked', async () => {
	const pk = '0x' + crypto.randomBytes(32).toString('hex');
	const { http, calls, req } = broker();
	const out = await a.callPaidApi(http, B, { slug: 'brave-search-api', query: { q: 'n8n' } }, pk);
	assert.equal(out.ok, true);
	assert.equal(out.receipt_check.valid, true);
	assert.equal(out.payment.transaction, '0xabc');
	assert.equal(out.paid_from, privateKeyToAccount(pk).address);
	const paid = calls.filter((c) => c.headers && c.headers['PAYMENT-SIGNATURE']);
	assert.equal(paid.length, 1);
	const d = x.decodeB64Json(paid[0].headers['PAYMENT-SIGNATURE']);
	assert.equal(d.payload.authorization.value, '6000');
	const rec = await recoverTypedDataAddress({
		domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: x.BASE_USDC },
		types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
		primaryType: 'TransferWithAuthorization',
		message: { ...d.payload.authorization, value: 6000n, validAfter: 0n, validBefore: BigInt(d.payload.authorization.validBefore) },
		signature: d.payload.signature,
	});
	assert.equal(rec, out.paid_from);
	assert.deepEqual(d.accepted, req);
	assert.ok(!JSON.stringify(out).includes(pk.slice(2)), 'the key never appears in the output');
});

test('refuses before signing when the seller price is over the limit', async () => {
	const { http, calls } = broker({ seller: '$0.06', price: '$0.072', amount: '72000' });
	await assert.rejects(a.callPaidApi(http, B, { slug: 'brave-search-api' }, '0x' + '11'.repeat(32)), /above your limit/);
	assert.equal(calls.filter((c) => c.headers && c.headers['PAYMENT-SIGNATURE']).length, 0);
	const lower = broker({ seller: '$0.02', price: '$0.024', amount: '24000' });
	await assert.rejects(a.callPaidApi(lower.http, B, { slug: 'brave-search-api', maxSellerPriceUsd: 0.01 }, '0x' + '11'.repeat(32)), /above your limit/);
	// a user value above the hard $0.05 limit is clamped
	const over = broker({ seller: '$0.051', price: '$0.0612', amount: '61200' });
	await assert.rejects(a.callPaidApi(over.http, B, { slug: 'brave-search-api', maxSellerPriceUsd: 5 }, '0x' + '11'.repeat(32)), /above your limit of \$0.05/);
});

test('refuses when the all-in amount exceeds seller price + margin, or broker unfunded', async () => {
	const g = broker({ seller: '$0.005', price: '$0.05', amount: '50000' });
	await assert.rejects(a.callPaidApi(g.http, B, { slug: 'brave-search-api' }, '0x' + '11'.repeat(32)), /above seller price \+ margin/);
	const u = broker({ funded: false });
	await assert.rejects(a.callPaidApi(u.http, B, { slug: 'brave-search-api' }, '0x' + '11'.repeat(32)), /not funded/);
});

test('seller failure: one paid attempt, no retry, says not charged', async () => {
	const { http, calls } = broker({ paidStatus: 502 });
	await assert.rejects(a.callPaidApi(http, B, { slug: 'brave-search-api' }, '0x' + '22'.repeat(32)), /not charged/);
	assert.equal(calls.filter((c) => c.headers && c.headers['PAYMENT-SIGNATURE']).length, 1);
});

test('bad inputs are rejected before any request', async () => {
	let n = 0;
	const http = async () => { n++; return { status: 500, headers: {}, body: {} }; };
	await assert.rejects(a.quotePaidApi(http, B, { slug: '../etc' }), /not a Rooms listing slug/);
	await assert.rejects(a.messageAgent(http, B, { to: 'translator', text: '' }), /Text is required/);
	await assert.rejects(a.verifyReceipt(http, B, 'hello'), /Give a Rooms receipt/);
	assert.equal(n, 0);
	assert.equal(a.usdToMicros('$0.0072'), 7200);
});
