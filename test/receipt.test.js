'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractReceipt, verifyLocally } = require('../dist/nodes/Rooms/receipt.js');
const fx = require('./fixtures/broker-receipt.json');
const key = require('./fixtures/receipt-key.json');

test('a real broker-call receipt verifies offline', () => {
	const r = extractReceipt(fx); // whole answer shape {receipt: {...}}
	const v = verifyLocally(r, key);
	assert.equal(v.valid, true, v.message);
	assert.equal(v.kind, 'rooms.broker-call');
	assert.equal(v.fields.listing, 'apitoll-crypto-defi-market-data');
	assert.equal(extractReceipt(JSON.stringify(fx.receipt)).signature, fx.receipt.signature);
});

test('tampered payload or foreign key fails', () => {
	const bad = { ...fx.receipt, payload: fx.receipt.payload.replace('$0.002', '$0.001') };
	assert.equal(verifyLocally(bad, key).error, 'bad_signature');
	assert.equal(verifyLocally({ ...fx.receipt, kid: 'other' }, key).error, 'unknown_key');
	assert.equal(extractReceipt('not json'), null);
	assert.equal(extractReceipt({ foo: 1 }), null);
});
