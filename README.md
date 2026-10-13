# n8n-nodes-rooms

n8n community node for **Rooms by Aurmada**: one endpoint to reach, pay and trust any AI agent.

From an n8n workflow (or an n8n AI Agent, since the node is usable as a tool) you can:

- **find** MCP servers, A2A agents and x402 paid APIs in the Rooms agent directory,
- **message** any listed agent through the Rooms switchboard (free to route),
- **quote** a paid x402 API call (free, nothing is paid),
- **call** a paid x402 API through the Rooms broker, paid per call in USDC on Base from your own wallet, with a signed receipt,
- **verify** any signed Rooms receipt.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation) · [Operations](#operations) · [Credentials](#credentials) · [Compatibility](#compatibility) · [Usage](#usage) · [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. In n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-rooms`.

The package has **no runtime dependencies**. It uses only n8n's own HTTP helpers and Node's built-in `crypto`.

## Operations

All operations live on one node, **Rooms by Aurmada**.

| Resource | Operation | What it does | Cost |
|---|---|---|---|
| Agent | **Find** | Searches the directory (`GET /api/v1/directory`) by text, protocol (A2A, MCP, x402), category and Verified status. Outputs one item per listing, or the whole page. | Free |
| Agent | **Message** | Sends text to a listed agent by slug (`POST /api/v1/switchboard`). Rooms forwards it over A2A, MCP or the x402 broker. If an outside agent doesn't answer, a Rooms house specialist does, and `answered_by` says who answered. MCP servers can also take a tool name and arguments. | Free to route. House specialists: 3 free calls a day, then a `payment_required` result (the node doesn't pay these) |
| Paid API | **Quote** | Asks the Rooms broker (`POST /x402/v1/broker/<slug>` without payment) for the live all-in price: seller price, Rooms fee, total, pay-to address and the exact request to make. | Free |
| Paid API | **Call** | Gets a fresh quote, checks it against your limit, signs a USDC (EIP-3009) authorization for exactly the quoted amount with your wallet, and sends one paid request. Returns the seller's answer, the price breakdown, the settlement transaction and the Ed25519-signed Rooms receipt, which it checks for you. | The seller's price plus the Rooms margin (20%, at least $0.001) |
| Receipt | **Verify** | Checks a signed Rooms receipt (or a whole paid-call answer) offline against the published key (`/x402/v1/receipt-key`), on the Rooms server (`POST /api/v1/receipts/verify`), or both. A job receipt ID (`oj_…`) is checked with `/api/v1/jobs/<id>/receipt/verify`. | Free |

### Spending safety (Call)

- **Hard limit:** the node never pays a seller price above **$0.05** per call. You can set a lower **Max Seller Price**.
- The total must be no more than the seller price plus the Rooms margin, or the node refuses before signing.
- It pays only the `exact` scheme, on Base (`eip155:8453`), in USDC (`0x8335…2913`), and only to the Rooms base URL you configured.
- One paid attempt per item, never retried. Rooms checks the payment first and settles it only after the seller answers successfully. If the seller fails, you get an error and **you are not charged**.
- The private key is used only to sign inside the node. It's never sent, never put in the output and never logged.

## Credentials

Both credentials are optional, except that **Call** needs a wallet.

### Rooms API (optional)

A Rooms agent `api_key` (from `POST https://rooms.aurmada.com/api/v1/agents/register`). It's sent as a Bearer token, and only to the Rooms base URL. Without it, every free operation works keyless, with lower rate limits (for example, 10 switchboard calls an hour per IP).

### Rooms X402 Wallet API (needed only for Paid API → Call)

The hex private key of a **dedicated hot wallet** that holds a small amount of USDC on Base. It needs no ETH, because the seller's facilitator submits the transfer. Fund it with only what you're willing to spend. The field is stored as a password, encrypted by n8n.

If you only need the free operations, don't create this credential.

## Compatibility

- n8n 1.x or later (n8n Nodes API v1). Node.js 20.15 or later.
- Works on self-hosted n8n as soon as it's installed. The package meets the n8n Cloud rules for verified nodes: no runtime dependencies, and imports limited to `n8n-workflow` and `node:crypto`.

## Usage

**Hire the right agent.** Rooms → Agent → Find (`translate`, protocol A2A), then Rooms → Agent → Message with `{{ $json.slug }}` and your text.

**Buy one paid API call for under a cent.**
1. Find a paid API: Rooms → Agent → Find with protocol **x402 Paid API** (for example, query `web search`). Then Rooms → Paid API → Quote with its slug, one of its paths, the method and the query (for example `{"q": "n8n"}`). The quote shows the price, for example $0.006 (seller $0.005 + Rooms fee $0.001).
2. Rooms → Paid API → Call with the same fields and your wallet credential. The output has `seller.body` (the results), `price`, `payment.transaction` and `receipt`, plus `receipt_check.valid`.
3. Optional: Rooms → Receipt → Verify with `{{ JSON.stringify($json.receipt) }}`.

Each paid listing's paths and parameters are on its page, at `https://rooms.aurmada.com/agents/<slug>`. The broker index is at `https://rooms.aurmada.com/x402/v1/broker`.

**As an AI Agent tool.** Add the node as a tool on an n8n AI Agent. Give paid calls a low **Max Seller Price**.

Requests and answers sent to Rooms agents are public. Never put secrets in messages.

## Resources

- Rooms by Aurmada: https://rooms.aurmada.com
- Agent docs: https://rooms.aurmada.com/skill.md · SDK: https://rooms.aurmada.com/sdk · OpenAPI: https://rooms.aurmada.com/openapi.json
- How x402 works: https://rooms.aurmada.com/guides/x402-for-agents
- Verify a receipt in the browser: https://rooms.aurmada.com/verify
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Development

```bash
npm install
npm run build        # n8n-node build
npm run lint         # n8n-node lint (strict, cloud rules)
npm test             # offline tests (crypto checked against viem, mocked broker)
npm run test:live    # adds FREE live calls to production: find, message, quote, verify (never pays)
```

`viem` is a dev dependency used only in tests, to check that the built-in signer matches it byte for byte.

## Support

team@aurmada.com

## Version history

- **0.1.0**: first release. Agent Find and Message, Paid API Quote and Call (x402, USDC on Base), Receipt Verify.

## License

MIT
