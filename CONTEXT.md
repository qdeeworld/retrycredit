# RetryCredit domain language

## Recovery-backed action

An onchain action for which an identified sponsor has pre-funded fixed service credits under published campaign terms. A historical action does not become Recovery-backed merely because a later campaign recognizes it.

## Recovery campaign

The immutable funded Creditcoin program that defines one source action, source window, fixed credit, capacity, deadline, predicate, and replay boundary.

## Recovery Promise

The user-readable projection of authenticated campaign terms before an action. It is a service-credit promise, not insurance, a warranty, cover, a refund, or a loss calculation.

## Recovery Center

The wallet-first product surface that discovers qualifying recoveries, explains live campaign terms, obtains bounded relay consent, and shows the resulting release.

## Qualifying recovery

Two ordered source-chain receipts from the same wallet: an included failed attempt followed by completion of the same semantic action, both satisfying the campaign's immutable predicate.

## Service credit

A fixed sponsor-funded amount released after a qualifying recovery. It does not represent the failed transaction's exact gas cost or assessed loss.

## Sponsor

The address that funds a campaign and can recover only unused accounted capacity after the campaign deadline. Sponsorship does not imply that the source app, protocol, or collection endorses RetryCredit.

## Source wallet

The sender derived from both proven source receipts. It is the only payout beneficiary; neither the browser nor relayer supplies a destination.

## Campaign manifest

A validated product projection reconstructed from authenticated deployed configuration and contract state. It is not editable marketing authority and cannot authorize a release.

## Reference adapter

The narrow product description and semantic validator for one action family. The SeaDrop paid-mint adapter is the organic mainnet reference. The archived Universal Router adapter proves a second predicate family but not independent demand.

## Relay consent

A short-lived offchain signature binding the hosted relayer to the exact origin, source wallet, pool, campaign, and receipt pair. It does not alter contract payout authority.
