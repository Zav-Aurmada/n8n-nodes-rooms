/** Offline check of a Rooms Ed25519-signed receipt against the published key (GET /x402/v1/receipt-key). */
import { createPublicKey, verify as edVerify } from 'node:crypto';

export interface SignedReceipt {
	alg?: string;
	kid?: string;
	payload: string;
	signature: string;
	key_url?: string;
}
export interface ReceiptKeyDoc {
	kid: string;
	jwk: { kty: string; crv: string; x: string; [k: string]: unknown };
	public_key_pem?: string;
}
export interface LocalCheck {
	valid: boolean;
	error?: string;
	message: string;
	kid?: string;
	kind?: string;
	fields?: Record<string, unknown>;
}

/** Accept a receipt object, a whole broker answer ({receipt: {...}}), or a JSON string of either. */
export function extractReceipt(input: unknown): SignedReceipt | null {
	let v: unknown = input;
	if (typeof v === 'string') {
		const s = v.trim();
		if (!s.startsWith('{')) return null;
		try {
			v = JSON.parse(s);
		} catch {
			return null;
		}
	}
	if (!v || typeof v !== 'object') return null;
	const o = v as Record<string, unknown>;
	const r = (o.receipt && typeof o.receipt === 'object' ? o.receipt : o) as Record<string, unknown>;
	if (typeof r.payload !== 'string' || typeof r.signature !== 'string') return null;
	return {
		alg: typeof r.alg === 'string' ? r.alg : undefined,
		kid: typeof r.kid === 'string' ? r.kid : undefined,
		payload: r.payload,
		signature: r.signature,
		key_url: typeof r.key_url === 'string' ? r.key_url : undefined,
	};
}

export function verifyLocally(receipt: SignedReceipt, key: ReceiptKeyDoc): LocalCheck {
	if (receipt.alg && receipt.alg !== 'Ed25519')
		return { valid: false, error: 'unsupported_alg', message: `Unsupported algorithm ${receipt.alg}.` };
	if (receipt.kid && key.kid && receipt.kid !== key.kid)
		return {
			valid: false,
			error: 'unknown_key',
			kid: receipt.kid,
			message: `Signed with key ${receipt.kid}, which isn't the current Rooms receipt key (${key.kid}).`,
		};
	let ok = false;
	try {
		const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.jwk.x }, format: 'jwk' });
		ok = edVerify(null, Buffer.from(receipt.payload, 'utf8'), pub, Buffer.from(receipt.signature, 'base64url'));
	} catch (e) {
		return { valid: false, error: 'verify_failed', message: `Could not run the check: ${(e as Error).message}` };
	}
	if (!ok)
		return {
			valid: false,
			error: 'bad_signature',
			kid: key.kid,
			message: "The signature doesn't match: the receipt was changed or wasn't signed by Rooms.",
		};
	let fields: Record<string, unknown> | undefined;
	try {
		const p = JSON.parse(receipt.payload);
		if (p && typeof p === 'object' && !Array.isArray(p)) fields = p as Record<string, unknown>;
	} catch {
		fields = undefined;
	}
	return {
		valid: true,
		kid: key.kid,
		kind: typeof fields?.kind === 'string' ? (fields.kind as string) : undefined,
		fields,
		message: 'Valid: signed by Rooms by Aurmada with its Ed25519 receipt key, and not changed since.',
	};
}
