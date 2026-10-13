'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const x = require('../dist/nodes/Rooms/x402.js');
const { privateKeyToAccount } = require('viem/accounts');
const { recoverTypedDataAddress, keccak256: vk } = require('viem');

const enc = (s) => new TextEncoder().encode(s);
const TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
	],
};

test('keccak256 known vectors', () => {
	assert.equal(x.toHex(x.keccak256(enc(''))), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
	assert.equal(x.toHex(x.keccak256(enc('abc'))), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
	for (const n of [1, 135, 136, 137, 272, 500]) {
		const b = new Uint8Array(randomBytes(n));
		assert.equal(x.toHex(x.keccak256(b)), vk(b), `length ${n}`);
	}
});

test('address derivation and EIP-55 match viem', () => {
	for (let i = 0; i < 5; i++) {
		const pk = '0x' + randomBytes(32).toString('hex');
		assert.equal(x.addressFromPrivateKey(pk), privateKeyToAccount(pk).address);
	}
	assert.equal(x.getAddress(x.BASE_USDC.toLowerCase()), x.BASE_USDC);
	assert.throws(() => x.addressFromPrivateKey('0x1234'), /32 bytes/);
});

test('EIP-3009 typed-data signature is byte-identical to viem (RFC 6979) and recovers', async () => {
	for (let i = 0; i < 4; i++) {
		const pk = '0x' + randomBytes(32).toString('hex');
		const acct = privateKeyToAccount(pk);
		const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: x.BASE_USDC };
		const auth = {
			from: acct.address, to: '0xEf56E1Fa792B8F3e87dcB09fA36261D213c10a09', value: String(6000 + i),
			validAfter: '0', validBefore: String(1800000000 + i), nonce: '0x' + randomBytes(32).toString('hex'),
		};
		const ours = x.signDigest(x.transferWithAuthorizationDigest(domain, auth), pk);
		const message = { ...auth, value: BigInt(auth.value), validAfter: 0n, validBefore: BigInt(auth.validBefore) };
		const theirs = await acct.signTypedData({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message });
		assert.equal(ours, theirs);
		const rec = await recoverTypedDataAddress({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message, signature: ours });
		assert.equal(rec, acct.address);
	}
});

test('buildPaymentHeader: v2 PAYMENT-SIGNATURE shape, v1 X-PAYMENT shape', async () => {
	const pk = '0x' + randomBytes(32).toString('hex');
	const req = { scheme: 'exact', network: 'eip155:8453', amount: '6000', asset: x.BASE_USDC, payTo: '0xef56e1fa792b8f3e87dcb09fa36261d213c10a09', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };
	const pr = { x402Version: 2, resource: { url: 'https://rooms.aurmada.com/x402/v1/broker/x' }, accepts: [req], extensions: { bazaar: {} } };
	const h = x.buildPaymentHeader(pr, req, pk, { now: 1800000000 });
	assert.equal(h.name, 'PAYMENT-SIGNATURE');
	const d = x.decodeB64Json(h.value);
	assert.equal(d.x402Version, 2);
	assert.deepEqual(d.accepted, req);
	assert.deepEqual(d.resource, pr.resource);
	assert.equal(d.payload.authorization.value, '6000');
	assert.equal(d.payload.authorization.validAfter, '0');
	assert.equal(d.payload.authorization.validBefore, '1800000300');
	assert.equal(d.payload.authorization.to, '0xEf56E1Fa792B8F3e87dcB09fA36261D213c10a09');
	assert.equal(d.payload.authorization.from, privateKeyToAccount(pk).address);
	assert.ok(!h.value.includes(pk.slice(2)), 'key must never appear in the header');
	const v1req = { ...req, network: 'base', amount: undefined, maxAmountRequired: '6000' };
	const h1 = x.buildPaymentHeader({ x402Version: 1, accepts: [v1req] }, v1req, pk, { now: 1800000000 });
	assert.equal(h1.name, 'X-PAYMENT');
	const d1 = x.decodeB64Json(h1.value);
	assert.equal(d1.scheme, 'exact'); assert.equal(d1.network, 'base'); assert.equal(d1.payload.authorization.validAfter, String(1800000000 - 600));
});

test('selectBaseUsdc only takes exact / Base / USDC', () => {
	assert.equal(x.selectBaseUsdc([{ scheme: 'exact', network: 'eip155:1', asset: x.BASE_USDC }]), undefined);
	assert.equal(x.selectBaseUsdc([{ scheme: 'upto', network: 'eip155:8453', asset: x.BASE_USDC }]), undefined);
	assert.equal(x.selectBaseUsdc([{ scheme: 'exact', network: 'eip155:8453', asset: '0x0000000000000000000000000000000000000001' }]), undefined);
	assert.ok(x.selectBaseUsdc([{ scheme: 'exact', network: 'base', asset: x.BASE_USDC.toLowerCase() }]));
});
