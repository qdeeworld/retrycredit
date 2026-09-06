# RetryCredit Recovery Campaign API

The active API operates the live V1 pre-funded Recovery Campaign for paid Ethereum-mainnet SeaDrop failure-to-completion pairs. Its namespaced Open Pair Intake accepts an exact failed/successful transaction-hash pair, derives the source wallet from live Ethereum facts, authenticates the deployed Creditcoin bindings, asks that wallet for a five-minute offchain consent, builds one pair-local Attestcoin batch, simulates the immutable campaign, and relays the fixed release. A finalized, funded V2 continuation is deployed but remains predecessor-locked, so production intentionally reports `contractVersion: "v1"` until the reviewed cutover. The earlier three-address discovery index remains a public example and staged-compatibility path; it is not eligibility authority for the intake routes.

The wallet does not submit a transaction, switch networks, deposit an asset, or choose a destination. The contract derives the beneficiary from the proven Ethereum sender. Earlier Sepolia/Uniswap V3 endpoints remain available as an API-level predecessor and for archived evidence. The current Recovery Campaign interface does not fall back to those routes automatically, so their availability alone is not a product rollback.

## Run locally

### V2 activation runtime (not yet deployed)

The reviewed deployment can be observed without retaining a signing or broadcast
controller. Explicit V2 activation requires `RETRYCREDIT_RECOVERY_ENABLED=true`,
`RETRYCREDIT_RECOVERY_CONTRACT_VERSION=v2`, the canonical V2 pool
`0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8`, campaign `1`, and
`RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE=observation-only`. A valid full
`RENDER_GIT_COMMIT` identifies the running release. V2 never inherits V1 pool
defaults. The existing Google/Git deployment account settings are unrelated to
these application settings.

This mode never constructs the deployment controller or receives its private key,
arm digest, or broadcast window. It observes the already-deployed transaction and
runtime through the two canonical CC3 endpoints, initially on startup and then
15 seconds after each completed observation, with a 25-second observation budget.
This leaves five seconds of scheduling margin before the unchanged 45-second
freshness limit; event-loop stalls can still expire readiness and fail closed.
The shorter delay increases background read frequency but never overlaps samples.
HTTP health checks read the latest
sample without additional RPC work. Failed refreshes, samples at least 45 seconds
old, and stopped observers fail closed. This is per-process provider cadence,
not a distributed rate-limit guarantee across replicas or restarts.

`/health/recovery-v2` reports `publicProfile: "v2"` and returns 200 only for a
current two-provider observation. All V2 recovery API routes refuse with
`503 RECOVERY_V2_NOT_VERIFIED` while verification is unavailable. Observation
is rechecked after queueing, proof construction, simulation, and balance reads,
immediately before the shared release broadcast. Failed verification at that
boundary sends nothing and does not enter ambiguous-broadcast reconciliation.
Setting `RETRYCREDIT_RECOVERY_ENABLED=false` skips V2 observer construction,
preserving health and unrelated read routes even if observation mode remains set.
Observation
confirms deployment identity, not campaign eligibility or unlock: the existing
campaign service and contract still enforce predecessor closure, funding, consent,
proofs, and replay. The predecessor deadline does not change API configuration.
Production remains V1 until a separately authorized, verified cutover.

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
| `RETRYCREDIT_PUBLIC_ENABLED` | Archived V3 service switch; it does not enable the active Recovery Campaign. |
| `RETRYCREDIT_LEGACY_WRITES_ENABLED` | Explicit opt-in for archived V3 sponsor/release writes. It defaults to disabled and remains disabled in production so archived routes cannot share the campaign sponsor's nonce domain. |
| `RETRYCREDIT_DEMO_PRIVATE_KEY` | Root testnet secret for domain-separated sponsor, route-signer, and relayer roles. Never expose it to the frontend, logs, docs, or repository. |
| `RETRYCREDIT_RECOVERY_ENABLED` | Optional explicit recovery kill switch. Set to `false` to disable even when addresses are configured. |
| `RETRYCREDIT_RECOVERY_CONTRACT_VERSION` | Exact active recovery ABI and lineage model: `v1` (default) or `v2`. Change to `v2` only with the finalized V2 pool and campaign in the same reviewed cutover. |
| `RETRYCREDIT_RECOVERY_POOL_ADDRESS` | Active `RetryCreditRecoveryCampaign` address. |
| `RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER` | Positive active campaign number. |
| `RETRYCREDIT_DEPLOYMENT_REVISION` | Exact lowercase 40-character Git commit for public rollout identity. On Cloudflare it also contributes to V2 observation snapshot invalidation; invalid or missing values are reported as `null`, while the platform's immutable Worker version ID still prevents reuse across Worker deployments. |
| `RETRYCREDIT_POOL_ADDRESS` | Archived V3 Creditcoin pool. |
| `RETRYCREDIT_VERIFIER_ADDRESS` | Archived V3 Attestcoin verifier. |
| `SEPOLIA_RPC_URL` | Archived V3 Ethereum Sepolia execution RPC. |
| `CREDITCOIN_RPC` | Shared Creditcoin Testnet RPC. |
| `CREDITCOIN_LOG_RPC` | Independent Creditcoin audit RPC used for release receipts and the two-provider V2 deployment observation. It must not resolve to the same canonical URL as `CREDITCOIN_RPC`. |
| `ATTESTCOIN_PROOF_BUILDER` | Shared Creditcoin Testnet Attestcoin proof-builder URL. |

The guarded one-time V2 deployment supervisor also recognizes `RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE`, `RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_REVISION`, `RETRYCREDIT_RECOVERY_V2_PREPARE_ARM_DIGEST`, `RETRYCREDIT_RECOVERY_V2_EXPECTED_TRANSACTION_HASH`, `RETRYCREDIT_RECOVERY_V2_BROADCAST_NOT_BEFORE`, `RETRYCREDIT_RECOVERY_V2_BROADCAST_NOT_AFTER`, and `RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_ARM_DIGEST`. These values bind a reviewed release, exact signed transaction fingerprint, and short broadcast window; they are not normal product configuration. Production reached the terminal `FINALIZED_PLUS_TWO_VERIFIED` state without exposing the signing key or raw transaction.

`ETHEREUM_RPC_URLS` is used by the Recovery Campaign to re-read mainnet source data and also supports archived RuleDrop compatibility endpoints. `RULEDROP_POOL_ADDRESS` and `RULEDROP_POOL_VERSION` are legacy-only. The frontend build uses `VITE_RETRYCREDIT_API_ORIGIN` to select the public API origin.

The reviewed release also carries the active pool and campaign as source defaults. They are selected only when recovery is explicitly enabled with no address override, or when the existing public V3 service runs at the exact production origin with no recovery override. This keeps the isolated production service reproducible without weakening partial-configuration checks. Set `RETRYCREDIT_RECOVERY_ENABLED=false` to disable recovery immediately without removing the archived V3 read, challenge, and status routes. Archived prepare, execute, and release remain HTTP `410` unless their separate write switch is explicitly enabled. The V2 interface will report that recovery is unavailable; it does not rebind itself to the V3 journey.

## Hosting and rollback

The production API authority is the isolated Render service `retrycredit-api` (`srv-da5n322jobas73f8tp70`) at <https://retrycredit-api.onrender.com>. The similarly named Blueprint-created service `retrycredit-api-6fs3` (`srv-da5nh93m8hqs73da7170`) is a separate, non-authoritative deployment. The checked-in `render.yaml` currently describes that duplicate rather than the stable production service and must not be treated as proof of a production deploy. Its Blueprint relationship must be reconciled in authenticated Render controls before the manifest can become deployment authority.

Use two levels of rollback:

1. For immediate Recovery Campaign containment, set `RETRYCREDIT_RECOVERY_ENABLED=false` on the stable API service and redeploy its current reviewed build. This preserves only the archived V3 read/challenge/status surface by default; its mutation routes remain HTTP `410`, and the V2 interface becomes truthfully unavailable.
2. To restore a previous public product journey, roll the stable Render API back to the intended reviewed deploy and roll Cloudflare Pages back to the matching reviewed frontend deployment. The API and frontend must be treated as one release pair because the current interface calls only the V2 recovery routes.

For the config-bound consent release, deploy and verify the stable Render API first, including `enabled: true`, `waking: false`, the canonical `publicOrigin`, and `consent.freshReadAdmission: "anonymous-v1"`; only then publish the matching Cloudflare-compatible frontend. The older frontend safely ignores the added config field, while the new frontend intentionally fails closed against an older API that does not provide it. After the compatible frontend is verified, a Cloudflare cutover may advertise `pair-signature-v1` and require the signed fresh-read credential. Roll back in the reverse order: restore the frontend/API pair before restoring an API that omits the discriminator.

After either operation, verify the exact deployed source, `GET /health`, both config routes, production-origin CORS, the public app, and the intended disabled or ready Recovery Campaign state. A provider rollback, a healthy predecessor API, or a source revert is not complete until the public interface and API describe the same release.

## HTTP behavior

- JSON bodies are limited to 16 KB.
- Errors use `{ "error": { "code", "message", "requestId" } }`.
- Every response includes `x-request-id` for operational correlation.
- Browser CORS emits the one configured `ALLOWED_ORIGIN`; the Cloudflare response allows `Authorization` for the signed fresh-read preflight. CORS is not authentication and does not block non-browser clients.
- Recovery release operations are serialized in-process and replay-safe against campaign-scoped onchain state.
- The whole public intake pipeline is bounded to four active requests and sixteen queued requests; source resolution has its own matching bound. Campaign reads share a short generation-safe flight/cache, identical pair lookups share one flight, successful pair validation is held in a bounded 256-entry ten-minute cache, invalid-pair results are held for thirty seconds, one lookup receives at most three configured Ethereum providers, and a lookup times out after twenty seconds. Saturation returns HTTP `429` / `RECOVERY_BUSY` with `Retry-After: 5`.
- On the isolated Cloudflare read plane, a successful open-pair challenge also returns a stateless `freshReadReceipt`: an HMAC-SHA-256 receipt made with a private key held in the existing pool-and-campaign Durable Object. The receipt binds the exact origin, pool, campaign, source wallet, pair, timestamps, and fresh-config action. `GET /api/recovery/config?fresh=1` accepts only `Authorization: RetryCreditFresh <base64url-json>` containing that receipt and the same exact EIP-191 wallet signature used for release. The Worker verifies the receipt before the wallet signature, then atomically burns the signed authorization and reserves the persisted five-second window before service initialization or provider work. Replay returns HTTP `409` / `RECOVERY_FRESH_READ_AUTHORIZATION_USED`; additional valid authorizations inside the window return HTTP `429` / `RECOVERY_FRESH_READ_THROTTLED` without being consumed. The reservation and replay record remain after provider failure, lost responses, or object eviction. A cold admitted refresh supplies the readiness state read instead of triggering a second campaign read. Ordinary configuration reads and other operations do not consume or extend the window. Missing/corrupt key state, storage failure, or invalid replay state fails closed with HTTP `503` before provider work. The gate removes anonymous fabricated fresh-read monopolization; it is not a comprehensive API-DoS or per-user fairness system, and challenge/discovery workloads retain their separately documented bounds.
- Cloudflare routes the anonymous V2 deployment health probe through one deterministic observation-only Durable Object, separate from the pool-and-campaign object. A semantic `200` or `503` result is held for thirty seconds, concurrent callers share one live flight, and a durable lease is committed before any provider request so eviction or a failed result write cannot create a retry storm. One refresh performs six bounded HTTP batches containing fourteen JSON-RPC operations across the two independent Creditcoin providers. An expired success is never served after a failed refresh. The persisted identity binds the schema, interval, RPC URLs, canonical observation facts, normalized Git revision, and Cloudflare's immutable Worker version ID; at least one deployment discriminator must be valid. Per-request IDs and current Worker version metadata remain outside the snapshot, while response headers remain `no-store`. This bounds the public probe to one dual-provider observation per interval; it is not caller authentication or generalized API-DoS fairness, and it does not rate-limit discovery or intake.
- At most eight hosted release operations may be active or queued. Each queued release freshly re-reads campaign and claimant state before requesting an Attestcoin proof. Replay IDs are then derived and checked after proof construction and before simulation, so a closed, full, already-claimed, or consumed release cannot reach the relay step.
- Existing release receipts are searched in `10,000`-block chunks across the latest `250,000` Creditcoin blocks. Within that supported window, a concurrent or repeated request returns the existing current-campaign release instead of sending a second credit.
- If the campaign records a wallet claim but its exact `CreditReleased` event is not discoverable inside that bounded window, the service fails closed with HTTP `503` / `RECOVERY_STATE_INCONSISTENT`. It does not reconstruct unverified evidence or send another credit.

## Routes

### `GET /health`

Returns process identity, Creditcoin network `102031`, legacy-service configuration, the Recovery Campaign lifecycle state (`disabled`, `waking`, `ready`, or `error`), and `revision`. The revision is the normalized 40-character Git commit supplied by Render, or `null` when that exact deployment identity is unavailable. This is process health and rollout identity, not a live reserve measurement.

### `GET /health/recovery-v2`

Observes the one frozen V2 creation transaction, receipt, canonical block, deployment and latest runtime bytecode, confirmations, chain identity, value, signer, nonce, and deployment events through both configured Creditcoin RPCs. It returns HTTP `200` only when both providers independently match the same committed fingerprint and the deployment has at least two confirmations; otherwise it returns the stable HTTP `503` `RECOVERY_V2_OBSERVATION_FAILED` shape. This is deployment-integrity evidence for an observation-only V2 profile, not a V2 cutover, live release authorization, independent user completion, or adoption evidence.

On Cloudflare the semantic body is subject to the bounded server-side observation cache described above. Every HTTP response still receives its own `x-request-id`, current normalized Git revision, current Worker version metadata, CORS policy, and `cache-control: no-store`. A Durable Object or platform RPC failure preserves the same canonical `503` health contract rather than degrading into a generic internal-error envelope.

### `GET /api/recovery/config`

Returns a stable disabled/waking shape until recovery is ready, then the canonical public origin, dedicated public `relayerAddress`, authenticated source and settlement identities, pool/verifier/predicate addresses, exact `contractVersion`, campaign number, immutable terms, live capacity, featured public case, and discovery size. V1 reports campaign-scoped lineage with no predecessor. V2 reports its exact predecessor boundary, sponsor-scoped lineage, and whether releases are unlocked; a fully funded but locked campaign uses `campaign.releaseState: "continuation-waiting"` and `campaign.open: false`. `capabilities.selfServePairIntake` and `capabilities.walletNativeDiscovery` are exactly `true` when those API contracts are present. `consent.scope` is `hosted-relayer` and `consent.protocolEnforced` is `false`: the wallet signature authorizes this hosted service to build and relay the exact pair, but the deployed permissionless campaign contract does not itself verify that offchain signature. `consent.freshReadAdmission` is an exact rollout discriminator: Render returns `anonymous-v1`, while the Cloudflare coordinator returns `pair-signature-v1`. Unknown or missing values fail closed in the browser; a mode change while authorization is active cancels that operation. The browser uses the origin and returned identities to reconstruct the exact five-minute consent before opening `personal_sign`. The service authenticates the exact active runtime bytecode, the exact V1 predecessor runtime for V2, and all native/source bindings before entering `ready`.

The optional exact query `?fresh=1` requests provider-backed campaign truth and cannot be satisfied from the normal short cache. Render's transition mode remains headerless. When configuration advertises `pair-signature-v1`, the browser sends the exact challenge receipt and signature in the bounded `Authorization` envelope and never falls back to an anonymous retry. It retries only the exact forced-refresh throttle, only when the response includes a valid integer `Retry-After`, and only inside its existing bounded configuration-wake budget; every retry reuses the identical header. It waits at least the advertised delay plus at most 250 milliseconds of positive jitter and abandons later attempts if the active wallet/pair operation changed. A used authorization or unresolved fresh result discards the stale qualifying verdict, sends no release request, preserves the entered pair, and requires a new pair check and signature.

### `POST /api/recovery/discover`

Request:

```json
{ "wallet": "0x..." }
```

This is advisory discovery, not eligibility or payout authority. The service searches a bounded, paginated slice of the supplied wallet's public Ethereum transaction history inside the immutable campaign source window. It locally discards calls that cannot satisfy deterministic campaign rules, caps the remaining candidates, then independently re-reads each candidate's transactions and receipts through the normal live-pair authority path. The response identifies itself with `authority: "advisory-discovery-only"`, reports rows and pages inspected, discloses truncation, and returns only live-revalidated matches. A wallet address never becomes a payout destination: the campaign still derives the beneficiary from the Attestcoin-proven source transactions.

History lookup and candidate validation use separate bounded pools so a slow explorer cannot occupy manual pair-intake capacity. HTTP `429` means discovery is busy; HTTP `503` means discovery or live source validation is temporarily unavailable. Both states leave exact manual pair intake available.

### `POST /api/recovery/intake/eligibility`

Request:

```json
{
  "pair": {
    "failedTransactionHash": "0x...",
    "successfulTransactionHash": "0x..."
  }
}
```

The body accepts only this pair object, and the pair accepts only the two distinct 32-byte hashes. No wallet or destination is accepted as authority. The service re-reads both Ethereum transactions and receipts under bounded source-work limits, validates the exact immutable campaign predicate, and derives the claimant from the live source sender. The response includes that derived `wallet`, the full validated pair, campaign amount, status, lineage status, and any exact current-campaign release. V2 distinguishes `claimed-predecessor` and `claimed-sponsor` from a current-campaign receipt. Status `continuation-waiting` keeps the analyzed pair visible but forbids authorization until the immutable predecessor boundary unlocks. Status `processing` means a valid signed release for this exact wallet/pair is already inside hosted preflight, proof, or relay work; clients must check again instead of requesting another signature.

### `POST /api/recovery/intake/challenge`

Request:

```json
{
  "pair": {
    "failedTransactionHash": "0x...",
    "successfulTransactionHash": "0x..."
  }
}
```

The service re-resolves the pair, derives its source wallet, requires current eligibility, and returns a canonical 300-second EIP-191 message bound to the public origin, pool, campaign, derived wallet, and both hashes. The browser must reconstruct that message from its live configuration and response before requesting a signature. Cloudflare additionally returns `freshReadReceipt`; Render's `anonymous-v1` response omits it. The receipt is never persisted in browser resume storage and is accepted only in the signed fresh-config header.

### `POST /api/recovery/intake/release`

Request:

```json
{
  "wallet": "0x...",
  "pair": {
    "failedTransactionHash": "0x...",
    "successfulTransactionHash": "0x..."
  },
  "issuedAt": 0,
  "expiresAt": 0,
  "signature": "0x..."
}
```

The wallet is present only so the service can reconstruct and verify the pair-bound consent before starting new Ethereum RPC or proof work. It is not payout authority: after signature verification, the service re-resolves the pair and requires the live-derived claimant to equal the signer. The request does not echo a mutable message, and destination, recipient, beneficiary, payout, or additional authoritative fields are rejected. After a fresh queued-state recheck, the existing exact proof normalization, replay checks, static simulation, relay, balance delta, event, and campaign-accounting verification apply unchanged.

The hosted consent prevents this service from relaying for an unsigned or pair-mutated request. It does not make wallet consent an onchain invariant: another party with a valid Attestcoin proof can call the current permissionless contract, consume a slot, and send the fixed credit only to the proof-derived source wallet. It still cannot substitute a destination or take the credit.

Malformed bodies and forbidden destination fields return HTTP `400`; invalid, altered, or expired consent returns HTTP `401`. HTTP `409` covers closed, full, claimed, or replayed state. Non-retryable HTTP `422` covers malformed live pair semantics or missing exact source facts (`RECOVERY_PAIR_INVALID`), a signer that differs from the wallet derived from the pair (`RECOVERY_PAIR_WALLET_MISMATCH`), and a release rejected by immutable campaign simulation (`RECOVERY_SIMULATION_REJECTED`). HTTP `425` covers an active release, Attestcoin lag, or a funded V2 continuation still waiting on its predecessor (`RECOVERY_CONTINUATION_WAITING`). HTTP `429` / `RECOVERY_BUSY` covers intake or release queue saturation. Bounded source/state failure returns HTTP `503`, while proof or relay verification may return safe `502`/`503` domain errors. Every error keeps the stable `{ code, message, requestId }` envelope.

The namespaced routes are additive for API-first rollout. The unnamespaced discovery routes below remain functional until the matching frontend release is verified; the public Open Pair Intake uses only the namespaced routes.

## Indexed compatibility routes

### `POST /api/recovery/eligibility`

Request:

```json
{ "wallet": "0x..." }
```

Returns `eligible`, a stable status (`eligible`, `claimed`, `not-found`, `closed`, or `full`), the exact source pair when known, fixed credit amount, and any current-campaign release. This staged-compatibility route still selects from the closed three-address example index; live Ethereum transactions, receipts, rule checks, and current campaign state remain authority.

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

HTTP `409` / `RECOVERY_REPLAYED` means an exact query or pair marker is already consumed in the configured campaign but no current-wallet claim resolved to an existing release. This is a release rejection, not an eligibility status. A normal repeat after a completed current-wallet release returns that existing release instead.

## Archived V3 routes

### `GET /api/retry-credit/config`

Returns source and settlement chain identities, fixed pilot amounts, the sponsorship cap, and the archived pool address. Both `enabled` and `writesEnabled` are true only when the archived service is configured and `RETRYCREDIT_LEGACY_WRITES_ENABLED=true`; configuration alone is reported separately by `/health.publicDemoConfigured`. The production default is `false`.

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

By default this route returns HTTP `410` / `LEGACY_WRITES_DISABLED`. With the explicit legacy-write switch enabled, wallet ownership is verified before the service authenticates its configured infrastructure, pre-funds the fixed Creditcoin service credit, activates it, signs both exact Universal Router routes from its testnet service role, and commits the raw source transactions on Creditcoin before either route is broadcast. Repeating preparation for the same beneficiary resumes the existing active or released lifecycle.

### `GET /api/retry-credit/:serviceCreditNumber/status`

Returns durable pool state (`draft`, `active`, `released`, or `refunded`), the beneficiary and source window, committed/source transaction evidence when available, and exact release evidence once emitted.

### `POST /api/retry-credit/:serviceCreditNumber/execute`

By default this route returns HTTP `410` / `LEGACY_WRITES_DISABLED`. With the explicit legacy-write switch enabled, it broadcasts the already committed stale and refreshed Sepolia routes. Execution enforces the bounded source window, expected first-route failure, ordering, maximum block gap, and successful retry. Repeating the request returns the existing source hashes and any release already won by a concurrent request.

When explicitly enabled, the service sends both source transactions from its own funded testnet role; the beneficiary receives the exact test-USDC output.

### `POST /api/retry-credit/:serviceCreditNumber/release`

Request:

```json
{
  "failedTransactionHash": "0x...",
  "successfulTransactionHash": "0x..."
}
```

By default this route returns HTTP `410` / `LEGACY_WRITES_DISABLED`. With the explicit legacy-write switch enabled, the hashes are checked against the committed source transactions. When omitted, the service uses the committed hashes. It builds one Attestcoin batch for the ordered receipts, performs the exact pool `staticCall`, and only then submits through the testnet relayer role.

HTTP `425` means the source window or transactions are not ready, or Attestcoin has not finalized both receipts. Retry this route with bounded backoff; do not treat unrelated `4xx` responses as retryable. If another request wins the release race, the API returns the existing release. Replay never emits a second credit.

## Trust boundary

API validation, source RPC reads, proof construction, native index calculation, and simulations fail fast and improve operator feedback; they are not payout authority. The active campaign stores exact funded terms. The native Attestcoin verifier proves the two ordered Ethereum receipts, the predicate enforces canonical paid SeaDrop failure-to-completion semantics, and the campaign derives the destination and consumes current-campaign wallet/query/pair replay before releasing funds.

The service process derives a dedicated Creditcoin testnet relayer role from its secret. Recovery releases use that role rather than the campaign sponsor's nonce domain. The relayer can pay gas and relay any valid proof, but cannot redirect a credit, change campaign terms, create source evidence, withdraw active capacity, or bypass replay. Archived V3 write routes are disabled unless `RETRYCREDIT_LEGACY_WRITES_ENABLED=true` is explicitly set. Never expose either key.
