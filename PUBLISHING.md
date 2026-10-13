# Publishing n8n-nodes-rooms (internal notes, not shipped in the npm package)

Status (2026-10-12): built, linted (`n8n-node lint`, strict, cloud rules: exit 0), and tested: 21/21 pass, including the free live calls against production. **Not published.** No accounts were created.

## What publishing needs
1. **npm account `roomsbyaurmada`** (team@aurmada.com). Creating it needs the owner's OK. Then either:
   - Option A (recommended): npm **Trusted Publisher** for the package → GitHub Actions, repo `Zav-Aurmada/n8n-nodes-rooms`, workflow `publish.yml`. No token is stored.
   - Option B: a granular npm automation token, saved as the `NPM_TOKEN` repo secret.
   - npm can't set up a Trusted Publisher before the package exists. If that's still true, the first publish needs Option B (or one manual `npm publish --provenance` from CI with a token), and later publishes can switch to Option A.
2. **GitHub repo `Zav-Aurmada/n8n-nodes-rooms`** (public). n8n has required npm provenance since May 1 2026, so the package must be published from GitHub Actions. `.github/workflows/publish.yml` (from the n8n starter) already does this: push a tag like `0.1.0` → `npm ci` → `npm run release` with `--provenance`. `package.json` `repository.url` already points at that repo. If the repo ends up somewhere else, update it, because provenance checks that the two match.
3. Release: `npm run release` (lint, build, version bump, changelog, tag, push) → CI publishes.
4. **Verification / n8n Cloud listing**: after it's on npm, submit it in the n8n Creator Portal (https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes). It already meets the rules: zero runtime `dependencies`, only `n8n-workflow` + `node:crypto` imported, no restricted globals, strict lint config unchanged, MIT, keyword `n8n-community-node-package`. Expect a review queue of weeks. Also post in #community-nodes on the n8n Discord or email nodes@n8n.io.
5. Optional: 3–5 workflow templates on n8n.io/workflows (find → message; quote → call → verify).

## Build notes
- `npm ci` in this sandbox fails on a native build of `isolated-vm` (a dev-only dependency of `@n8n/node-cli`) because `make` isn't installed. Use `npm ci --ignore-scripts` here. GitHub's ubuntu runners have the build tools, so CI should work unchanged. Check this on the first CI run.
- `tsconfig` target was raised from es2019 to **es2020**, because the x402 signer uses BigInt. n8n requires Node 20+, so this is safe.
- `node_modules` (about 740 MB) was deleted after the build, because `rooms-app/.dockerignore` only excludes the top-level `node_modules`. A nested one would be sent in every Fly deploy's build context. Reinstall with `npm ci --ignore-scripts`. **Recommended:** add `integrations` to `rooms-app/.dockerignore`.

## Not tested end to end
- **A real paid call.** No paid call was made, as instructed. The signer is checked byte for byte against viem (EIP-712 TransferWithAuthorization, RFC 6979), the recovered signer address is checked, and the header shape mirrors @x402/core v2 (`PAYMENT-SIGNATURE` = base64 `{x402Version, payload:{authorization, signature}, extensions, resource, accepted}`; v1 `X-PAYMENT`). The flow runs against a mocked broker. The first real call (≤ $0.01 from a test wallet) should be made once the owner OKs the spend.
- **The Rooms API key credential test** (`GET /api/v1/me/capabilities`). Testing it needs a registered agent key, and none was created.

## Future (not built)
- **Trigger "Get Paid by Agents"**: no Rooms API exists for it yet. Rooms has no seller-side "verify/settle a payment for my endpoint" service, no webhook on paid events, and no way to list an n8n webhook as a paid endpoint that Rooms collects for. Options: (a) a Rooms "paid webhook" product, where Rooms answers the 402, settles, then POSTs the job to the workflow with a signed receipt, and auto-lists it; or (b) a polling trigger on the existing open-jobs API (`GET /api/v1/jobs/open`, claim/submit; paid jobs pay out USDC). (b) works today but needs an agent api_key.
- Message: paying the house fallback after free calls run out (`PAYMENT-SIGNATURE` + `skip_outside`). Today the node returns the `payment_required` result as is.
