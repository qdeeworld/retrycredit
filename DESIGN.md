---
version: alpha-v3-spike
name: RetryCredit Recovery Dispatch
description: A warm, ruled Recovery Center that makes an authenticated service-credit promise legible, leads with a source-wallet history check, and discovers an exact failed-and-completed transaction pair without turning proof into the product.
colors:
  sheet: "#f4f0e4"
  sheet-2: "#ebe6d8"
  ink: "#15170f"
  muted: "#5e6057"
  rule: "#97988e"
  rule-soft: "#c8c4b7"
  rail: "#111512"
  primary: "#1458d4"
  red: "#d64521"
  green: "#087642"
  amber: "#d99b16"
  focus: "#165fe5"
typography:
  interface:
    fontFamily: "Familjen Grotesk, sans-serif"
  technical:
    fontFamily: "IBM Plex Mono, monospace"
components:
  primary-action:
    backgroundColor: "#f6c84f"
    textColor: "{colors.ink}"
    typography: "{typography.interface}"
    rounded: "0px"
    padding: "15px 18px"
    height: "76px"
  primary-action-hover:
    backgroundColor: "#ffd869"
  wallet-button:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.interface}"
    rounded: "0px"
    height: "44px"
  wallet-button-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
  service-state:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.technical}"
    rounded: "0px"
    height: "32px"
  incident-status-current:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.sheet}"
    typography: "{typography.technical}"
    rounded: "0px"
    size: "44px"
  incident-status-failed:
    backgroundColor: "{colors.red}"
    typography: "{typography.technical}"
    rounded: "0px"
    size: "38px"
  incident-status-completed:
    backgroundColor: "{colors.green}"
    textColor: "{colors.sheet}"
    typography: "{typography.technical}"
    rounded: "0px"
    size: "38px"
  service-state-waiting:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.ink}"
    typography: "{typography.technical}"
    rounded: "0px"
    size: "8px"
  case-row-hover:
    backgroundColor: "{colors.sheet-2}"
    textColor: "{colors.ink}"
    typography: "{typography.interface}"
  campaign-file:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.interface}"
  eligibility-desk:
    backgroundColor: "{colors.sheet-2}"
    textColor: "{colors.ink}"
    typography: "{typography.interface}"
  technical-note:
    textColor: "{colors.muted}"
    typography: "{typography.technical}"
  application-header:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.sheet}"
    typography: "{typography.interface}"
  strong-rule:
    backgroundColor: "{colors.rule}"
    height: "1px"
  soft-rule:
    backgroundColor: "{colors.rule-soft}"
    height: "1px"
  focus-ring:
    backgroundColor: "{colors.focus}"
    size: "3px"
omitted:
  - section: rounded
    reason: "The implementation uses square geometry directly rather than a named radius scale."
  - section: spacing
    reason: "The implementation has responsive measurements but no governing named spacing scale."
---

# Design System: RetryCredit Recovery Dispatch

## Overview

**Creative North Star: “The Recovery Dispatch”**

RetryCredit is an operational Recovery Center for one result: let a visitor understand the app-funded service-credit promise, connect the source wallet, discover an exact paid failure and completed retry from public history, then let that same wallet authorize a fixed Creditcoin release. Manual pair entry remains an advanced fallback for truncated or unavailable history. When a lineage-aware campaign is configured, the same desk also explains whether its predecessor still controls release timing and whether the wallet or pair was already recovered in sponsor-bound history. It is not a promotional landing page, a proof explorer, a provider CRM, or a generic claims dashboard.

The existing warm signal-sheet world remains the product identity. Recovery is the live pair-intake, eligibility, and release surface; Cases records actual campaign outcomes and curated examples; Protocol explains the paired-receipt boundary. These remain separate routes with shared chrome.

The mainnet incident is the protagonist. Attestcoin proof and Creditcoin receipts appear exactly where they explain eligibility or confirm the result; they never become a separate evaluator surface.

## Colors

Warm paper neutrals carry the working field, ink and rules establish structure, blue marks the current user decision, red marks the included failed attempt, green marks the completed action or released credit, and amber marks waiting or constrained service states.

Every semantic color must be reinforced by a label, position, icon, rule treatment, or explicit status. Do not use status hues as interchangeable decoration.

## Typography

Familjen Grotesk carries navigation, campaign language, decisions, and actions. IBM Plex Mono carries addresses, transaction hashes, block and nonce relationships, amounts, network facts, campaign capacity, and service states.

The campaign statement may be large but remains operational and left aligned. Use the interface face for what the wallet can do and the monospaced face for what the chain establishes. Do not introduce an editorial display serif, oversized marketing slogan, or decorative italic.

## Layout

Use top application chrome rather than a dashboard sidebar. On wide screens, the Recovery route opens as an offset incident file: campaign scope and plain-language result occupy the larger field; the pair-intake and eligibility desk occupies a narrower ruled field aligned to the action. Its two source-transaction fields read as one ordered instrument rather than a generic form. A full-width evidence band below them shows the submitted failed attempt, the completed mint, and the fixed release as one paired sequence.

Cases uses a ruled chronological register with one expanded recovery record, not metric cards. Protocol uses a reading column and a compact limits sheet. Supporting explanation may continue below the primary instrument, but the routes must not collapse into anchor-linked sections on one page.

On narrow screens, keep source-wallet discovery, source-pair fields, and the check action first so the normal user action remains in the first viewport. Give that desk compact funded-campaign context, then place the full campaign statement and terms before paired evidence. Long identifiers wrap safely, high zoom preserves reading order, and controls remain at least 44px tall.

## Elevation & Depth

This is a flat system with no box-shadow vocabulary. Hierarchy comes from paper-tone changes, dark fills, rule weight, registration marks, clipped bands, and controlled overlap between the campaign file and eligibility desk.

Do not add glass, ambient glow, floating cards, or shadowed crypto panels. Pressed controls may move by one physical step.

## Shapes

The form language is rectilinear: ruled files, square status marks, hard-edged buttons, ledger rows, block-height ticks, and a paired transaction line that visibly terminates at one release. A small stamped state may rotate slightly when it communicates issued, eligible, or released status.

Large containers remain square. Compact availability markers may use a constrained badge silhouette only when it improves scanning. Decorative pills and rounded card shells do not belong in this world.

## Components

### Application chrome

Keep RetryCredit, Recovery, Cases, Protocol, the Ethereum Mainnet to Creditcoin Testnet path, service state, and wallet control persistent. The active route needs a rule or positional marker in addition to color. Mobile navigation stays reachable without covering the primary action.

Client-side route changes update the document title and move programmatic focus to the new route heading. The main region remains focusable for the skip link, but it is not the route announcement target.

### Live campaign file

Lead with the bounded campaign in plain language: who can recover, which source window is recognized, the fixed credit, remaining capacity, and the claim deadline. State clearly when RetryCredit funds the pilot itself. Do not imply SeaDrop, OpenSea, or an NFT collection sponsors or endorses the campaign.

For a lineage-aware continuation, distinguish funding from availability. A fully funded campaign may still be waiting for its immutable predecessor to close or fill. Lead that state with the outcome—no release can be authorized yet—then show the exact predecessor pool, campaign, deadline, terms, and source-window binding inside progressive disclosure. Never collapse this state into a generic closed campaign or suggest that the funds are missing.

Lineage language follows the contract's actual scope. Sponsor-bound history may say that a recovery remains used across campaigns funded by that sponsor and that an unrelated pool cannot poison the record. Campaign-scoped deployments must not inherit that copy.

Refresh campaign configuration silently while a visible tab remains open and when connectivity or visibility returns. Re-evaluate the deadline locally between server responses. A stale open/capacity snapshot must never keep authorization enabled; read-only pair inspection remains available after closure or fullness.

### Recovery Promise

The campaign file may project authenticated live terms as a Recovery Promise: sponsor, source action, fixed service credit, capacity, source window, deadline, predicate version, and settlement campaign. Present the useful promise first and put contract identifiers in progressive disclosure.

Only call an action Recovery-backed when its campaign was funded before the action and the displayed terms authenticate against live deployed state. The current retrospective SeaDrop pilot must explicitly say that it demonstrates the recovery mechanism but was not a promise shown before the historical mints. The archived Universal Router adapter may demonstrate a second semantic family, but its founder-generated testnet attempts must never appear as user demand.

The promise is not eligibility authority. Wallet discovery, live source reads, the native verifier, immutable predicate, and campaign replay state remain authoritative. Never use insurance, cover, warranty, exact-refund, loss, or guaranteed-success language.

### Adapter disclosure

Keep the active SeaDrop campaign as the primary user journey. Protocol may show a compact two-row adapter register to establish repeatability: organic Ethereum-mainnet paid mint and archived Sepolia Universal Router lab. Each row must disclose source network, action family, evidence tier, and current availability. Do not turn adapter count into feature cards or imply multichain support beyond authenticated Attestcoin source chains.

### Wallet discovery, pair intake, and eligibility desk

The desk's first action connects an Ethereum wallet only to identify the address and search a bounded slice of its public transaction history. Discovery is advisory, declares when history is truncated, and never authorizes a release. Every discovered pair is re-read from independent Ethereum RPCs and checked through the same semantic predicate path used by manual intake. Exact failed and completed hashes remain available as an advanced fallback when discovery is empty, truncated, or unavailable. A clearly secondary example action may load the published public pair, but curated cases never determine eligibility and the action must not imply a live verification or release that has not been confirmed.

Discovery may connect a wallet before a verdict, but connection supplies only the address to search; it supplies neither eligibility nor a payout destination. Owner recovery asks the live-derived source wallet to authorize the exact origin, pool, campaign, pair, and expiry before the application requests proof work. Keep this owner flow distinct from the explicitly selected community-helper flow. The browser and API never accept a payout destination or a caller-supplied source wallet as authority. Application authorization gates the hosted relayer; do not imply the permissionless campaign contract enforces owner consent onchain.

When the live service explicitly enables community help, offer it within Recovery rather than adding a separate evaluator surface. Lead with finding a recovery to help with; a bounded public candidate search must independently check the selected pair before presenting it. Keep exact-pair entry as a fallback. The helper connects their own wallet and signs an explicitly helper-specific request. Before signing and in the outcome, identify the source wallet as the sole recipient, explain that the helper receives no credit, and state that this does not establish recipient consent. Neither finding nor connecting authorizes proof work or a release.

Keep the active role visible during eligibility, authorization and progress. An owner signature is never relabeled as helper permission. Bind helper progress and reload recovery to the durable public operation identifier, role, requester, source wallet and exact pair. A new pair link, account change or mode switch must not replace an already submitted operation. Public status checks may reconcile an uncertain result but never initiate another signature or broadcast. Announce unavailable discovery, exhausted search windows, spent budget and uncertain settlement separately; never advertise that every public candidate is payable.

The desk owns empty, editing, malformed, checking, semantic mismatch, qualifying, continuation waiting, wrong-wallet, wallet connecting, authorization requested, proof queued, proof building, release relaying, release processing, release uncertain, released, already claimed in the current campaign, already claimed in predecessor or sponsor history, campaign closed, campaign full, pair changed, account changed, service unavailable, rate-limited, and retryable-error states. Preserve the submitted pair across recoverable failures, invalidate every derived result when either hash changes, prevent duplicate submission, and describe the current operation in busy copy. After any uncertain post-sign result, lock the pair and check its public processing/claim state before offering another authorization.

After a signature has been submitted, a same-tab reload may restore only the exact public pool, campaign, wallet, pair, operation status, timestamps, and resulting transaction identifier. Keep that record in session storage with a short expiry, bind it to the current campaign and exact pair, and reconcile it through a fresh public eligibility check before showing a terminal result. Never persist a signature, challenge message, proof, raw transaction, destination, private key, or authorization payload. A restored state never triggers signing or broadcast by itself.

A non-qualifying result is a complete product state, not a dead end. Explain that the exact funded rule did not match without inventing a more specific private rule failure or human-readable revert reason, and offer the public recovered example without pretending the visitor qualified.

### Paired evidence band

Show the submitted failed mint and later completed mint as one semantic pair only after live analysis succeeds. Lead each side with the human result, then show block, nonce, value, NFT outcome, and explorer link. The visual connector must make order and derived shared wallet clear without requiring animation. Credit release sits at the terminus, visually distinct from the two Ethereum receipts. Never borrow the featured case when the active pair has no result.

### Recovery outcome

The released state leads with the beneficiary and fixed Creditcoin amount. Pair it with one replay-safe receipt and the exact submitted source pair. A relayer may submit the proof, but the interface must make clear that the contract derives the only payout address from the source wallet.

### Cases register

Use real verified recoveries and clearly labeled eligible observations. Distinguish founder-operated release, unrelated source facts, and unrelated user completion. Never turn an observed address into a customer, human, or adopter claim.

A published featured pair is not labeled verified until its live intake check succeeds. While that check is pending or unavailable, show that exact verification state and keep the published identifiers visibly distinct from a live verdict.

### Protocol manual

Explain the dedicated SeaDrop `mintSigned` predicate, exact stable-field match, ordered status transition, mint outcome, source-derived payout, fixed campaign capacity, and the replay boundary of the configured contract version. For a lineage-aware campaign, explain predecessor binding and sponsor-scoped replay protection without implying that an unrelated sponsor or pool can consume the record. State that Attestcoin does not prove the human-readable revert reason or market demand.

### Notices

Labels, helper text, and validation messages stay attached to their transaction fields. Required and invalid states must be announced programmatically, busy analysis uses a live status, and disabled actions explain the unmet requirement. Other notices stay inline with the affected action whenever possible. Use direct language, semantic icon and text, square dismissal targets, and live-region announcements. Do not obscure the intake desk with a modal.

## Do’s and Don’ts

### Do

- **Do** open directly on the live campaign and source-wallet discovery, with exact pair intake as the fallback.
- **Do** preserve Recovery, Cases, and Protocol as separate routes with shared application chrome.
- **Do** keep campaign funding, window, capacity, deadline, and source-derived destination visible.
- **Do** derive wallet, receipt, order, value, collection, and outcome facts from the submitted transactions rather than asking the visitor to supply them.
- **Do** make empty, malformed, non-qualifying, loading, rate-limited, service-error, already-claimed, relaying, released, offline, wrong-wallet, pair-changed, and campaign-closed states useful.
- **Do** distinguish a funded continuation that is waiting on its predecessor from a closed, full, or unfunded campaign.
- **Do** reconcile a safely resumed submitted pair from public state before offering any new authorization.
- **Do** provide keyboard navigation, visible focus, reduced-motion support, semantic live status, safe identifier wrapping, high-zoom operation, and 44px touch targets.
- **Do** keep the previous Uniswap public lifecycle as contextual expansion evidence, not the V2 protagonist.

### Don’t

- **Don’t** reproduce the previous dark cockpit, five equal stages, left application rail, or oversized landing-page hero.
- **Don’t** introduce generic metric cards, rounded card stacks, ambient gradients, glass, neon glow, ornamental crypto imagery, or a grid of equal features.
- **Don’t** flatten the multi-route product into one page.
- **Don’t** create judge navigation, a proof page, an invoice product, or a business-validation surface.
- **Don’t** keep the three observed wallets as eligibility authority; they are examples and public evidence only.
- **Don’t** treat wallet connection or explorer discovery as eligibility authority; manual pair intake must remain available without a wallet connection.
- **Don’t** request Attestcoin proof work before the selected role signs its exact bounded authorization: the derived source wallet in owner mode, or the requester in explicitly enabled helper mode. Helper permission never stands in for recipient consent.
- **Don’t** persist signatures, challenges, proof material, or raw transactions to resume a flow.
- **Don’t** let receipts outrank the wallet’s eligibility or result.
- **Don’t** imply insurance, exact gas reimbursement, platform sponsorship, eight independent users, user adoption, or market validation.
