# RetryCredit

**A fixed recovery credit for a completed onchain retry.**

RetryCredit is a pre-funded recovery campaign for an exact Ethereum transaction pattern: one paid SeaDrop mint fails, the same wallet completes the same mint on its next nonce, and one native Attestcoin batch proves both receipts before Creditcoin releases a fixed credit to that source wallet.

- [Use the public recovery app](https://retrycredit.dolepee.com)
- [Inspect the live contracts and receipts](docs/DEPLOYMENTS.md)
- [Run or integrate the recovery API](docs/WORKER_API.md)
- Read the [campaign](contracts/src/RetryCreditRecoveryCampaign.sol), [verifier](contracts/src/AttestcoinSeaDropRetryVerifier.sol), and [predicate](contracts/src/SeaDropPaidRetryPredicateV1.sol)

## The recovery path

1. Paste the failed paid mint and its later successful retry as transaction hashes or canonical Etherscan URLs. No wallet connection is needed to check them.
2. RetryCredit re-reads both mainnet transactions and receipts, validates the funded rule, and derives the source wallet from live facts; the three public examples are never eligibility authority.
3. Only after the pair qualifies, that derived wallet signs a five-minute hosted-relayer consent bound to the exact pair, public origin, campaign, and pool.
4. The relayer builds one pair-local Attestcoin batch and simulates the immutable campaign release.
5. The contract derives the beneficiary from the proven source transaction and releases exactly `0.1 tCTC`. There is no destination field.

The first campaign is intentionally small: three fixed slots, exactly `0.3 tCTC` funded, and unused funds recoverable only by the sponsor after the deadline. Each wallet, query, and pair is consumed within that campaign. Replay state is campaign-scoped so an outsider cannot poison the official campaign with a dust-funded copy.

## Why Attestcoin is load-bearing

The verifier accepts exactly two ordered Ethereum-mainnet transactions in one native Attestcoin batch. The predicate then requires:

- Type-2 transactions to the canonical SeaDrop contract and canonical `mintSigned` calldata, optionally followed only by OpenSea's measured `0x3d958fe2` attribution suffix.
- One source wallet, consecutive nonces, a one-to-five-block gap, and the same NFT, quantity, payment, fee recipient, minter, and all eight mint parameters.
- A status-0 first receipt with no logs.
- A status-1 second receipt with one exact `SeaDropMint` and the requested number of distinct ERC-721 mints to the same source wallet.
- A nonzero, exact paid mint value and a payout beneficiary derived only from the shared source sender.

Remove Attestcoin and the Creditcoin campaign cannot establish inclusion, receipt status, order, or mint outcome. API checks and the proof builder only fail fast; the native verifier, predicate, and funded campaign remain payout authority.

## Live evidence

The first verified Recovery Campaign release executed on August 26, 2026:

- Organic paid failure: [`0xed17…d3ff`](https://etherscan.io/tx/0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff)
- Same-wallet completion two blocks later: [`0x8dbb…ec3a`](https://etherscan.io/tx/0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a)
- Exact `0.1 tCTC` Creditcoin release: [`0xc6e8…2a85`](https://creditcoin-testnet.blockscout.com/tx/0xc6e8ff4ec62f6a74de408c185ea0bdec318067c9bc9dab421118c13b1ed22a85)
- Active campaign: [`0x646c…dF66`](https://creditcoin-testnet.blockscout.com/address/0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66), campaign `#1`

At the release block, the proven beneficiary moved from `0` to `0.1 tCTC`, the campaign moved from `0.3` to `0.2 tCTC`, claim count became `1/3`, and the failure query, success query, and pair replay markers were all consumed. This is E2 public execution relayed by the founder against an unrelated historical address; it is not public-product causability or proof that the wallet owner used RetryCredit, consented to the unsolicited testnet credit, or represents customer demand.

## Contracts

- `RetryCreditRecoveryCampaign`: immutable funded terms, fixed capacity, proof-derived payouts, campaign-scoped replay, one claim per wallet, and accounted-only remainder recovery.
- `AttestcoinSeaDropRetryVerifier`: exact two-transaction native batch verification on Attestcoin chain key `3` / Ethereum chain ID `1`.
- `SeaDropPaidRetryPredicateV1`: canonical call decoding and strict failed-then-completed paid-mint semantics.
- `EvmV1Decoder`: strict Attestcoin EVM transaction and receipt decoding.

The earlier Sepolia/Uniswap service remains in the repository and its public receipts remain documented as a controlled predecessor. It is not the protagonist of the Recovery Campaign release.

## Local verification

```bash
npm ci
npm test
npm run build
npm run build:web:cloudflare
npm run verify:recovery-gate
```

For a local journey, copy `.env.example` to `.env`, populate only testnet values, run `node --env-file=.env src/server.mjs`, and start `npm run app:dev` in a second terminal. See [the API guide](docs/WORKER_API.md) for route contracts, retry behavior, configuration, and trust boundaries.

## Truth boundary

Attestcoin proves the included paid failure, later completion, and exact onchain outcome. It does **not** prove a human-readable failure reason, human identity, intent, user loss, exact gas expenditure, insurance eligibility, adoption, or demand. The three published examples are a public-chain research set, not three users and not the boundary of Open Pair Intake.
