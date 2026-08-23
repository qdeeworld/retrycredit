# RetryCredit proof and execution API

The API operates the bounded public RetryCredit V3 testnet journey. It authenticates the beneficiary, creates and funds an exact service credit, commits two raw signed source routes before broadcast, executes the bounded Sepolia pair, and requests one Creditcoin release after Attestcoin finality.

The visitor's wallet signs only a short-lived ownership message. It does not submit a transaction, deposit an asset, or approve a token.

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
| `RETRYCREDIT_POOL_ADDRESS` | Active Creditcoin RetryCredit pool. |
| `RETRYCREDIT_VERIFIER_ADDRESS` | Active Creditcoin Attestcoin verifier. |
| `SEPOLIA_RPC_URL` | Ethereum Sepolia execution RPC. |
| `CREDITCOIN_RPC` | Creditcoin Testnet RPC. |
| `ATTESTCOIN_PROOF_BUILDER` | Creditcoin Testnet Attestcoin proof-builder URL. |

`RULEDROP_POOL_ADDRESS`, `RULEDROP_POOL_VERSION`, and `ETHEREUM_RPC_URLS` support archived RuleDrop compatibility endpoints that remain in the process; they are not requirements of the V3 RetryCredit journey. The frontend build uses `VITE_RETRYCREDIT_API_ORIGIN` to select the public API origin.

## HTTP behavior

- JSON bodies are limited to 16 KB.
- Errors use `{ "error": { "code", "message", "requestId" } }`.
- Every response includes `x-request-id` for operational correlation.
- Browser CORS emits the one configured `ALLOWED_ORIGIN`; CORS is not authentication and does not block non-browser clients.
- Creation, execution, and release operations are replay-safe against their durable onchain state. A retry returns or reconstructs the existing lifecycle instead of creating a second release.

## Routes

### `GET /health`

Returns process identity, Creditcoin network `102031`, and whether the public demo service was configured at process start. This is a process-health check, not a live reserve or allocation measurement.

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

API validation, RPC checks, proof construction, and simulations fail fast and improve operator feedback; they are not payout authority. The Creditcoin pool stores the funded terms and committed source hashes. The native Attestcoin verifier proves the two ordered Sepolia receipts, the predicate enforces the exact signed-route and Uniswap settlement semantics, and the pool consumes query, pair, action, and service-credit replay identifiers before releasing funds.

The service process holds a secret testnet root key and derives distinct sponsor/source, route-signer, and relayer role addresses. Those role boundaries are explicit, but they are not independent secret stores. Never expose the root key.
