# RetryCredit Recovery Campaign API

The active API operates one pre-funded Recovery Campaign over a closed set of paid Ethereum-mainnet SeaDrop failure-to-completion pairs. It re-reads both source transactions and receipts, authenticates the deployed Creditcoin bindings, asks the source wallet for a five-minute offchain consent, builds one pair-local Attestcoin batch, simulates the immutable campaign, and relays the fixed release.

The wallet does not submit a transaction, switch networks, deposit an asset, or choose a destination. The contract derives the beneficiary from the proven Ethereum sender. Earlier Sepolia/Uniswap V3 endpoints remain available for rollback and archived evidence.

## Run locally

Install dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env
```

Populate only local testnet values, then start the API with Node's environment-file support:

```bash
node --env-file=.env src/server.mjs
```

In another terminal, start the Vite application:

```bash
npm run app:dev
```

`npm run worker` is also available when the variables are already exported by the shell or deployment platform. Never commit `.env` or a private key.

## Environment

| Variable | Purpose |
| --- | --- |
| `HOST` | Bind address. Use `127.0.0.1` locally and the platform-provided public bind address in hosting. |
| `PORT` | HTTP port. |
| `ALLOWED_ORIGIN` | Single browser origin returned by CORS, such as `http://localhost:3000`. |
| `PUBLIC_ORIGIN` | Origin bound into wallet challenge text and signature verification. |
| `RETRYCREDIT_PUBLIC_ENABLED` | Set to `true` only when the bounded public service is funded and configured. |
| `RETRYCREDIT_DEMO_PRIVATE_KEY` | Secret testnet service key. Never expose it to the frontend, logs, docs, or repository. |
| `RETRYCREDIT_RECOVERY_ENABLED` | Optional explicit recovery kill switch. Set to `false` to disable even when addresses are configured. |
| `RETRYCREDIT_RECOVERY_POOL_ADDRESS` | Active `RetryCreditRecoveryCampaign` address. |
| `RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER` | Positive active campaign number. |
| `RETRYCREDIT_POOL_ADDRESS` | Active Creditcoin RetryCredit pool. |
| `RETRYCREDIT_VERIFIER_ADDRESS` | Active Creditcoin Attestcoin verifier. |
| `SEPOLIA_RPC_URL` | Ethereum Sepolia execution RPC. |
| `CREDITCOIN_RPC` | Creditcoin Testnet RPC. |
| `ATTESTCOIN_PROOF_BUILDER` | Creditcoin Testnet Attestcoin proof-builder URL. |

`ETHEREUM_RPC_URLS` is used by the Recovery Campaign to re-read mainnet source data and also supports archived RuleDrop compatibility endpoints. `RULEDROP_POOL_ADDRESS` and `RULEDROP_POOL_VERSION` are legacy-only. The frontend build uses `VITE_RETRYCREDIT_API_ORIGIN` to select the public API origin.

## HTTP behavior

- JSON bodies are limited to 16 KB.
- Errors use `{ "error": { "code", "message", "requestId" } }`.
- Every response includes `x-request-id` for operational correlation.
- Browser CORS emits the one configured `ALLOWED_ORIGIN`; CORS is not authentication and does not block non-browser clients.
- Recovery release operations are serialized in-process and replay-safe against campaign-scoped onchain state. A concurrent or repeated request returns the existing current-campaign release instead of sending a second credit.

## Routes

### `GET /health`

Returns process identity, Creditcoin network `102031`, legacy-service configuration, and the Recovery Campaign lifecycle state (`disabled`, `waking`, `ready`, or `error`). This is process health, not a live reserve measurement.

### `GET /api/recovery/config`

Returns a stable disabled/waking shape until recovery is ready, then the authenticated source and settlement identities, pool/verifier/predicate addresses, campaign number, immutable terms, live capacity, featured public case, and discovery size. The service authenticates contract bytecode and all native/source bindings before entering `ready`.

### `POST /api/recovery/eligibility`

Request:

```json
{ "wallet": "0x..." }
```

Returns `eligible`, a stable status (`eligible`, `claimed`, `not-found`, `closed`, `full`, or `replayed`), the exact source pair when known, fixed credit amount, and any current-campaign release. Discovery is a closed three-address index; live Ethereum transactions, receipts, rule checks, and current campaign state remain authority.

### `POST /api/recovery/challenge`

Request:

```json
{ "wallet": "0x..." }
```

Requires current eligibility and returns a five-minute EIP-191 message bound to the public origin, wallet, pool, campaign number, and both transaction hashes. The API stores no challenge session; it reconstructs and verifies the signed message exactly.

### `POST /api/recovery/release`

Request:

```json
{
  "wallet": "0x...",
  "message": "...",
  "issuedAt": 0,
  "expiresAt": 0,
  "signature": "0x..."
}
```

Destination fields are forbidden. After signature verification, the service requests one Attestcoin batch for the exact pair, validates block/hash/order and native transaction indexes, derives the campaign-scoped query and pair IDs, checks replay, simulates `releaseCredit`, and submits through the configured Creditcoin testnet relayer. It then verifies the exact beneficiary balance delta, event fields, campaign count/accounting, and replay markers.

HTTP `425` means the recovery service is waking or the exact Attestcoin batch is not yet ready. The frontend retries only `425` with bounded backoff. Other errors are terminal for that attempt.

## Archived V3 routes

### `GET /api/retry-credit/config`

Returns whether the public service is configured, source and settlement chain identities, fixed pilot amounts, the sponsorship cap, and the active pool address. The frontend uses a bounded retry sequence for a sleeping service.

### `POST /api/retry-credit/challenge`

Request:

```json
{ "beneficiary": "0x..." }
```

Returns `beneficiary`, `timeBucket`, human-readable `message`, and `expiresAt`. The message binds the configured public origin, beneficiary, five-minute time bucket, and bounded testnet scope. It is a time-bucketed ownership challenge, not an onchain transaction or token approval.

### `POST /api/retry-credit/prepare`

Request:

```json
{
  "beneficiary": "0x...",
  "timeBucket": 0,
  "signature": "0x..."
}
```

After wallet ownership is verified, the service authenticates its configured infrastructure, pre-funds the fixed Creditcoin service credit, activates it, signs both exact Universal Router routes from its testnet service role, and commits the raw source transactions on Creditcoin before either route is broadcast. Repeating preparation for the same beneficiary resumes the existing active or released lifecycle.

### `GET /api/retry-credit/:serviceCreditNumber/status`

Returns durable pool state (`draft`, `active`, `released`, or `refunded`), the beneficiary and source window, committed/source transaction evidence when available, and exact release evidence once emitted.

### `POST /api/retry-credit/:serviceCreditNumber/execute`

Broadcasts the already committed stale and refreshed Sepolia routes. Execution enforces the bounded source window, expected first-route failure, ordering, maximum block gap, and successful retry. Repeating the request returns the existing source hashes and any release already won by a concurrent request.

The service sends both source transactions from its own funded testnet role; the beneficiary receives the exact test-USDC output.

### `POST /api/retry-credit/:serviceCreditNumber/release`

Request:

```json
{
  "failedTransactionHash": "0x...",
  "successfulTransactionHash": "0x..."
}
```

The hashes are checked against the committed source transactions. When omitted, the service uses the committed hashes. It builds one Attestcoin batch for the ordered receipts, performs the exact pool `staticCall`, and only then submits through the testnet relayer role.

HTTP `425` means the source window or transactions are not ready, or Attestcoin has not finalized both receipts. Retry this route with bounded backoff; do not treat unrelated `4xx` responses as retryable. If another request wins the release race, the API returns the existing release. Replay never emits a second credit.

## Trust boundary

API validation, source RPC reads, proof construction, native index calculation, and simulations fail fast and improve operator feedback; they are not payout authority. The active campaign stores exact funded terms. The native Attestcoin verifier proves the two ordered Ethereum receipts, the predicate enforces canonical paid SeaDrop failure-to-completion semantics, and the campaign derives the destination and consumes current-campaign wallet/query/pair replay before releasing funds.

The service process holds a secret Creditcoin testnet relayer key. It can pay gas and relay any valid proof, but cannot redirect a credit, change campaign terms, create source evidence, withdraw active capacity, or bypass replay. Never expose the key.
