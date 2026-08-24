---
version: alpha
name: RetryCredit Route Ledger
description: The user-first interface system for completing a sponsored RetryCredit recovery on testnet.
omitted:
  - colors
  - typography
  - rounded
  - spacing
  - components
---

# Overview

RetryCredit is a self-service recovery product, not an analytics dashboard. The interface should make one promise immediately clear: after a stale sponsored swap attempt fails, RetryCredit can refresh the route, settle the intended swap, and release a fixed credit. The visual language is calm, exact, and operational. It should feel like a dependable transaction instrument rather than a promotional crypto landing page.

The primary user journey is the governing design evidence: connect the intended wallet, start recovery, sign the challenge, prepare the route, and finish the swap. Product limits and testnet status stay visible near the action. Receipts and technical proof appear after the useful result or as secondary context; they never replace the primary user action or create a judge-facing mode.

The signature composition is the recovery route: an ordered path connecting the included failure, refreshed settlement, and fixed credit. It is functional orientation, not decoration, and must remain understandable without motion or color.

# Colors

The implementation should use a light mineral canvas, ink-like primary text, a single confident blue for actions and focus, coral only for the stale route or destructive failure, and teal only for successful settlement. Color must reinforce state, never carry state alone, and all text and controls must retain accessible contrast.

Ambient neon, multicolor gradients, glassmorphism, and decorative glow are outside this system. They blur the distinction between the stale attempt, the refreshed route, and the released credit.

# Themes

The public product has one deliberately authored light theme. Dark surfaces may be used sparingly for a transaction console or code-like receipt, but they are components within the light system rather than a second theme.

# Typography

Display text should be compact, assured, and easy to scan. Body text should be neutral and highly legible; transaction identifiers, amounts, and network details use a dedicated monospaced face. Headings use sentence case. Labels are short and literal, and the primary action label must match the current recovery phase.

# Layout

The first desktop and mobile viewport must contain the product outcome, current availability, wallet state, and primary recovery action. The recovery route sits beside or immediately below the action instead of becoming a distant explanatory section. Supporting proof, safeguards, and activity follow in descending order of user relevance.

Use asymmetric editorial balance on wide screens and a single deliberate column on narrow screens. Content should remain readable at 200% zoom, long addresses and hashes must wrap safely, and no primary control may be pushed off-screen by decorative content. Touch targets are at least 44 by 44 pixels.

# Elevation & Depth

Hierarchy comes from contrast, borders, spacing, and limited surface shifts. The primary recovery console may carry the strongest depth. Supporting cards remain quieter so the page does not read as an undifferentiated grid of floating panels.

# Shapes

Corners are restrained and structural. Larger surfaces may use a moderate radius; controls and small status marks use tighter radii. Avoid excessive pills. A pill is reserved for compact state, network, or availability information whose shape helps distinguish it from prose.

# Components

## Recovery route

Show the three true stages in order: included failure, refreshed settlement, and fixed credit. Each stage combines an icon or index, a plain-language label, and concise state text. The active stage has a second cue beyond color. On mobile, the route becomes vertical without changing its order.

## Recovery console

Keep wallet connection independent from the recovery action. Explain why an action is unavailable, preserve entered or derived state during recoverable errors, prevent duplicate submission while work is in flight, and offer a specific next step after network or API failure. Loading copy should name the operation rather than display a generic spinner.

## Activity receipt

Receipts appear only when they help the user confirm an outcome. Put the human-readable result first and technical identifiers second. Hashes and addresses wrap or truncate accessibly, with the complete value available to assistive technology and copying behavior.

## Status and limits

Testnet status, sponsor availability, and product limits are visible and written as product truth. RetryCredit must not imply insurance, mainnet readiness, exact gas reimbursement, user deposits, or token approval requirements that the release does not support.

# Do’s and Don’ts

Do lead with “The retry pays for the failure” and the action that completes the recovery. Do keep error, empty, loading, wrong-wallet, and completed states useful. Do maintain keyboard navigation, visible focus, reduced-motion support, and semantic live status. Do let the visual route teach the product moment in seconds.

Don’t create judge navigation, a proof page, an invoice product, or a business-validation requirement. Don’t make receipts the hero. Don’t hide a disabled action without an explanation. Don’t use ornamental crypto imagery, generic metric-card dashboards, or motion that suggests progress the system has not made.
