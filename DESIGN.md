---
version: alpha
name: RetryCredit Recovery Dispatch
description: A warm, ruled incident-recovery desk that leads with wallet eligibility and makes an organic failed-to-completed mainnet action legible without turning proof into the product.
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

RetryCredit is an operational desk for one result: tell a wallet whether a funded recovery campaign recognizes its real onchain failure-to-completion pair, then deliver the fixed credit to that same source address. It is not a promotional landing page, a proof explorer, or a generic claims dashboard.

The existing warm signal-sheet world remains the product identity, while the composition changes from a five-stage cockpit into an asymmetric incident file. Recovery is the live eligibility and release surface, Cases records actual campaign outcomes, and Protocol explains the paired-receipt boundary. These remain separate routes with shared chrome.

The mainnet incident is the protagonist. Attestcoin proof and Creditcoin receipts appear exactly where they explain eligibility or confirm the result; they never become a separate evaluator surface.

## Colors

Warm paper neutrals carry the working field, ink and rules establish structure, blue marks the current user decision, red marks the included failed attempt, green marks the completed action or released credit, and amber marks waiting or constrained service states.

Every semantic color must be reinforced by a label, position, icon, rule treatment, or explicit status. Do not use status hues as interchangeable decoration.

## Typography

Familjen Grotesk carries navigation, campaign language, decisions, and actions. IBM Plex Mono carries addresses, transaction hashes, block and nonce relationships, amounts, network facts, campaign capacity, and service states.

The campaign statement may be large but remains operational and left aligned. Use the interface face for what the wallet can do and the monospaced face for what the chain establishes. Do not introduce an editorial display serif, oversized marketing slogan, or decorative italic.

## Layout

Use top application chrome rather than a dashboard sidebar. On wide screens, the Recovery route opens as an offset incident file: campaign scope and plain-language result occupy the larger field; the wallet eligibility desk occupies a narrower ruled field aligned to the action. A full-width evidence band below them shows the failed attempt, the completed mint, and the fixed release as one paired sequence.

Cases uses a ruled chronological register with one expanded recovery record, not metric cards. Protocol uses a reading column and a compact limits sheet. Supporting explanation may continue below the primary instrument, but the routes must not collapse into anchor-linked sections on one page.

On narrow screens, order the campaign statement, capacity and deadline, wallet result, primary action, then paired evidence. Keep the action and its explanation in the first viewport when practical. Long identifiers wrap safely, high zoom preserves reading order, and controls remain at least 44px tall.

## Elevation & Depth

This is a flat system with no box-shadow vocabulary. Hierarchy comes from paper-tone changes, dark fills, rule weight, registration marks, clipped bands, and controlled overlap between the campaign file and eligibility desk.

Do not add glass, ambient glow, floating cards, or shadowed crypto panels. Pressed controls may move by one physical step.

## Shapes

The form language is rectilinear: ruled files, square status marks, hard-edged buttons, ledger rows, block-height ticks, and a paired transaction line that visibly terminates at one release. A small stamped state may rotate slightly when it communicates issued, eligible, or released status.

Large containers remain square. Compact availability markers may use a constrained badge silhouette only when it improves scanning. Decorative pills and rounded card shells do not belong in this world.

## Components

### Application chrome

Keep RetryCredit, Recovery, Cases, Protocol, the Ethereum Mainnet to Creditcoin Testnet path, service state, and wallet control persistent. The active route needs a rule or positional marker in addition to color. Mobile navigation stays reachable without covering the primary action.

### Live campaign file

Lead with the bounded campaign in plain language: who can recover, which source window is recognized, the fixed credit, remaining capacity, and the claim deadline. State clearly when RetryCredit funds the pilot itself. Do not imply SeaDrop, OpenSea, or an NFT collection sponsors or endorses the campaign.

### Eligibility desk

The desk owns one primary action and all of its states: disconnected, checking, ineligible, eligible, authorization requested, proof building, release relaying, released, already claimed, service unavailable, and retryable error. Preserve the connected address and user input across recoverable failures. Prevent duplicate submission and describe the current operation in busy copy.

An ineligible result is a complete product state, not a dead end. Explain the bounded window and offer the public recovered case as evidence without pretending the visitor qualified.

### Paired evidence band

Show the included failed mint and later completed mint as one semantic pair. Lead each side with the human result, then show block, nonce, value, NFT outcome, and explorer link. The visual connector must make order and shared wallet clear without requiring animation. Credit release sits at the terminus, visually distinct from the two Ethereum receipts.

### Recovery outcome

The released state leads with the beneficiary and fixed Creditcoin amount. Pair it with one replay-safe receipt and the exact source pair. A relayer may submit the proof, but the interface must make clear that the contract derives the only payout address from the source wallet.

### Cases register

Use real verified recoveries and clearly labeled eligible observations. Distinguish founder-operated release, unrelated source facts, and unrelated user completion. Never turn an observed address into a customer, human, or adopter claim.

### Protocol manual

Explain the dedicated SeaDrop `mintSigned` predicate, exact stable-field match, ordered status transition, mint outcome, source-derived payout, fixed campaign capacity, and global replay boundary. State that Attestcoin does not prove the human-readable revert reason or market demand.

### Notices

Notices stay inline with the affected action whenever possible. Use direct language, semantic icon and text, square dismissal targets, and live-region announcements. Do not obscure the eligibility desk with a modal.

## Do’s and Don’ts

### Do

- **Do** open directly on the live campaign and wallet outcome.
- **Do** preserve Recovery, Cases, and Protocol as separate routes with shared application chrome.
- **Do** keep campaign funding, window, capacity, deadline, and source-derived destination visible.
- **Do** make ineligible, loading, service-error, already-claimed, relaying, released, offline, wrong-wallet, and empty states useful.
- **Do** provide keyboard navigation, visible focus, reduced-motion support, semantic live status, safe identifier wrapping, high-zoom operation, and 44px touch targets.
- **Do** keep the previous Uniswap public lifecycle as contextual expansion evidence, not the V2 protagonist.

### Don’t

- **Don’t** reproduce the previous dark cockpit, five equal stages, left application rail, or oversized landing-page hero.
- **Don’t** introduce generic metric cards, rounded card stacks, ambient gradients, glass, neon glow, ornamental crypto imagery, or a grid of equal features.
- **Don’t** flatten the multi-route product into one page.
- **Don’t** create judge navigation, a proof page, an invoice product, or a business-validation surface.
- **Don’t** let receipts outrank the wallet’s eligibility or result.
- **Don’t** imply insurance, exact gas reimbursement, platform sponsorship, eight independent users, user adoption, or market validation.
