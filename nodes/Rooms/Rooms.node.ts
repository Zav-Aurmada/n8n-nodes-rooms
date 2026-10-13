import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	callPaidApi,
	DEFAULT_BASE_URL,
	findAgents,
	MAX_SELLER_PRICE_USD,
	messageAgent,
	quotePaidApi,
	RoomsError,
	verifyReceipt,
	type Http,
	type VerifyMode,
} from './actions';

const CATEGORIES = [
	'agent-infrastructure',
	'ai-models',
	'crypto-web3',
	'design-media',
	'developer-tools',
	'finance-markets',
	'games-fun',
	'legal-compliance',
	'other',
	'payments-commerce',
	'productivity',
	'real-world',
	'research-data',
	'trust-safety',
	'writing',
];
const titleCase = (s: string) =>
	s
		.split('-')
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');

function parseJsonParam(ctx: IExecuteFunctions, name: string, i: number): IDataObject | undefined {
	const v = ctx.getNodeParameter(name, i, '') as unknown;
	if (v === '' || v === undefined || v === null) return undefined;
	if (typeof v === 'object') return v as IDataObject;
	try {
		return JSON.parse(String(v)) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), `"${name}" must be valid JSON`, { itemIndex: i });
	}
}

const brokerFields = (operation: string[]): INodeTypeDescription['properties'] => [
	{
		displayName: 'Listing Slug',
		name: 'slug',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'listing-slug',
		description:
			'Slug of an x402 paid API in the Rooms directory (Find Agent with protocol x402, or https://rooms.aurmada.com/x402/v1/broker)',
		displayOptions: { show: { resource: ['paidApi'], operation } },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '',
		placeholder: '/v1/search',
		description: "One of the listing's paid paths. Leave empty for its main paid endpoint.",
		displayOptions: { show: { resource: ['paidApi'], operation } },
	},
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		default: 'default',
		options: [
			{ name: 'Default for the Path', value: 'default' },
			{ name: 'GET', value: 'GET' },
			{ name: 'POST', value: 'POST' },
		],
		displayOptions: { show: { resource: ['paidApi'], operation } },
	},
	{
		displayName: 'Query Parameters (JSON)',
		name: 'query',
		type: 'json',
		default: '{}',
		description: 'Query parameters passed to the seller, e.g. {"q": "n8n"}',
		displayOptions: { show: { resource: ['paidApi'], operation } },
	},
	{
		displayName: 'Body (JSON)',
		name: 'body',
		type: 'json',
		default: '{}',
		description: 'JSON body passed to the seller (POST paths)',
		displayOptions: { show: { resource: ['paidApi'], operation } },
	},
];

export class Rooms implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Rooms by Aurmada',
		name: 'rooms',
		icon: { light: 'file:rooms.svg', dark: 'file:rooms.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Find, message, pay and trust AI agents through one endpoint (Rooms by Aurmada)',
		defaults: { name: 'Rooms' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{ name: 'roomsApi', required: false },
			{
				name: 'roomsX402WalletApi',
				required: true,
				displayOptions: { show: { resource: ['paidApi'], operation: ['call'] } },
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'agent',
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Paid API', value: 'paidApi' },
					{ name: 'Receipt', value: 'receipt' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'find',
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{
						name: 'Find',
						value: 'find',
						action: 'Find agents in the directory',
						description: 'Search MCP servers, A2A agents and x402 paid APIs in the Rooms directory',
					},
					{
						name: 'Message',
						value: 'message',
						action: 'Message an agent',
						description:
							'Send a message to any listed agent through the Rooms switchboard (free to route)',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'quote',
				displayOptions: { show: { resource: ['paidApi'] } },
				options: [
					{
						name: 'Quote',
						value: 'quote',
						action: 'Get a live price for a paid API call',
						description: 'Free. Asks the Rooms broker for the live all-in price without paying.',
					},
					{
						name: 'Call',
						value: 'call',
						action: 'Call a paid API through rooms',
						description:
							'Pays with your x402 wallet (USDC on Base) and returns the answer plus a signed receipt',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'verify',
				displayOptions: { show: { resource: ['receipt'] } },
				options: [
					{
						name: 'Verify',
						value: 'verify',
						action: 'Verify a signed receipt',
						description: 'Check that a Rooms receipt was signed by Rooms and not changed',
					},
				],
			},

			// ---------------------------------------------------------- agent: find
			{
				displayName: 'Search Query',
				name: 'query',
				type: 'string',
				default: '',
				placeholder: 'web search',
				description: 'What the agent should do. Leave empty to browse.',
				displayOptions: { show: { resource: ['agent'], operation: ['find'] } },
			},
			{
				displayName: 'Protocol',
				name: 'protocol',
				type: 'options',
				default: 'any',
				options: [
					{ name: 'A2A Agent', value: 'a2a' },
					{ name: 'Any', value: 'any' },
					{ name: 'MCP Server', value: 'mcp' },
					{ name: 'X402 Paid API', value: 'x402' },
				],
				displayOptions: { show: { resource: ['agent'], operation: ['find'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['agent'], operation: ['find'] } },
			},
			{
				displayName: 'Split Into Items',
				name: 'splitIntoItems',
				type: 'boolean',
				default: true,
				description: 'Whether to output one item per listing instead of one item with the whole page',
				displayOptions: { show: { resource: ['agent'], operation: ['find'] } },
			},
			{
				displayName: 'Options',
				name: 'findOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['agent'], operation: ['find'] } },
				options: [
					{
						displayName: 'Category',
						name: 'category',
						type: 'options',
						default: 'research-data',
						options: CATEGORIES.map((c) => ({ name: titleCase(c), value: c })),
					},
					{
						displayName: 'Page',
						name: 'page',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1,
					},
					{
						displayName: 'Verified Only',
						name: 'verified',
						type: 'boolean',
						default: false,
						description: 'Whether to return only Verified listings',
					},
				],
			},

			// ---------------------------------------------------------- agent: message
			{
				displayName: 'Agent Slug',
				name: 'to',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'translator',
				description: 'Slug of the agent in the Rooms directory (the "slug" field from Find)',
				displayOptions: { show: { resource: ['agent'], operation: ['message'] } },
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				description:
					'The message. Requests and answers through Rooms agents are public, so never send secrets.',
				displayOptions: { show: { resource: ['agent'], operation: ['message'] } },
			},
			{
				displayName: 'Options',
				name: 'messageOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['agent'], operation: ['message'] } },
				options: [
					{
						displayName: 'MCP Tool Name',
						name: 'tool',
						type: 'string',
						default: '',
						description:
							'For MCP servers: the tool to call. Leave empty and Rooms picks the tool that best fits the text.',
					},
					{
						displayName: 'MCP Tool Arguments (JSON)',
						name: 'arguments',
						type: 'json',
						default: '{}',
					},
				],
			},

			// ---------------------------------------------------------- paid API: quote / call
			...brokerFields(['quote', 'call']),
			{
				displayName: 'Max Seller Price (USD)',
				name: 'maxSellerPriceUsd',
				type: 'number',
				typeOptions: { minValue: 0.000001, maxValue: MAX_SELLER_PRICE_USD, numberPrecision: 6 },
				default: MAX_SELLER_PRICE_USD,
				description:
					'The node refuses to pay if the live seller price is above this (hard limit $0.05). You pay this plus the Rooms margin (20%, at least $0.001).',
				displayOptions: { show: { resource: ['paidApi'], operation: ['call'] } },
			},
			{
				displayName: 'Verify Receipt',
				name: 'verifyReceipt',
				type: 'boolean',
				default: true,
				description: 'Whether to check the Ed25519 signature of the returned receipt against the Rooms key',
				displayOptions: { show: { resource: ['paidApi'], operation: ['call'] } },
			},

			// ---------------------------------------------------------- receipt: verify
			{
				displayName: 'Receipt',
				name: 'receipt',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '={{ JSON.stringify($json.receipt) }}',
				description:
					'Receipt JSON (with payload and signature), the whole paid-call answer, or a job receipt ID (oj_…)',
				displayOptions: { show: { resource: ['receipt'], operation: ['verify'] } },
			},
			{
				displayName: 'Check With',
				name: 'checkWith',
				type: 'options',
				default: 'both',
				options: [
					{ name: 'Both', value: 'both', description: 'Local signature check and Rooms server check' },
					{
						name: 'Local Signature Check',
						value: 'local',
						description: 'Verify the Ed25519 signature here with the published Rooms key',
					},
					{ name: 'Rooms Server', value: 'server', description: 'POST /api/v1/receipts/verify' },
				],
				displayOptions: { show: { resource: ['receipt'], operation: ['verify'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		let hasApiKey = false;
		let base = DEFAULT_BASE_URL;
		try {
			const c = await this.getCredentials('roomsApi');
			hasApiKey = !!c?.apiKey;
			if (c?.baseUrl) base = String(c.baseUrl);
		} catch (error) {
			// No Rooms API credential set: every free operation works keyless at a lower rate limit.
			hasApiKey = false;
			base = DEFAULT_BASE_URL;
			void error;
		}

		const http: Http = async (req) => {
			const opts: IHttpRequestOptions = {
				method: req.method,
				url: req.url,
				qs: req.qs,
				body: req.body as IDataObject | undefined,
				headers: { accept: 'application/json', 'user-agent': 'n8n-nodes-rooms/0.1.0', ...(req.headers || {}) },
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: req.timeout ?? 30_000,
			};
			// The API key is only ever sent to the configured Rooms base URL.
			const sameHost = req.url.startsWith(base.replace(/\/+$/, '') + '/');
			const res = (
				hasApiKey && sameHost
					? await this.helpers.httpRequestWithAuthentication.call(this, 'roomsApi', opts)
					: await this.helpers.httpRequest(opts)
			) as { statusCode: number; headers: Record<string, string>; body: unknown };
			return { status: res.statusCode, headers: res.headers || {}, body: res.body };
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'agent' && operation === 'find') {
					const opt = this.getNodeParameter('findOptions', i, {}) as IDataObject;
					const res = await findAgents(http, base, {
						query: this.getNodeParameter('query', i, '') as string,
						protocol: this.getNodeParameter('protocol', i, 'any') as string,
						perPage: this.getNodeParameter('limit', i, 50) as number,
						category: (opt.category as string) || undefined,
						page: (opt.page as number) || 1,
						verified: !!opt.verified,
					});
					if (this.getNodeParameter('splitIntoItems', i, true)) {
						for (const l of res.listings || [])
							returnData.push({ json: l as IDataObject, pairedItem: { item: i } });
					} else returnData.push({ json: res as IDataObject, pairedItem: { item: i } });
				} else if (resource === 'agent' && operation === 'message') {
					const opt = this.getNodeParameter('messageOptions', i, {}) as IDataObject;
					let args: IDataObject | undefined;
					if (opt.arguments) {
						try {
							args = typeof opt.arguments === 'string' ? JSON.parse(opt.arguments) : (opt.arguments as IDataObject);
						} catch {
							throw new NodeOperationError(this.getNode(), 'MCP Tool Arguments must be valid JSON', { itemIndex: i });
						}
					}
					const res = await messageAgent(http, base, {
						to: this.getNodeParameter('to', i) as string,
						text: this.getNodeParameter('text', i) as string,
						tool: (opt.tool as string) || undefined,
						arguments: args,
					});
					returnData.push({ json: res as IDataObject, pairedItem: { item: i } });
				} else if (resource === 'paidApi') {
					const input = {
						slug: this.getNodeParameter('slug', i) as string,
						path: (this.getNodeParameter('path', i, '') as string) || undefined,
						method: this.getNodeParameter('method', i, 'default') as string,
						query: parseJsonParam(this, 'query', i),
						body: parseJsonParam(this, 'body', i),
					};
					if (operation === 'quote') {
						const q = await quotePaidApi(http, base, input);
						const { paymentRequired, ...rest } = q;
						returnData.push({
							json: { ...rest, accepts: paymentRequired.accepts } as unknown as IDataObject,
							pairedItem: { item: i },
						});
					} else {
						const wallet = await this.getCredentials('roomsX402WalletApi', i);
						const res = await callPaidApi(
							http,
							base,
							{
								...input,
								maxSellerPriceUsd: this.getNodeParameter('maxSellerPriceUsd', i, MAX_SELLER_PRICE_USD) as number,
								verify: this.getNodeParameter('verifyReceipt', i, true) as boolean,
							},
							String(wallet.privateKey || ''),
						);
						returnData.push({ json: res as IDataObject, pairedItem: { item: i } });
					}
				} else if (resource === 'receipt' && operation === 'verify') {
					const raw = this.getNodeParameter('receipt', i) as unknown;
					const res = await verifyReceipt(
						http,
						base,
						raw,
						this.getNodeParameter('checkWith', i, 'both') as VerifyMode,
					);
					returnData.push({ json: res as IDataObject, pairedItem: { item: i } });
				} else {
					throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}/${operation}`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof RoomsError && error.status !== undefined) {
					throw new NodeApiError(
						this.getNode(),
						{ message: error.message, details: error.details } as unknown as JsonObject,
						{ itemIndex: i, message: error.message, httpCode: String(error.status) },
					);
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
