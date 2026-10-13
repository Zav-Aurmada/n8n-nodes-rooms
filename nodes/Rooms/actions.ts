/**
 * Rooms by Aurmada API calls, written against a tiny HTTP interface so they run the same inside n8n
 * (this.helpers.httpRequest) and in tests.
 */
import {
	amountOf,
	buildPaymentHeader,
	decodeB64Json,
	selectBaseUsdc,
	type PaymentRequired,
} from './x402';
import { extractReceipt, verifyLocally, type LocalCheck, type ReceiptKeyDoc } from './receipt';

export const DEFAULT_BASE_URL = 'https://rooms.aurmada.com';
/** Hard ceiling on the seller's price for a paid call through this node (USD). */
export const MAX_SELLER_PRICE_USD = 0.05;

export interface HttpReq {
	method: 'GET' | 'POST';
	url: string;
	qs?: Record<string, string | number | boolean>;
	body?: unknown;
	headers?: Record<string, string>;
	timeout?: number;
}
export interface HttpRes {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}
export type Http = (req: HttpReq) => Promise<HttpRes>;

export class RoomsError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = 'RoomsError';
	}
}

const trimBase = (b?: string) => String(b || DEFAULT_BASE_URL).replace(/\/+$/, '');
const slugOk = (s: string) => {
	const v = String(s || '').trim();
	if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(v)) throw new RoomsError(`"${v.slice(0, 60)}" is not a Rooms listing slug.`);
	return v;
};
const obj = (b: unknown): Record<string, unknown> =>
	b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
const apiError = (what: string, r: HttpRes) => {
	const b = obj(r.body);
	const msg = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : '';
	return new RoomsError(`${what} failed (HTTP ${r.status})${msg ? `: ${msg}` : ''}`, r.status, r.body);
};
/** "$0.006" → 6000 (USDC atomic units, 6 decimals). */
export function usdToMicros(v: unknown): number | null {
	const m = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(String(v ?? '').trim());
	return m ? Math.round(Number(m[1]) * 1e6) : null;
}
const header = (h: Record<string, string>, name: string) => {
	const k = Object.keys(h || {}).find((x) => x.toLowerCase() === name.toLowerCase());
	return k ? String(h[k]) : undefined;
};

// ------------------------------------------------------------------ Find Agent
export interface FindInput {
	query?: string;
	protocol?: string;
	category?: string;
	verified?: boolean;
	page?: number;
	perPage?: number;
}
export async function findAgents(http: Http, base: string | undefined, input: FindInput) {
	const qs: Record<string, string | number> = {};
	if (input.query) qs.q = input.query;
	if (input.protocol && input.protocol !== 'any') qs.protocol = input.protocol;
	if (input.category) qs.category = input.category;
	if (input.verified) qs.verified = 1;
	qs.page = Math.max(1, Math.floor(input.page || 1));
	qs.per_page = Math.min(100, Math.max(1, Math.floor(input.perPage || 10)));
	const r = await http({ method: 'GET', url: `${trimBase(base)}/api/v1/directory`, qs });
	if (r.status !== 200) throw apiError('Directory search', r);
	return obj(r.body) as {
		total?: number;
		page?: number;
		pages?: number;
		listings?: Array<Record<string, unknown>>;
	};
}

// ------------------------------------------------------------------ Message Agent (switchboard)
export interface MessageInput {
	to: string;
	text: string;
	tool?: string;
	arguments?: Record<string, unknown>;
}
export async function messageAgent(http: Http, base: string | undefined, input: MessageInput) {
	const body: Record<string, unknown> = { to: slugOk(input.to), text: String(input.text || '') };
	if (!body.text) throw new RoomsError('Text is required.');
	if (input.tool) body.tool = input.tool;
	if (input.arguments && Object.keys(input.arguments).length) body.arguments = input.arguments;
	const r = await http({ method: 'POST', url: `${trimBase(base)}/api/v1/switchboard`, body, timeout: 45_000 });
	// 200 answered; 402-style payment_required comes back as a normal JSON result we pass on.
	const b = obj(r.body);
	if (r.status >= 200 && r.status < 300) return b;
	if (b.status === 'payment_required') return b;
	throw apiError('Switchboard message', r);
}

// ------------------------------------------------------------------ Quote Paid API (free)
export interface BrokerInput {
	slug: string;
	path?: string;
	method?: string;
	query?: Record<string, unknown>;
	body?: unknown;
}
const brokerBody = (i: BrokerInput) => {
	const b: Record<string, unknown> = {};
	if (i.path) b.path = i.path;
	if (i.method && i.method !== 'default') b.method = i.method;
	if (i.query && Object.keys(i.query).length) b.query = i.query;
	if (i.body !== undefined && i.body !== null && !(typeof i.body === 'object' && !Object.keys(i.body as object).length))
		b.body = i.body;
	return b;
};

export interface Quote {
	listing: string;
	name?: string;
	price: string;
	seller_price?: string;
	rooms_fee?: string;
	amount_micros: number;
	currency: 'USDC';
	network: string;
	pay_to: string;
	broker_funded?: boolean;
	call: { method: 'POST'; url: string; json: Record<string, unknown> };
	quoted_at: string;
	paymentRequired: PaymentRequired;
}

export async function quotePaidApi(http: Http, base: string | undefined, input: BrokerInput): Promise<Quote> {
	const slug = slugOk(input.slug);
	const url = `${trimBase(base)}/x402/v1/broker/${slug}`;
	const json = brokerBody(input);
	const r = await http({ method: 'POST', url, body: json, timeout: 30_000 });
	if (r.status !== 402) {
		if (r.status >= 200 && r.status < 300)
			throw new RoomsError('Rooms answered without asking for payment, which a quote should never do.', r.status, r.body);
		throw apiError('Quote', r);
	}
	const b = obj(r.body);
	const h = header(r.headers, 'payment-required');
	let pr: PaymentRequired;
	if (h) pr = decodeB64Json<PaymentRequired>(h);
	else if (Array.isArray(b.accepts)) pr = { x402Version: Number(b.x402Version || 1), accepts: b.accepts as never };
	else throw new RoomsError('The quote had no payment terms.', r.status, r.body);
	const req = selectBaseUsdc(pr.accepts);
	if (!req) throw new RoomsError('No USDC-on-Base payment option was offered.', r.status, pr);
	const amount = Number(amountOf(req));
	return {
		listing: slug,
		name: typeof b.name === 'string' ? b.name : undefined,
		price: typeof b.price === 'string' ? b.price : `$${amount / 1e6}`,
		seller_price: typeof b.seller_price === 'string' ? b.seller_price : undefined,
		rooms_fee: typeof b.rooms_fee === 'string' ? b.rooms_fee : undefined,
		amount_micros: amount,
		currency: 'USDC',
		network: 'Base (eip155:8453)',
		pay_to: String(req.payTo),
		broker_funded: typeof b.broker_funded === 'boolean' ? b.broker_funded : undefined,
		call: { method: 'POST', url, json },
		quoted_at: new Date().toISOString(),
		paymentRequired: pr,
	};
}

// ------------------------------------------------------------------ Verify Receipt
export async function fetchReceiptKey(http: Http, base: string | undefined): Promise<ReceiptKeyDoc> {
	const r = await http({ method: 'GET', url: `${trimBase(base)}/x402/v1/receipt-key` });
	if (r.status !== 200) throw apiError('Fetching the receipt key', r);
	const k = obj(r.body) as unknown as ReceiptKeyDoc;
	if (!k.jwk || typeof k.jwk.x !== 'string') throw new RoomsError('The receipt key document is malformed.');
	return k;
}

export type VerifyMode = 'both' | 'local' | 'server';
export async function verifyReceipt(http: Http, base: string | undefined, input: unknown, mode: VerifyMode = 'both') {
	const raw = typeof input === 'string' ? input.trim() : '';
	const job = /^(?:.*\/)?(oj_[\w-]{4,40})\/?$/.exec(raw);
	if (job) {
		const r = await http({ method: 'GET', url: `${trimBase(base)}/api/v1/jobs/${job[1]}/receipt/verify` });
		if (r.status !== 200) throw apiError('Job receipt check', r);
		return { type: 'job', job_id: job[1], checked_on: 'server', ...obj(r.body) };
	}
	const receipt = extractReceipt(input);
	if (!receipt)
		throw new RoomsError(
			'Give a Rooms receipt (an object with payload and signature, or the whole paid-call answer), or a job id (oj_…).',
		);
	const out: Record<string, unknown> = { type: 'signed' };
	let local: LocalCheck | undefined;
	if (mode !== 'server') {
		local = verifyLocally(receipt, await fetchReceiptKey(http, base));
		out.local = { valid: local.valid, error: local.error, message: local.message, kid: local.kid };
	}
	let server: Record<string, unknown> | undefined;
	if (mode !== 'local') {
		const r = await http({ method: 'POST', url: `${trimBase(base)}/api/v1/receipts/verify`, body: { receipt } });
		if (r.status !== 200) throw apiError('Receipt check', r);
		server = obj(r.body);
		out.server = { valid: server.valid === true, error: server.error, message: server.message, kid: server.kid };
	}
	const valid = (local ? local.valid : true) && (server ? server.valid === true : true);
	const fields = local?.fields ?? (server?.fields as Record<string, unknown> | undefined);
	return {
		valid,
		kind: local?.kind ?? (typeof server?.kind === 'string' ? server.kind : undefined),
		kid: receipt.kid,
		fields,
		checked_on: mode,
		...out,
	};
}

// ------------------------------------------------------------------ Call Paid API (x402, paid)
export interface CallInput extends BrokerInput {
	maxSellerPriceUsd?: number;
	verify?: boolean;
}
/**
 * One paid call: free quote → price checks → sign exactly the quoted amount → one paid POST.
 * Never retries a paid request. `privateKey` is used only for signing and never returned or logged.
 */
export async function callPaidApi(http: Http, base: string | undefined, input: CallInput, privateKey: string) {
	const cap = Math.min(Number(input.maxSellerPriceUsd ?? MAX_SELLER_PRICE_USD), MAX_SELLER_PRICE_USD);
	if (!(cap > 0)) throw new RoomsError('Max seller price must be above $0.');
	const capMicros = Math.round(cap * 1e6);
	const q = await quotePaidApi(http, base, input);
	const sellerMicros = usdToMicros(q.seller_price);
	if (sellerMicros === null) throw new RoomsError('The quote did not state the seller price, so the node will not pay.', 402, q);
	if (sellerMicros > capMicros)
		throw new RoomsError(`The seller wants ${q.seller_price}, above your limit of $${cap}. Nothing was paid.`, 402);
	// All-in ceiling: seller price + Rooms margin (20%, at least $0.001).
	const ceiling = sellerMicros + Math.max(Math.ceil(sellerMicros * 0.2), 1000);
	if (q.amount_micros > ceiling)
		throw new RoomsError(`The all-in price ${q.price} is above seller price + margin. Nothing was paid.`, 402);
	if (q.broker_funded === false)
		throw new RoomsError('The Rooms broker cannot pay sellers right now (not funded). Nothing was paid.', 503);
	const req = selectBaseUsdc(q.paymentRequired.accepts)!;
	const pay = buildPaymentHeader(q.paymentRequired, req, privateKey);
	const r = await http({
		method: 'POST',
		url: q.call.url,
		body: q.call.json,
		headers: { [pay.name]: pay.value },
		timeout: 60_000,
	});
	const b = obj(r.body);
	if (r.status === 402)
		throw new RoomsError(
			`Payment was not accepted${typeof b.error === 'string' ? ` (${b.error})` : ''}. Nothing was charged.`,
			402,
			{ error: b.error, message: b.message },
		);
	if (r.status === 502 || r.status === 503 || r.status === 429)
		throw new RoomsError(
			`${typeof b.message === 'string' ? b.message : `HTTP ${r.status}`} You were not charged (Rooms settles only after a successful answer).`,
			r.status,
			r.body,
		);
	if (r.status < 200 || r.status >= 300) throw apiError('Paid call', r);
	const settle = header(r.headers, 'payment-response') ?? header(r.headers, 'x-payment-response');
	let payment: Record<string, unknown> | undefined;
	if (settle) {
		try {
			payment = decodeB64Json<Record<string, unknown>>(settle);
		} catch {
			payment = { raw: settle };
		}
	}
	const result: Record<string, unknown> = {
		...b,
		paid_from: pay.from,
		quoted: { price: q.price, seller_price: q.seller_price, rooms_fee: q.rooms_fee },
		payment,
	};
	if (input.verify !== false && b.receipt) {
		const r = extractReceipt(b.receipt);
		const v = r ? verifyLocally(r, await fetchReceiptKey(http, base)) : null;
		result.receipt_check = v
			? { valid: v.valid, kind: v.kind, message: v.message }
			: { valid: false, message: 'The answer had no readable receipt.' };
	}
	return result;
}
