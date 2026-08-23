# RetryCredit public V3 deployment

This page records the active RetryCredit public testnet release deployed on August 22, 2026. “V3” is the release marker exposed by `RetryCreditUniversalRouterPoolV2.PUBLIC_PILOT_VERSION`; the deployed Solidity classes retain their `V2` names.

- Public app: <https://retrycredit.dolepee.com>
- Proof and execution API: <https://retrycredit.onrender.com>
- Settlement network: Creditcoin Testnet (`102031`)
- Source network: Ethereum Sepolia (`11155111`), Attestcoin `chainKey 1`
- Creditcoin RPC: <https://rpc.cc3-testnet.creditcoin.network>
- Creditcoin explorer: <https://creditcoin-testnet.blockscout.com>

This is a controlled, test-asset pilot. The deployment is not a production, insurance, or exact-gas-reimbursement claim.

## Active contracts

| Contract | Address | Deployment transaction |
| --- | --- | --- |
| `EvmV1Decoder` | [`0xFB6E…AFE3`](https://creditcoin-testnet.blockscout.com/address/0xFB6E577ED8B472AC4aC99fA0Dbc0e3BF904BAFE3) | [`0x5061…4d5f`](https://creditcoin-testnet.blockscout.com/tx/0x5061c4d921f628d77604482f525f836e675847b50ac7cfdcb2f23e7025394d5f) |
| `RetryCreditUniversalRouterPredicateV2` | [`0x6AF7…c86`](https://creditcoin-testnet.blockscout.com/address/0x6AF76Af54861f9F6E9F38cfD02A1002dc650bc86) | [`0x0824…092d`](https://creditcoin-testnet.blockscout.com/tx/0x08240d90ee835ade06a89ceb87d6e43571bd195208279076aa93a65202b9092d) |
| `AttestcoinRetryCreditUniversalRouterVerifierV2` | [`0x97Fa…86fC`](https://creditcoin-testnet.blockscout.com/address/0x97Fa88CfCaeE1a5D4Ae749b9b5698F2147b986fC) | [`0x433e…e16`](https://creditcoin-testnet.blockscout.com/tx/0x433eefd382a20208d184208cee9713f74c1cc82dc7239125203778cd82778e16) |
| `RetryCreditUniversalRouterPoolV2` | [`0x81b5…8A1`](https://creditcoin-testnet.blockscout.com/address/0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1) | [`0xc43b…a1e7`](https://creditcoin-testnet.blockscout.com/tx/0xc43bec8db3c135edc8aaa05c21f30e18bfd708bda483bcce9a71df71079ba1e7) |

The verifier calls Creditcoin's native Attestcoin query verifier at `0x0000000000000000000000000000000000000FD2`. The pool reads the registered Sepolia source identity through native ChainInfo at `0x0000000000000000000000000000000000000FD3`.

## Public E3 receipt chain

The current public replayable lifecycle is:

1. Included status-zero Sepolia route: [`0x9cb8…ee07`](https://sepolia.etherscan.io/tx/0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07)
2. Settled Sepolia retry: [`0x81e9…f9b0`](https://sepolia.etherscan.io/tx/0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0)
3. Creditcoin release: [`0xb787…7cdf`](https://creditcoin-testnet.blockscout.com/tx/0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf)

The first route is a disclosed controlled stale-route test. These receipts prove a fresh public service execution with test assets; they do not prove independent adoption or customer demand.

## What is enforced

Before the fixed credit can be released, the active contracts require one native Attestcoin batch for two ordered Sepolia receipts. The committed signed routes must bind the same funded action, route signer, service executor, beneficiary, official Uniswap router and pool, input amount, and intent. The first receipt must have status zero; the refreshed route must settle through the exact pool and transfer the minimum test-USDC output to the beneficiary. Query, pair, action, and service-credit replay state is consumed onchain.

The public service prepares and simulates candidates, but those checks are fail-fast conveniences. Native verification, the predicate, and pool state remain payout authority.

## Archived predecessor

Older RuleDrop addresses, campaigns, and Ethereum-mainnet `chainKey 3` receipts are archived proof-engine predecessor evidence, not the active RetryCredit product. See [the archived RuleDrop mainnet proof note](./MAINNET_PROOF_GATE_2026-08-13.md) for that historical context.
