# Investor App UI Style Guide

Investor App should feel credible, candid, and investor-professional. The signed-out campaign route is a focused pre-registration landing page; authenticated participant and owner routes are operational trust interfaces.

## Layout

- Make the active campaign, its participation paths, and its current state the first signed-out signals.
- Keep public pages concise and decision-led. Authenticated pages prioritize repeated tasks, tables, forms, and state.
- Use one clear `h1`, short supporting copy, and visible calls to real actions.
- Use stable grid, form, table, and button dimensions so content does not shift unexpectedly.
- Avoid nested cards. Use cards only for repeated items, modals, or framed tools.

## Audience Copy

- Address the current actor and the decision or task in front of them.
- Put campaign benefits, process, risks, and calls to action in the public route.
- Put participant records and available transitions in signed-in routes, and owner operations in owner-only routes.
- Never show agent prompts, development summaries, repository structure, implementation plans, technology choices, or upcoming feature lists inside the product UI.
- Do not describe Investor App as a configurable application to campaign visitors. Configuration language belongs only in owner controls and developer documentation.

## Visual Direction

- Prefer neutral light backgrounds, clear borders, and restrained shadows.
- Use a small palette with enough contrast and more than one hue family.
- Keep corner radii at 6-8px unless a component needs a conventional pill.
- Do not use broad purple gradients, decorative blobs, stock filler, or unrelated hero art. Public campaign imagery must represent the actual product or campaign.
- Do not load third-party runtime fonts, tracking scripts, analytics SDKs, or external client assets.

## Typography and Accessibility

- Use system fonts until a checked-in font is deliberately added.
- Keep letter spacing at `0`.
- Do not scale normal text directly with viewport width.
- Label every input.
- Provide visible focus states.
- Keep text inside buttons and compact panels small enough to fit on mobile.
- Use semantic lists, headings, forms, and tables.

## Forms and Private Data

- Server validation is authoritative.
- Hidden browser controls are not security controls.
- Errors should be clear, local to the task, and non-disclosing.
- CSRF fields and internal IDs must not render as visible data.
- CSV and export UIs must warn that downloaded material is sensitive.

## HTML/API Equivalence

Where a route has both browser and machine representations, they must use the same domain services, authorization, validation, and failure semantics. A browser button should not expose an operation that the server would not advertise to the same caller in a machine representation.
