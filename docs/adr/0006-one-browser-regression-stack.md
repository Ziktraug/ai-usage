# ADR 0006: Use one browser regression stack

- **Status**: Accepted
- **Date**: 2026-07-22

## Context

The frontend needs functional, accessibility, visual, console, page-error, and critical-request regression gates without duplicating browser infrastructure.

## Decision

Playwright remains the only browser test runner. A shared fixture fails on uncaught errors and unexpected critical request failures, `@axe-core/playwright` covers accessibility, and four high-value screenshots cover stable application states.

## Consequences

Ordinary, demo, and production suites share failure semantics. Visual coverage stays reviewable and intentionally small.

### 2026-10-24 amendment: the design-system component fixtures

`packages/design-system` keeps one accepted exception. Its `test:browser`
script mounts the Svelte controls and overlays fixtures in Chromium through the
`playwright` library and a Vite fixture server
(`src/svelte/controls/controls.browser.ts`, `src/svelte/overlays/overlays.browser.ts`)
and fails on console, page and request errors. It is a component-fixture check
for a library without an application, run on demand; it is not part of
`verify` or CI and shares neither the app fixture nor its reporters. It stays
limited to interaction assertions on design-system primitives: screenshots,
axe runs and anything that needs the application belong in `apps/web/e2e`.

## Rejected alternative

Storybook, a DOM emulator, and a second visual manifest/platform were rejected because they would duplicate the existing application-level stack.

## Evidence

- [Shared browser gate](../../apps/web/e2e/browser-test.ts)
- [Axe coverage](../../apps/web/e2e/accessibility.spec.ts)
- [Visual coverage](../../apps/web/e2e/visual-regression.spec.ts)
- [Playwright configuration](../../apps/web/playwright.config.ts)
