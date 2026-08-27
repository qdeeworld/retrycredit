# RetryCredit Recovery Campaign deployments

This page records the live V1 Recovery Campaign, its exact public-chain lifecycle, and the finalized lineage-aware V2 continuation deployed on August 27, 2026.

- Public app: <https://retrycredit.dolepee.com>
- Proof and execution API: <https://retrycredit-api.onrender.com>
- Settlement network: Creditcoin Testnet (`102031`)
- Source network: Ethereum Mainnet (`1`), Attestcoin `chainKey 3`
- Creditcoin RPC: <https://rpc.cc3-testnet.creditcoin.network>
- Creditcoin explorer: <https://creditcoin-testnet.blockscout.com>

This is a founder-funded testnet recovery pilot. Ethereum source receipts are real historical mainnet transactions; the released asset is Creditcoin testnet CTC. The deployment is not insurance, compensation, exact gas reimbursement, wallet-owner consent, or independent adoption.

## Hosting authority and rollback boundary

The production API authority is the isolated Render service `retrycredit-api` (`srv-da5n322jobas73f8tp70`) at <https://retrycredit-api.onrender.com>. The Blueprint-created `retrycredit-api-6fs3` service (`srv-da5nh93m8hqs73da7170`) is a separate duplicate whose observed `main` deployments fail; it is not the production API. The checked-in `render.yaml` currently describes that duplicate and is therefore not deployment authority. Reconcile the duplicate and Blueprint ownership through authenticated Render controls before using the manifest as release evidence.

The public interface calls only the Recovery Campaign routes. Setting `RETRYCREDIT_RECOVERY_ENABLED=false` on the stable API is a safe containment switch and leaves only the archived V3 read/challenge/status surface available by default; prepare, execute, and release return HTTP `410` while `RETRYCREDIT_LEGACY_WRITES_ENABLED` is false. This does not restore the previous V3 interface. Keep legacy writes disabled so the archived write path cannot share the active recovery runtime. A full product rollback requires a reviewed Render API deploy and its matching reviewed Cloudflare Pages frontend deployment. Verify the exact source, API health and config, production-origin CORS, public app, and Recovery Campaign state after rollback; do not declare parity from either provider in isolation.

Release order is API first, frontend second: verify the stable Render config exposes the canonical `publicOrigin` before publishing the config-bound frontend. Rollback order is frontend first, API second. This preserves compatibility because the prior frontend ignores the new field, while the hardened frontend deliberately rejects a prior config that cannot anchor the exact consent text.

## Active contracts

| Contract | Address | Deployment transaction |
| --- | --- | --- |
| `EvmV1Decoder` | [`0x2244…Bbae`](https://creditcoin-testnet.blockscout.com/address/0x2244DD3047a587b3Fe87b74381Cfd4Fb6031Bbae) | [`0xd05d…c6bf`](https://creditcoin-testnet.blockscout.com/tx/0xd05d1987678e0b7c3a9bccb088ae0486c36c7b2e55f2383a93086a187670c6bf) |
| `SeaDropPaidRetryPredicateV1` | [`0xC51E…D814`](https://creditcoin-testnet.blockscout.com/address/0xC51E1cA69554Bb9D44a20fd837C217cAAFd6D814) | [`0x3431…167f`](https://creditcoin-testnet.blockscout.com/tx/0x3431b57972b71e548e534add52e9fd9d98f90ffa406ab3f7e8b8917e426bd167) |
| `AttestcoinSeaDropRetryVerifier` | [`0x151f…A4Ab`](https://creditcoin-testnet.blockscout.com/address/0x151f65d1199Dbb4dD9842681D15650d18332A4Ab) | [`0x9c84…e1f3`](https://creditcoin-testnet.blockscout.com/tx/0x9c849771e74b7eb1026c383a1d4951839b0e30ea0d0e8aa140455d4391f7e1f3) |
| `RetryCreditRecoveryCampaign` | [`0x646c…dF66`](https://creditcoin-testnet.blockscout.com/address/0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66) | [`0x934d…5f69`](https://creditcoin-testnet.blockscout.com/tx/0x934dff1f13375f65ade309171bdb29182bd20db8c3e61567c909a7e2d87f5f69) |
| `RetryCreditRecoveryCampaignV2` | [`0x3Eee…82B8`](https://creditcoin-testnet.blockscout.com/address/0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8) | [`0xef81…149b`](https://creditcoin-testnet.blockscout.com/tx/0xef8136a0424254ba502f3499f6324e8a02c12bc7ac341d64c00c9a505085149b) |

The verifier calls Creditcoin's native Attestcoin query verifier at `0x0000000000000000000000000000000000000FD2`. The campaign reads Ethereum's registered chain-key-`3`, chain-ID-`1`, EVM-encoding identity through native ChainInfo at `0x0000000000000000000000000000000000000FD3`.

## Campaign #1 and public E2 execution chain

Campaign `#1` was created in [`0x8f81…eca2`](https://creditcoin-testnet.blockscout.com/tx/0x8f819ae535d4801513d1a701c7cd8432b9dfc89ab499cc6f1a24ff51b3f1eca2) with these immutable terms:

- Exactly `0.3 tCTC` funded as three `0.1 tCTC` releases.
- OpenSea fee recipient `0x0000a26b00c1F0DF003000390027140000fAa719`.
- Ethereum source blocks `25805168` through `25835360`.
- Maximum five-block gap and maximum quantity two.
- Deadline September 8, 2026 at 23:34 UTC. The finalized V2 continuation below supplies the later judging-window capacity without weakening this immutable campaign.

The first completed lifecycle is:

1. Paid status-zero Ethereum SeaDrop mint: [`0xed17…d3ff`](https://etherscan.io/tx/0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff)
2. Same-wallet status-one completion two blocks later: [`0x8dbb…ec3a`](https://etherscan.io/tx/0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a)
3. Exact Creditcoin release: [`0xc6e8…2a85`](https://creditcoin-testnet.blockscout.com/tx/0xc6e8ff4ec62f6a74de408c185ea0bdec318067c9bc9dab421118c13b1ed22a85)

At CC3 block `5374212`, the source-derived beneficiary balance increased from `0` to `0.1 tCTC`, the campaign balance decreased from `0.3` to `0.2 tCTC`, claim count became `1`, and both query IDs plus the pair ID were consumed inside campaign `#1`. Static replay returns `AlreadyClaimed`. The historical source address is unrelated to the sponsor, but the release was founder-relayed; no wallet-owner use or consent is claimed.

## Finalized V2 continuation

Transaction [`0xef81…149b`](https://creditcoin-testnet.blockscout.com/tx/0xef8136a0424254ba502f3499f6324e8a02c12bc7ac341d64c00c9a505085149b) created `RetryCreditRecoveryCampaignV2` at [`0x3Eee…82B8`](https://creditcoin-testnet.blockscout.com/address/0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8) in CC3 block `5381782` with nonce `55` and exactly `1 tCTC`.

The initial V2 campaign has these immutable terms:

- Ten fixed `0.1 tCTC` credits, funded exactly with `1 tCTC`.
- The same verifier, paid SeaDrop predicate, fee recipient, five-block gap, and maximum quantity two as V1 campaign `#1`.
- An expanded Ethereum source window from block `15527904` through `25836490` (V1 is bound to blocks `25805168` through `25835360`).
- Deadline September 23, 2026 at 23:59 UTC, covering the submission and judging schedule.
- An immutable predecessor binding to V1 pool `0x646c…dF66`, campaign `#1`, its sponsor, terms, source window, and deadline.
- Releases remain locked until the predecessor reaches its exact deadline or all three V1 claims are consumed.
- Sponsor-wide replay prevents a wallet, Attestcoin query, or exact failure/success pair used in the sponsor's V1 or V2 lineage from receiving another V2 credit.

Both the primary CC3 RPC and the independent Blockscout audit RPC agree on the type-2 creation transaction, successful receipt, canonical block hash, two deployment events, contract nonce `1`, and the exact `9,139`-byte runtime hash `0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07`. The guarded Render supervisor reports `FINALIZED_PLUS_TWO_VERIFIED` while the public profile remains V1.

The production config intentionally continues to report `contractVersion: "v1"` and pool `0x646c…dF66` while the predecessor is active. Do not present the V2 deployment as a public V2 completion, independent use, adoption, or demand evidence.

## What is enforced

Before the fixed credit can be released, both recovery versions require one native Attestcoin batch for exactly two ordered Ethereum receipts. Both must be canonical type-2 paid SeaDrop `mintSigned` calls from the same wallet with consecutive nonces and identical stable mint semantics. The first must be status zero with no logs. The second must contain one exact `SeaDropMint` plus quantity-matched ERC-721 mints to the same wallet. The contract derives the beneficiary from that source wallet, never from relayer input. V1 consumes wallet, query, and pair replay inside the funded campaign; V2 additionally enforces the sponsor lineage and its immutable predecessor boundary.

The public service re-reads Ethereum, authenticates the deployed bindings, builds the pair-local proof, calculates native transaction indexes, and simulates the release, but those checks are fail-fast conveniences. Native verification, the predicate, and campaign state remain payout authority.

## Archived Sepolia/Uniswap V3 predecessor

The previous public testnet release was deployed on August 22, 2026. “V3” is the marker exposed by `RetryCreditUniversalRouterPoolV2.PUBLIC_PILOT_VERSION`; the deployed Solidity classes retain their `V2` names.

- Source network: Ethereum Sepolia (`11155111`), Attestcoin `chainKey 1`
- Pool: [`0x81b5…8A1`](https://creditcoin-testnet.blockscout.com/address/0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1)
- Public failure: [`0x9cb8…ee07`](https://sepolia.etherscan.io/tx/0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07)
- Public settlement: [`0x81e9…f9b0`](https://sepolia.etherscan.io/tx/0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0)
- Public release: [`0xb787…7cdf`](https://creditcoin-testnet.blockscout.com/tx/0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf)

Older RuleDrop addresses, campaigns, and Ethereum-mainnet `chainKey 3` receipts are archived proof-engine predecessor evidence, not the active RetryCredit product. See [the archived RuleDrop mainnet proof note](./MAINNET_PROOF_GATE_2026-08-13.md) for that historical context.
