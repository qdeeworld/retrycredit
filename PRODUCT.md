# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owners of Ethereum wallets in the closed paid SeaDrop recovery cohort. Their job is to check whether the wallet's already-public failed-then-completed mint qualifies, consent with that same wallet, and receive one fixed Creditcoin Testnet recovery without selecting a destination.

## Product Purpose

RetryCredit is a self-service recovery campaign for a completed onchain retry. A successful experience makes eligibility, the ordered source pair, the fixed amount, the proof wait, and the final release understandable without requiring the user to inspect contracts or competition material.

## Positioning

One native Attestcoin batch must prove a paid Ethereum SeaDrop failure and the same wallet's consecutive-nonce completion before an immutable, pre-funded Creditcoin campaign can release one fixed credit to the source-derived address.

## Operating Context

The source evidence is on Ethereum Mainnet and settlement is on Creditcoin Testnet. The public journey is connect the source wallet, check the closed discovery cohort against live transactions and receipts, sign a five-minute consent, wait for one pair-local Attestcoin proof, and inspect the fixed release. No source transaction or network switch is requested.

## Capabilities and Constraints

- The wallet signs only a short-lived offchain consent bound to origin, wallet, pool, campaign, and the exact pair.
- The source transactions already exist; the product never manufactures the failure or completion.
- The relayer cannot supply or replace the destination. The predicate returns the shared Ethereum source sender.
- Eligibility requires type-2 canonical paid `mintSigned` calls, consecutive nonces, bounded blocks, status `0 → 1`, one exact `SeaDropMint`, and quantity-matched ERC-721 mints.
- The fixed credit releases once per wallet inside the campaign; campaign-scoped query and pair replay markers prevent duplicates without enabling outsider dust-campaign poisoning.
- The interface must preserve loading, unavailable, offline, disconnected, checking, ineligible, eligible, authorizing, proof-pending, relay-pending, released, already-claimed, account-changed, and retryable-error states.
- The pilot is testnet-only and is not insurance, custody, exact gas reimbursement, or a production-asset service.
- There is no judge page, invoice product, or business-validation requirement.

## Evidence on Hand

- Organic paid Ethereum failure: `0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff`.
- Same-wallet completion: `0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a`.
- Exact Creditcoin release: `0xc6e8ff4ec62f6a74de408c185ea0bdec318067c9bc9dab421118c13b1ed22a85`.
- Campaign `#1` at `0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66` is funded with three `0.1 tCTC` slots; one is released and two remain.
- Replay state is consumed and historical beneficiary/pool balances show the exact `0.1 tCTC` movement.
- Repository truth and deployment records are in `README.md` and `docs/DEPLOYMENTS.md`.
- There is no customer testimony or independent wallet-owner use. The first release was founder-relayed to an unrelated historical source address and proves E2 public onchain execution, not public-product causability or adoption.

## Product Principles

- Lead with the completed recovery and the source wallet's next action.
- Keep Recovery, Cases, and Protocol as separate navigable surfaces.
- Preserve the relationship between paid failure, completed mint, and one fixed release.
- State network, sponsorship, cohort, deadline, and testnet limits where they affect a decision.
- Treat receipts as contextual confirmation and never present public addresses as users.

## Accessibility & Inclusion

The public web product must support keyboard navigation, visible focus, semantic live status, reduced motion, safe wrapping for addresses and hashes, 200% zoom, and touch targets of at least 44 by 44 pixels.
