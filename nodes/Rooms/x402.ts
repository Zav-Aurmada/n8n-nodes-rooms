/**
 * Minimal, zero-dependency x402 "exact" (EIP-3009 on Base USDC) payment signer.
 *
 * Only `node:crypto` is used (allowed for n8n community nodes, including verified/Cloud ones):
 * keccak-256 and secp256k1 ECDSA (RFC 6979 deterministic nonces, low-s) are implemented here
 * with BigInt. The private key never leaves this module's call stack and is never logged.
 */
import { createHmac, randomBytes } from 'node:crypto';

// ------------------------------------------------------------------ keccak-256
const MASK64 = (1n << 64n) - 1n;
const RC: bigint[] = [
	0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
	0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
	0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
	0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
	0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
	0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
	0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const rotl = (x: bigint, n: number) =>
	n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

function keccakF(s: bigint[]) {
	for (let round = 0; round < 24; round++) {
		const c: bigint[] = [];
		for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
		for (let x = 0; x < 5; x++) {
			const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
			for (let y = 0; y < 25; y += 5) s[y + x] ^= d;
		}
		const b: bigint[] = new Array(25);
		for (let x = 0; x < 5; x++)
			for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
		for (let x = 0; x < 5; x++)
			for (let y = 0; y < 25; y += 5) s[y + x] = b[y + x] ^ (~b[y + ((x + 1) % 5)] & MASK64 & b[y + ((x + 2) % 5)]);
		s[0] ^= RC[round];
	}
}

/** keccak-256 (the Ethereum hash, not NIST SHA3-256). */
export function keccak256(data: Uint8Array): Uint8Array {
	const rate = 136;
	const padLen = rate - (data.length % rate);
	const msg = new Uint8Array(data.length + padLen);
	msg.set(data);
	msg[data.length] ^= 0x01;
	msg[msg.length - 1] ^= 0x80;
	const s: bigint[] = new Array(25).fill(0n);
	for (let off = 0; off < msg.length; off += rate) {
		for (let i = 0; i < rate / 8; i++) {
			let lane = 0n;
			for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + j]);
			s[i] ^= lane;
		}
		keccakF(s);
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) {
		let lane = s[i];
		for (let j = 0; j < 8; j++) {
			out[i * 8 + j] = Number(lane & 0xffn);
			lane >>= 8n;
		}
	}
	return out;
}

// ------------------------------------------------------------------ bytes helpers
export const toHex = (b: Uint8Array) =>
	'0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
	const s = h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
	if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('Invalid hex string');
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
}
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};
const bigToBytes32 = (n: bigint) => {
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(n & 0xffn);
		n >>= 8n;
	}
	return out;
};
const bytesToBig = (b: Uint8Array) => {
	let n = 0n;
	for (const x of b) n = (n << 8n) | BigInt(x);
	return n;
};
const utf8 = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------------ secp256k1
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
type Pt = { x: bigint; y: bigint } | null;
const mod = (a: bigint, m: bigint) => {
	const r = a % m;
	return r >= 0n ? r : r + m;
};
function inv(a: bigint, m: bigint): bigint {
	let [lo, hi] = [mod(a, m), m];
	let [x0, x1] = [1n, 0n];
	while (lo > 1n) {
		const q = hi / lo;
		[hi, lo] = [lo, hi - q * lo];
		[x1, x0] = [x0, x1 - q * x0];
	}
	return mod(x0, m);
}
function add(p: Pt, q: Pt): Pt {
	if (!p) return q;
	if (!q) return p;
	if (p.x === q.x) {
		if (mod(p.y + q.y, P) === 0n) return null;
		const l = mod(3n * p.x * p.x * inv(2n * p.y, P), P);
		const x = mod(l * l - 2n * p.x, P);
		return { x, y: mod(l * (p.x - x) - p.y, P) };
	}
	const l = mod((q.y - p.y) * inv(q.x - p.x, P), P);
	const x = mod(l * l - p.x - q.x, P);
	return { x, y: mod(l * (p.x - x) - p.y, P) };
}
function mul(k: bigint, p: Pt): Pt {
	let r: Pt = null;
	let a: Pt = p;
	while (k > 0n) {
		if (k & 1n) r = add(r, a);
		a = add(a, a);
		k >>= 1n;
	}
	return r;
}
const G: Pt = { x: GX, y: GY };

function parsePrivateKey(hex: string): bigint {
	const s = String(hex || '').trim();
	if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s))
		throw new Error('The wallet private key must be 32 bytes of hex (64 characters, optional 0x).');
	const d = bytesToBig(fromHex(s));
	if (d <= 0n || d >= N) throw new Error('The wallet private key is out of range.');
	return d;
}

function checksum(addrHex40: string): string {
	const lower = addrHex40.toLowerCase();
	const h = toHex(keccak256(utf8(lower))).slice(2);
	let out = '0x';
	for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
	return out;
}
/** EIP-55 checksummed address. Throws on anything that is not a 20-byte hex address. */
export function getAddress(a: string): string {
	if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new Error(`Invalid EVM address: ${String(a).slice(0, 60)}`);
	return checksum(a.slice(2));
}
export function addressFromPrivateKey(privHex: string): string {
	const pub = mul(parsePrivateKey(privHex), G);
	if (!pub) throw new Error('Invalid private key');
	const h = keccak256(concat(bigToBytes32(pub.x), bigToBytes32(pub.y)));
	return checksum(toHex(h.slice(12)).slice(2));
}

/** RFC 6979 (HMAC-SHA256) deterministic k. */
function rfc6979(d: bigint, h1: Uint8Array, extra = 0): bigint {
	const x = bigToBytes32(d);
	const hm = bigToBytes32(mod(bytesToBig(h1), N));
	let v: Uint8Array = new Uint8Array(32).fill(1);
	let k: Uint8Array = new Uint8Array(32).fill(0);
	const hmac = (key: Uint8Array, ...data: Uint8Array[]) =>
		new Uint8Array(createHmac('sha256', key).update(concat(...data)).digest());
	k = hmac(k, v, Uint8Array.of(0), x, hm);
	v = hmac(k, v);
	k = hmac(k, v, Uint8Array.of(1), x, hm);
	v = hmac(k, v);
	for (let skipped = 0; ; ) {
		v = hmac(k, v);
		const t = bytesToBig(v);
		if (t > 0n && t < N) {
			if (skipped++ >= extra) return t;
		}
		k = hmac(k, v, Uint8Array.of(0));
		v = hmac(k, v);
	}
}

/** Sign a 32-byte digest. Returns the 65-byte r||s||v signature (v = 27/28), low-s normalized. */
export function signDigest(digest: Uint8Array, privHex: string): string {
	if (digest.length !== 32) throw new Error('digest must be 32 bytes');
	const d = parsePrivateKey(privHex);
	const z = mod(bytesToBig(digest), N);
	for (let attempt = 0; attempt < 8; attempt++) {
		const k = rfc6979(d, digest, attempt);
		const R = mul(k, G);
		if (!R) continue;
		const r = mod(R.x, N);
		if (r === 0n) continue;
		let s = mod(inv(k, N) * (z + r * d), N);
		if (s === 0n) continue;
		let recid = Number(R.y & 1n) | (R.x >= N ? 2 : 0);
		if (s > N / 2n) {
			s = N - s;
			recid ^= 1;
		}
		return toHex(concat(bigToBytes32(r), bigToBytes32(s), Uint8Array.of(27 + recid)));
	}
	throw new Error('Could not sign');
}

// ------------------------------------------------------------------ EIP-712 / EIP-3009
const DOMAIN_TYPEHASH = keccak256(
	utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);
const TWA_TYPEHASH = keccak256(
	utf8(
		'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
	),
);
const addr32 = (a: string) => concat(new Uint8Array(12), fromHex(getAddress(a)));

export interface Eip3009Authorization {
	from: string;
	to: string;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: string;
}
export interface Eip712Domain {
	name: string;
	version: string;
	chainId: number;
	verifyingContract: string;
}
export function transferWithAuthorizationDigest(domain: Eip712Domain, a: Eip3009Authorization) {
	const domainSep = keccak256(
		concat(
			DOMAIN_TYPEHASH,
			keccak256(utf8(domain.name)),
			keccak256(utf8(domain.version)),
			bigToBytes32(BigInt(domain.chainId)),
			addr32(domain.verifyingContract),
		),
	);
	const nonce = fromHex(a.nonce);
	if (nonce.length !== 32) throw new Error('nonce must be bytes32');
	const struct = keccak256(
		concat(
			TWA_TYPEHASH,
			addr32(a.from),
			addr32(a.to),
			bigToBytes32(BigInt(a.value)),
			bigToBytes32(BigInt(a.validAfter)),
			bigToBytes32(BigInt(a.validBefore)),
			nonce,
		),
	);
	return keccak256(concat(Uint8Array.of(0x19, 0x01), domainSep, struct));
}

// ------------------------------------------------------------------ x402
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export interface PaymentRequirements {
	scheme: string;
	network: string;
	amount?: string;
	maxAmountRequired?: string;
	asset: string;
	payTo: string;
	maxTimeoutSeconds?: number;
	extra?: { name?: string; version?: string; [k: string]: unknown };
	[k: string]: unknown;
}
export interface PaymentRequired {
	x402Version: number;
	resource?: unknown;
	accepts: PaymentRequirements[];
	extensions?: Record<string, unknown>;
	[k: string]: unknown;
}

export const decodeB64Json = <T = unknown>(v: string): T =>
	JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as T;
export const encodeB64Json = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

const isBase = (net: string) => net === 'eip155:8453' || net === 'base';
export const amountOf = (r: PaymentRequirements) => BigInt(r.amount ?? r.maxAmountRequired ?? '0');

/** Pick the one payment option this node will pay: exact scheme, Base, USDC. */
export function selectBaseUsdc(accepts: PaymentRequirements[] | undefined): PaymentRequirements | undefined {
	return (accepts || []).find(
		(r) =>
			r &&
			r.scheme === 'exact' &&
			isBase(String(r.network)) &&
			String(r.asset).toLowerCase() === BASE_USDC.toLowerCase(),
	);
}

/**
 * Build the x402 payment header for `requirements`. v2 → PAYMENT-SIGNATURE, v1 → X-PAYMENT.
 * `now`/`nonce` are injectable for tests.
 */
export function buildPaymentHeader(
	paymentRequired: PaymentRequired,
	requirements: PaymentRequirements,
	privHex: string,
	opts: { now?: number; nonce?: string } = {},
): { name: string; value: string; from: string; authorization: Eip3009Authorization } {
	if (!requirements.extra?.name || !requirements.extra?.version)
		throw new Error('Payment terms are missing the EIP-712 domain (name, version).');
	const from = addressFromPrivateKey(privHex);
	const now = opts.now ?? Math.floor(Date.now() / 1000);
	const v1 = paymentRequired.x402Version === 1;
	const authorization: Eip3009Authorization = {
		from,
		to: getAddress(requirements.payTo),
		value: amountOf(requirements).toString(),
		validAfter: v1 ? String(now - 600) : '0',
		validBefore: String(now + Number(requirements.maxTimeoutSeconds || 300)),
		nonce: opts.nonce ?? toHex(new Uint8Array(randomBytes(32))),
	};
	const digest = transferWithAuthorizationDigest(
		{
			name: String(requirements.extra.name),
			version: String(requirements.extra.version),
			chainId: BASE_CHAIN_ID,
			verifyingContract: getAddress(requirements.asset),
		},
		authorization,
	);
	const signature = signDigest(digest, privHex);
	const payload = { authorization, signature };
	if (v1) {
		return {
			name: 'X-PAYMENT',
			value: encodeB64Json({ x402Version: 1, scheme: requirements.scheme, network: requirements.network, payload }),
			from,
			authorization,
		};
	}
	return {
		name: 'PAYMENT-SIGNATURE',
		value: encodeB64Json({
			x402Version: paymentRequired.x402Version,
			payload,
			extensions: paymentRequired.extensions,
			resource: paymentRequired.resource,
			accepted: requirements,
		}),
		from,
		authorization,
	};
}
