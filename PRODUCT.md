# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owners of Ethereum wallets whose included failure and same-wallet completion may satisfy a Recovery Campaign, and distinct community helpers requesting a credit for those owners. The shipped adapter is a paid SeaDrop mint campaign. Anyone can check an exact pair without connecting. The source owner or a distinct helper can authorize their respective hosted request; only the original source wallet receives the credit. A helper receives nothing and does not establish recipient consent.

## Product Purpose

RetryCredit lets an application fund fixed credits for verified failed-then-completed transactions. The current pilot is retrospective: it rewards an eligible historical completed retry. It does not complete a pending action, recover lost principal or reimburse exact gas. Independent sponsor demand and beneficiary value remain unproven; an embedded application-support workflow is a direction to validate, not a shipped customer outcome.

## Positioning

One native Attestcoin batch authenticates an included failure and the same wallet's semantic completion; the funded Creditcoin contract then enforces the rule and the fixed source-derived recipient. The current specialization uses existing paid SeaDrop mints on Ethereum Mainnet and settles in testnet tCTC. The distinguishing combination is two-receipt semantic verification on existing infrastructure and helper submission without payout redirection, not an assertion that proof-triggered rebates have no competitors.

## Operating Context

The active source evidence is on Ethereum Mainnet and settlement is on Creditcoin Testnet. An owner can connect and search a bounded wallet history; a helper can search a bounded public catalog without finding transaction hashes manually. Both paths independently revalidate the selected pair. The requester signs a short-lived authorization for their exact role, origin, campaign and pair. The sponsor pays processing gas; no source transaction, Creditcoin funds or network switch is required from the requester. Exact pair entry remains an advanced fallback. Discovery, published examples and campaign manifests are not eligibility authority. Reload/status checks restore the public operation without repeating signing or submission.

## Capabilities and Constraints

- The wallet signs only a short-lived offchain consent bound to origin, wallet, pool, campaign, and the exact pair.
- The source transactions already exist; the product never manufactures the failure or completion.
- A Recovery Promise can describe an action as Recovery-backed only when authenticated live terms were funded before that action. The historical SeaDrop pilot must not be retroactively described that way.
- V2 requires the source-window end to be attested before campaign creation. A prospective pre-action promise requires a separately reviewed contract/policy change; it is not a feature of this deployment.
- A campaign manifest is a product projection of authenticated configuration and contract state. It cannot authorize a release or replace receipt validation.
- The relayer cannot supply or replace the destination. The predicate returns the shared Ethereum source sender.
- Eligibility requires type-2 canonical paid `mintSigned` calls, consecutive nonces, bounded blocks, status `0 → 1`, one exact `SeaDropMint`, and quantity-matched ERC-721 mints.
- Active V2 checks its bound predecessor and enforces same-sponsor wallet, query and pair replay protection across campaigns. Creating another campaign does not allow this sponsor to repay consumed evidence or the same beneficiary. An unrelated sponsor's pool cannot consume this sponsor's entitlement.
- Owner and helper requests share bounded, durable processing reservations. Contract credits remaining and hosted processing capacity are different quantities. Failed or abandoned admitted attempts retain their reservations.
- Backend-reported settlement is distinct from receipt-confirmed success. Explicit evidence conflicts remove unconditional success and preserve status-only handling. Temporary read outages do not undo an earlier successful receipt check.
- A durably prepared transaction cannot be abandoned to free capacity. A missing receipt does not authorize replacement, ledger reset or another writer. See [operator containment and recovery](docs/COMMUNITY_HELPER.md#containment-and-recovery).
- The interface must preserve loading, unavailable, offline, disconnected, checking, ineligible, eligible, authorizing, proof-pending, relay-pending, released, already-claimed, account-changed, and retryable-error states.
- The pilot is testnet-only and is not insurance, custody, exact gas reimbursement, or a production-asset service.
- There is no judge page, invoice product, or business-validation requirement.

## Evidence on Hand

- Organic paid Ethereum failure: `0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff`.
- Same-wallet completion: `0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a`.
- Exact Creditcoin release: `0xc6e8ff4ec62f6a74de408c185ea0bdec318067c9bc9dab421118c13b1ed22a85`.
- The pair and release above belong to predecessor campaign `#1` at `0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66`. They demonstrate prior recovery/replay refusal, not fresh available inventory.
- Active V2 campaign `#1` at `0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8` was originally funded for ten fixed `0.1 tCTC` credits. Remaining credits and hosted processing allocations are live, separately bounded state.
- September 12 assisted public helper execution: `0x8a79a60168b144a33c799496bfa548fd9fc5d0918aa3bb573aa99372efd5ae9d` paid `0.1 tCTC` to source `0x354BAb4d9191375da145E5bc3C1f67E6d3d70231`; the helper received nothing. This establishes assisted public execution, not independent cold completion or adoption.
- Replay state is consumed and historical beneficiary/pool balances show the exact `0.1 tCTC` movement.
- Repository truth and deployment records are in `README.md` and `docs/DEPLOYMENTS.md`.
- There is no established customer testimony, independent wallet-owner use or sponsor demand. Historical recipients are not automatically users; assisted public execution does not establish beneficiary consent or commercial value.

## Product Principles

- Lead with the completed recovery and the source wallet's next action.
- Make the sponsor, fixed promise, qualifying completion, and resulting credit legible in one sentence before explaining proof machinery.
- Keep Recovery, Cases, and Protocol as separate navigable surfaces.
- Preserve the relationship between paid failure, completed mint, and one fixed release.
- State network, sponsorship, source window, deadline, and testnet limits where they affect a decision.
- Treat receipts as contextual confirmation and never present public addresses as users.

## Accessibility & Inclusion

The public web product must support keyboard navigation, visible focus, semantic live status, reduced motion, safe wrapping for addresses and hashes, 200% zoom, and touch targets of at least 44 by 44 pixels.
