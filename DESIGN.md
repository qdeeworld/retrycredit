---
version: alpha
name: RetryCredit Recovery Cockpit
description: A warm, ruled recovery cockpit that leads with one active decision and compresses the full sponsored route into a legible operational spine.
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
    height: "84px"
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
  application-rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.sheet}"
    typography: "{typography.interface}"
    rounded: "0px"
    width: "140px"
  route-signal-current:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.sheet}"
    typography: "{typography.technical}"
    rounded: "0px"
    size: "44px"
  route-signal-blocked:
    backgroundColor: "{colors.red}"
    typography: "{typography.technical}"
    rounded: "0px"
    size: "38px"
  route-signal-cleared:
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
  ledger-row-hover:
    backgroundColor: "{colors.sheet-2}"
    textColor: "{colors.ink}"
    typography: "{typography.interface}"
omitted:
  - section: rounded
    reason: "The implementation uses square geometry directly rather than a named radius scale."
  - section: spacing
    reason: "The implementation has responsive measurements but no governing named spacing scale."
---

# Design System: RetryCredit Recovery Cockpit

## Overview

**Creative North Star: "The Recovery Cockpit"**

RetryCredit is an Operate product for clearing one blocked DeFi route, not a promotional landing page. Its visual world is a warm signal sheet held together by black rules, technical registers, and authored route geometry. The interface should feel like a recovery cockpit: the next user decision is unmistakable, the active position has visual authority, and the complete route remains legible as compact operational context.

The application remains one coherent instrument across Recovery, Activity, and Protocol. The live run is the primary work surface, the ledger preserves the relationship among the included failure, exact settlement, and one-time release, and the manual explains the protocol boundary without becoming a judge-facing proof page.

**Key Characteristics:**

- Warm, flat signal-sheet surfaces bounded by near-black rules.
- Persistent application chrome and compact technical status fields.
- One dominant active position backed by a compact five-stage interlocking spine.
- Square controls and state blocks, with color reinforced by labels and position.
- User action first; transaction receipts remain contextual confirmation.

## Colors

The palette uses warm paper neutrals for the working field, ink and rules for structure, route blue for the active path, blocked red for the included stale attempt, cleared green for settlement and release, and amber for waiting or constrained service states.

**The Signal Is Semantic Rule.** Blue marks the active route, red marks the included blocked route, green marks cleared settlement or release, and amber marks waiting or service conditions. Never use these hues as interchangeable decoration.

**The Redundant State Rule.** Every color-coded state also carries a label, stage position, icon, line treatment, or explicit status text.

## Typography

Familjen Grotesk carries navigation, instructions, action labels, and compact page titles. IBM Plex Mono carries route identifiers, amounts, timestamps, network facts, stage numbers, state stamps, and service registers.

Hierarchy comes from weight, scale, alignment, and ruled grouping. Page titles are compact and operational; the current recovery decision is the strongest interface-scale statement; technical labels are terse, often uppercase, and deliberately smaller than the values they classify.

**The Instrument Type Rule.** Keep task language in the interface face and machine-verifiable facts in the monospaced face. Do not introduce an editorial display serif, oversized marketing headline, or decorative italic into the application shell.

## Layout

On wide screens, a persistent navigation rail and sticky status strip frame the work area. Recovery uses a dominant action-and-state cockpit paired with a compact five-stage progress spine and a secondary route register; Activity uses a ruled event ledger; Protocol uses a reading column paired with a limits register. These are three first-class routes with shared chrome, not anchor-linked sections on one landing page.

At the intermediate layout, the cockpit becomes one column without introducing horizontal scrolling. On narrow screens, navigation moves to fixed bottom chrome, the current decision and primary action remain together, and the route compresses into a short vertical progress list instead of five expanded diagrams. Long identifiers wrap safely, controls remain operable at high zoom, and primary interactive targets meet the product's minimum touch size.

**The First-Viewport Clearance Rule.** The current state, service condition, wallet control, and next recovery action must remain visible before supporting route detail on narrow screens.

## Elevation & Depth

This is a flat system with no box-shadow vocabulary. Hierarchy comes from sheet changes, dark fills, rule weight, registration-like borders, and state blocks. A pressed control may move by one physical step, but no surface should float above the route sheet.

**The Ruled Surface Rule.** Use borders, aligned fields, and tonal sheet changes to establish depth. Do not add shadows, glass, ambient glow, or a floating console.

## Shapes

The form language is rectilinear: square signal blocks, hard-edged buttons, ruled rows, straight route lines, short angled branches, a dashed blocked bypass, and terminal blocks at the ends of the five-position route. The distinct switch, branch, bypass, and terminal silhouettes are functional state anatomy, not interchangeable decoration.

Large containers remain square. Compact network or availability markers may use a constrained badge silhouette only when it materially improves scanning; decorative pills and rounded card shells do not belong in this world.

## Components

### Application chrome

Keep the RetryCredit identity, three first-class routes, current network path, service state, and wallet control persistent. The active route uses position, type, and a rail marker in addition to blue. Desktop uses the side rail; mobile uses fixed bottom navigation while preserving the same information architecture.

### Interlocking route board

Show five truthful positions in this order: Authorize, Funded, Stale included, Retry settled, Credit released. The spine gives every position a numbered square signal, explicit state label, and connected route segment. Only the active position expands into detailed state and result fields; the remaining positions stay compact. Preserve the branch, bypass, and terminal geometry in the shared route motif rather than repeating a large diagram inside every stage. Current, queued, included, and cleared states must not depend on animation.

### Clearance strip and actions

Keep wallet connection independent from the recovery action. Pair the current recovery explanation, service condition, and primary amber action inside one dominant ruled cockpit so the user never has to reconstruct the decision from separated panels. The control keeps explicit hover, pressed, busy, and disabled states. Name the operation in button and loading copy; explain paused service, temporary unavailability, wrong-wallet state, and recoverable errors beside the affected action. Preserve saved state and prevent duplicate submission while work is in flight.

### Service and status registers

Use compact ruled fields with monospaced labels for network, service availability, wallet, deposit, and release facts. Signal squares accompany availability text. Queued and muted states retain explicit accessible foreground colors rather than relying on opacity.

### Route ledger

Lead each row with its plain-language result, chain, state, and time relationship. Use a colored square plus text for event state, keep the full technical identifier available in a secondary monospaced field, and provide an external explorer action. Separate the saved browser run from the completed public lifecycle.

### Protocol manual

Use the reading column to explain the ordered receipts and the one-time release, and the dark-headed limits register to state the current network, asset, route, visitor-funding, and credit boundaries. The verification sequence reuses the ruled, square route language without competing with the main recovery board.

### Notices

Notices are compact ink panels with a white rule, semantic icon color, explicit status or alert semantics, and a square dismissal target. They report outcomes and errors without obscuring the clearance action.

## Do's and Don'ts

### Do

- **Do** open directly on the live recovery task.
- **Do** preserve Recovery, Activity, and Protocol as separate navigable routes with shared application chrome.
- **Do** preserve the five-stage order while compressing non-active stages into a connected progress spine.
- **Do** keep the active state, service condition, and next action in one visual group.
- **Do** keep queued-state text at full opacity with explicit accessible colors.
- **Do** keep loading, empty, error, wrong-wallet, saved-session, settled, and released states useful.
- **Do** provide keyboard navigation, visible focus, reduced-motion support, semantic live status, safe identifier wrapping, high-zoom operation, and minimum touch targets.

### Don't

- **Don't** reproduce an oversized landing-page hero or floating dark action card.
- **Don't** give all five route stages equal visual weight or repeat full diagrams vertically on mobile.
- **Don't** flatten the multi-route application into anchor-linked sections.
- **Don't** introduce generic metric cards, rounded card stacks, ambient gradients, glass, neon glow, or ornamental crypto imagery.
- **Don't** create judge navigation, a proof page, an invoice product, or a business-validation surface.
- **Don't** make receipts more prominent than the user's next action or imply insurance, mainnet readiness, exact gas reimbursement, user deposits, or token approval requirements.
