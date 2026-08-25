# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Wallet users running the public testnet recovery flow. Their job is to complete one bounded stale-swap retry, receive the intended test-USDC output, and receive the fixed Creditcoin service credit without supplying a deposit or funding the retry.

## Product Purpose

RetryCredit is a self-service execution recovery product for one pre-funded DeFi action. A successful experience makes the current state, next action, settlement result, and service-credit release understandable without requiring the user to inspect contracts or competition material.

## Positioning

The stale route and refreshed route are committed as one funded action before execution; an ordered native Attestcoin batch must prove the included failure and exact later settlement before one fixed Creditcoin release can occur.

## Operating Context

The current pilot runs in an EVM wallet on Ethereum Sepolia and Creditcoin Testnet. The public journey is connect wallet, authorize the beneficiary, prepare the funded routes, execute the stale and refreshed attempts, and finalize or resume the Creditcoin release. A saved browser session can be resumed by the same wallet.

## Capabilities and Constraints

- The visitor signs only to name the wallet receiving test-USDC output and the Creditcoin credit.
- The service funds and sends the bounded testnet transactions.
- The stale and refreshed signed routes are committed before either is broadcast.
- Settlement is currently one WETH to Circle test-USDC route through the official Uniswap Universal Router.
- The credit releases once; query, pair, action, and service-credit replay are blocked onchain.
- The interface must preserve loading, paused, temporary-unavailable, wrong-wallet, recoverable-error, saved-session, settled, and released states.
- The pilot is testnet-only and is not insurance, custody, exact gas reimbursement, or a production-asset service.
- There is no judge page, invoice product, or business-validation requirement.

## Evidence on Hand

- Public included failure: `0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07`.
- Public refreshed settlement: `0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0`.
- Public Creditcoin release: `0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf`.
- The completed public lifecycle took 552 seconds and a replay produced no second release.
- Repository truth and deployment records are in `README.md` and `docs/DEPLOYMENTS.md`.
- There is no customer testimony or independent demand evidence; the pilot used test assets and a founder-funded service credit.

## Product Principles

- Make the next recovery action unmistakable before exposing implementation detail.
- Keep the live run, historical activity, and protocol boundary in separate navigable surfaces.
- Preserve the relationship between included failure, exact settlement, and one-time release.
- State network, sponsorship, and testnet limits where they affect a decision.
- Treat technical receipts as user confirmation, not as the product's primary narrative.

## Accessibility & Inclusion

The public web product must support keyboard navigation, visible focus, semantic live status, reduced motion, safe wrapping for addresses and hashes, 200% zoom, and touch targets of at least 44 by 44 pixels.
