# Investor App UI Style Guide

Investor App should feel restrained, technical, and investor-professional. It is an operational trust interface, not a marketing landing page.

## Layout

- Build the actual workflow screen as the first screen.
- Keep public pages concise and content-led.
- Use one clear `h1`, short supporting copy, and visible calls to real actions.
- Use stable grid, form, table, and button dimensions so content does not shift unexpectedly.
- Avoid nested cards. Use cards only for repeated items, modals, or framed tools.

## Visual Direction

- Prefer neutral light backgrounds, clear borders, and restrained shadows.
- Use a small palette with enough contrast and more than one hue family.
- Keep corner radii at 6-8px unless a component needs a conventional pill.
- Do not use broad purple gradients, decorative blobs, stock filler, or generic hero art.
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
