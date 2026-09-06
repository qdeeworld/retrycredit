# Recovery adapter boundary

RetryCredit does not treat every failed transaction as interchangeable. Each adapter describes one semantic action family and projects its evidence through the same campaign-manifest shape. The manifest is product context; it never authorizes a release.

## Shared boundary

Every adapter manifest identifies:

- its action family and evidence role;
- source network and Attestcoin chain key;
- Creditcoin settlement identity;
- funded or archived credit state;
- the authority fields available for that release;
- whether the action was Recovery-backed before it occurred;
- the exact disclosure that limits the claim.

The active paid-mint manifest is reconstructed from the already-validated `/api/recovery/config` response. Its pool, campaign, sponsor, verifier, predicate, terms hash, source window, amount, capacity, deadline, and release state come from authenticated deployed configuration. Wallet discovery and the manifest remain advisory; live receipt validation, native Attestcoin verification, the immutable predicate, and replay state authorize release.

The archived Universal Router manifest uses the same projection but has a different evidence role. It binds the published Sepolia failure, completion, and Creditcoin release receipts and refuses an enabled write configuration. It proves that a second strict paired-receipt predicate was implemented. Because the service funded and generated the source attempts, it is not an organic incident, independent use, or active provider demand.

## Action families that fit

An action fits the current paired-receipt primitive only when all of these are true:

1. both attempts are present included transactions on an Attestcoin-supported source chain;
2. one source sender can be derived from both receipts;
3. stable semantic fields identify the same intended action without relying on transaction-hash allowlisting;
4. the first receipt has an objective failed state;
5. the second receipt has an objective completion outcome in its logs or transfers;
6. ordering, nonce, and bounded timing rules make the relationship narrow enough to resist farming;
7. the fixed service credit can safely go to the derived source wallet;
8. wallet, query, and pair replay domains can be consumed exactly once.

Likely fits include an authorized mint whose refreshed authorization completes, a tightly specified router action whose refreshed quote settles, and another app action with an exact completion event and stable intent fields.

## Action families that do not fit

The current primitive must reject or defer:

- failure with no later completion;
- “funds never arrived” or other absence claims;
- bridge or cross-chain delivery claims that require current destination state;
- arbitrary contract failures correlated only by selector, user, or proximity;
- a human-readable reason for revert;
- exact loss, exact gas reimbursement, insurance, cover, or discretionary assessment;
- completion whose beneficiary differs from the proven source wallet;
- unsupported source chains;
- mutable provider attestations that replace receipt semantics.

## When a new contract is justified

No new contract is needed to render an authenticated manifest, disclose a pre-funded campaign, or add a new offchain adapter over an existing immutable predicate. Contract work is justified only if a validated user journey needs a genuinely new semantic predicate or if future campaigns must store a new immutable term that release authority itself requires. Marketing metadata, provider dashboards, and adapter counts are not sufficient reasons.
