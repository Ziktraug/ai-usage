# @ai-usage/design-system

## Owns

Reusable Svelte/Panda primitives, report-specific style slots, the Panda preset export, generated Panda build metadata exports, and shared UI styling contracts.

## Does Not Own

It does not own app routes, report data, local collection, sync or file-transfer behavior, persistence, or domain calculations.

## Public Interface

The package exposes declared exports for `.`, `./svelte`, `./preset`, `./report`, `./css`, `./panda.buildinfo.json`, and `./styles.css`.

## Depends On

Consumers provide `svelte`. The package may use Panda tooling for build/check generation and Ark UI for tested Svelte primitives exported through `./svelte`.

## Must Not Import

It must not import app packages, data/runtime packages, local collectors, sync or merge orchestration modules, private package paths, or relative workspace paths.

## Data Boundary

The package exports presentation components, styling helpers, and class
contracts. It receives display-ready props and must not fetch, derive, persist, or mutate report data.

## Test Strategy

Use TypeScript checks and focused component/helper tests where behavior exists. Panda generated output is validated through package build/check scripts.
