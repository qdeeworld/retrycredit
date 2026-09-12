# Community helper recovery

This document describes an optional, configuration-gated V2 workflow. Repository support is not evidence that a public deployment has enabled it or that an independent person has completed it. Read the deployment's recovery configuration for current availability.

## Roles and result

- **Owner:** the wallet established by the original Ethereum pair signs the existing owner consent.
- **Helper requester:** a different wallet from the derived source signs a separately worded request to have that source wallet's fixed credit delivered. The helper wallet receives nothing and cannot redirect the credit. A requester that is the source wallet must use the owner path.
- **Beneficiary:** always the source wallet independently established by the pair and enforced by the native proof, predicate and campaign contract.
- **Hosted relayer:** constructs the proof and pays the bounded Creditcoin transaction fee. It is the transaction sender recorded onchain, not necessarily the helper requester.

A helper's signature is the helper's request, not recipient consent, recipient awareness, demand, or adoption. A successful helper release consumes the source wallet's sponsor-wide one-time entitlement even if its owner never participated. The credit is testnet `tCTC`, not a refund of Ethereum gas or a reimbursement promise made before the historical mint.

No new contract, destination parameter or source transaction is introduced. The ordinary owner path remains available with its original signature meaning. When helper mode is configured, both paid paths share the same admission and spending constraints.

## Finding an incident

Helper discovery reads the checked-in catalog of 89 advisory public hash pairs. It rotates through at most four candidates per request, applies the ordinary source-rule and campaign checks, and excludes sources already held by the durable coordinator. An alternate pair cannot evade a source's reservation. No proof construction or spending admission happens during discovery.

The catalog is finite. It is not 89 users, 89 unused credits, or proof that the native proof service supports every listed block range. `none-in-window` means the bounded pass found no available match, not that all history has been checked. Wallet-address discovery and exact-pair input remain advanced fallbacks; manual inputs receive the same independent checks and cannot select a beneficiary.

After reviewing a candidate, the requester connects their own wallet, distinct from the derived source, and signs the exact five-minute helper message. The server and durable policy reject same-wallet helper requests rather than issuing contradictory consent; the owner path remains available for that wallet. Different addresses do not establish that different humans control them. The browser does not need Creditcoin funds or a network switch. A returned operation is tracked to an observed result; closing the page does not intentionally cancel the service's admitted work. Process failure can still stop progress and require operator reconciliation.

## Durable spending envelope

The Node runtime's configured pilot ceilings are:

| Limit | Maximum |
| --- | --- |
| Proof/attempt admissions | 9 |
| Payout allocations | 9 |
| Credit per successful release | `100000000000000000` wei (`0.1 tCTC`) |
| Reserved fee per operation | `2000000000000000` wei (`0.002 tCTC`) |
| Aggregate reserved fees | `18000000000000000` wei (`0.018 tCTC`) |

The nine credit allocations use the existing campaign's remaining `0.9 tCTC`; configuring the feature does not fund more credits. Configuration can lower the attempt, allocation and fee ceilings, not silently raise them. Onchain capacity and current eligibility can further restrict execution.

An authenticated Cloudflare Durable Object owns one immutable campaign-wide spending atom:

```text
retrycredit-spending:<settlementChainId>:<lowercasePoolAddress>:<campaignNumber>
```

The atom excludes requester, code revision, process, authentication token, budget, expiry and relayer. The exact relayer and all limits are instead bound in its immutable stored policy. Changing them after initialization fails closed; a signer or token rotation cannot legitimately reset campaign spending.

Operation identity is `keccak256(abi.encode(chainId, pool, campaignNumber, sourceWallet, failedHash, successfulHash))`. It excludes helper identity and role. The coordinator also retains a permanent source lock, so changing helpers or selecting another pair for the source cannot obtain another admission. Owner requests use this same identity and budget.

Before requesting a native proof, admission permanently reserves one attempt, one payout allocation and the operation's maximum fee. Failed proofs, simulations, stopped work and reverted transactions do not refill those counters. These are conservative reservations, not a claim that an unsuccessful attempt transferred a credit or spent its entire fee ceiling. Failed pre-broadcast work leaves the onchain credit in the campaign but consumes its internal pilot allocation.

Only one unresolved spending operation is admitted at a time. Before sending, the backend checks live nonce and fee information, simulates the immutable release, constructs a zero-value transaction with explicit gas price and bounded gas, and validates the fully signed transaction's exact fields. Its hash and nonce are durably persisted before the coordinator grants one broadcast permission. Repeated requests never receive a second permission. A new nonce must exceed all previously recorded nonces.

A lost reserve acknowledgement, lost preparation acknowledgement, process restart, missing receipt or ambiguous broadcast is not permission to retry, replace a transaction or reclaim the allocation. The coordinator does not store a private key, wallet signature or raw signed transaction. Receipt truth is checked by the authenticated backend, not independently fetched by the Durable Object.

## Configuration

The Node application requires:

- Explicit active V2 recovery configuration and its observed, authenticated deployment.
- `RETRYCREDIT_HELPER_ENABLED=true`.
- Both `RETRYCREDIT_PUBLIC_ENABLED` and `RETRYCREDIT_LEGACY_WRITES_ENABLED` disabled. The startup guard executes before constructing legacy writers; archived proof preparation cannot bypass the helper envelope.
- `RETRYCREDIT_HELPER_LEDGER_URL`: a backend-only HTTPS origin.
- `RETRYCREDIT_HELPER_LEDGER_TOKEN`: the protected coordinator bearer secret, never a browser variable.
- `RETRYCREDIT_HELPER_LEDGER_POLICY`: JSON with the following exact structure.

```text
identity:
  chainId: positive integer (102031 for this pilot)
  poolAddress: exact active V2 address
  campaignNumber: exact active campaign number
  relayerAddress: exact server-derived relayer address
limits:
  maxAttempts: positive integer, at most 9
  maxPayouts: positive integer, at most 9
  maxTotalFeeWei: positive decimal string, at most "18000000000000000"
  maxFeeWei: positive decimal string, at most "2000000000000000"
  creditWei: "100000000000000000"
  expiresAt: Unix seconds, no later than the immutable campaign deadline
```

The coordinator uses the matching policy in `HELPER_LEDGER_POLICY`, its protected `HELPER_LEDGER_TOKEN`, and a separate `HELPER_LEDGER_ENABLED` admission switch. The checked-in Wrangler configuration is deliberately disabled and unconfigured. It is not a deploy-ready spending policy.

Startup binds policy to the exact chain, pool, campaign, relayer, fixed credit and deadline. Both systems must agree. Do not silently repair a mismatch, initialize a replacement namespace, or increase a limit to get past a refusal.

API configuration separates route support (`helper.enabled`) from the current ability to admit another operation (`helper.available`, `helper.admissionState`). The latter is a fresh snapshot, not an atomic reservation; actual admission and contract eligibility can still reject a race. Paused, busy, expired or exhausted admissions must not hide the status of an earlier request. The exact HTTP schemas are in [WORKER_API.md](WORKER_API.md#optional-community-helper-routes).

## Containment and recovery

Pause new admissions with the coordinator's `HELPER_LEDGER_ENABLED=false`, retaining the Node coordinator configuration and its public operation-status routes. Ledger reads and exact receipt reconciliation remain possible after pausing or expiry. Existing prepared transactions remain potentially broadcastable or pending; pausing does not cancel a transaction or erase an allocation.

Never contain or roll back this workflow by disabling/removing the Node helper coordinator, deleting Durable Object state, switching the namespace/atom, changing stored policy, or restoring an uncoordinated owner writer while the coordinated campaign is active. Node rejects nonempty helper settings combined with a disabled helper flag. Emergency service shutdown may stop serving traffic, but the durable authority must be preserved for recovery.

For an `admitted` operation whose worker stopped before transaction preparation, an authorized operator may use the private `abandonBeforeBroadcast` coordinator action. It atomically changes that operation to `stopped`, retains its source and budget reservations, and releases only the global active slot. It does not cancel proof work already running. An old permit can no longer prepare or broadcast that operation. The action must not be exposed as a public/browser timeout or retry route.

Once a transaction hash is durably prepared, abandonment is refused. Reconcile only the saved transaction's exact receipt. `settled` means the backend validated its successful recovery result; `reverted` means the exact transaction released no credit. A missing, inconsistent or unverified receipt remains uncertain. Never infer successful settlement from a nonce change alone or create a replacement transaction to clear the status.

### Prepared transaction with no receipt: operator decision

1. Preserve the exact operation ID, transaction hash, nonce, source pair, campaign, coordinator namespace and policy. Do not copy private signing material into an incident report.
2. Check the operation and exact transaction/receipt through the configured chain RPC. A missing transaction and an advanced account nonce are observations, not proof of failure or permission to release the active slot.
3. If the exact receipt exists, use the existing status reconciliation path; it must validate the expected beneficiary, amount and recovery event. Do not send another recovery request.
4. If no receipt exists, keep the operation unresolved. When containment is necessary, pause new coordinator admissions while preserving status reads and all reservations. Pausing cannot cancel a signed transaction.
5. If the process stopped after durable preparation but before broadcasting and its signed bytes are unavailable, this implementation has **no safe automatic recovery path**. Hosted intake may remain blocked. Do not clear the lock, reset budgets, abandon a prepared operation, replace the nonce, or create another writer/namespace. Durable same-transaction recovery requires a separately reviewed implementation.

The UI independently rechecks a reported settlement against the source-pair receipt. Until that check succeeds it labels settlement as reported, not confirmed. Explicit identity/receipt conflicts remove the success presentation and keep status-only actions. A later unavailable refresh preserves an earlier successful confirmation; it does not imply reversal of the transfer.

Validation commands for this component are `node --test test/recovery-campaign-service.test.mjs test/helper-ledger-client.test.mjs` and `npx vitest run --config vitest.helper.config.mjs`. These exercise local/real-workerd behavior, not a live public helper completion.
