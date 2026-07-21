# ADR 0006: Use one browser regression stack

## Context

The frontend needs functional, accessibility, visual, console, page-error, and critical-request regression gates without duplicating browser infrastructure.

## Decision

Playwright remains the only browser test runner. A shared fixture fails on uncaught errors and unexpected critical request failures, `@axe-core/playwright` covers accessibility, and four high-value screenshots cover stable application states.

## Consequences

Ordinary, demo, and production suites share failure semantics. Visual coverage stays reviewable and intentionally small.

## Rejected alternative

Storybook, a DOM emulator, and a second visual manifest/platform were rejected because they would duplicate the existing application-level stack.

## Evidence

- [Shared browser gate](../../apps/web/e2e/browser-test.ts)
- [Axe coverage](../../apps/web/e2e/accessibility.spec.ts)
- [Visual coverage](../../apps/web/e2e/visual-regression.spec.ts)
- [Playwright configuration](../../apps/web/playwright.config.ts)
