# @ai-usage/design-system

## Owns

Reusable Svelte/Panda primitives, report-specific style slots, the Panda preset export, the generated `panda lib` design-system manifest, and shared UI styling contracts.

## Does Not Own

It does not own app routes, report data, local collection, sync or file-transfer behavior, persistence, or domain calculations.

## Public Interface

The package exposes declared exports for `.`, `./svelte`, `./preset`, `./report`, `./css`, and `./styles.css`. Its build runs `panda lib`, which writes the design-system manifest under `styled-system/panda/` (exported as `./panda/*`, loaded by `apps/web` through Panda's `designSystem` option) and keeps the generated Panda subpaths in `package.json` exports in sync (`./css/*`, `./patterns`, `./patterns/*`, `./tokens`, `./helpers`, `./types`).

Two package scripts prepare a Panda consumer's generated output and are run by `apps/web` through `bun --filter`: `remove-panda-1-output <library|consumer> <styled-system directory>` deletes the Panda 1 output Panda 2 never writes (the design-system build runs it on its own `styled-system/`), and `scope-breakpoints-to-screen <raw stylesheet> <stylesheet>` scopes the breakpoint media queries of a raw `panda cssgen` output to `screen`, as Panda 1 wrote them, so printed pages keep the base layout. It replaces the stylesheet only when the result changed, and always removes the raw file.

A style an app overrides also exports its raw style object as `…Style` (for example `ghostButtonStyle` beside `ghostButton`). Apps merge overrides with `css(ghostButtonStyle, override)`: `cx()` only joins class names, and when two atoms set the same property under the same condition the stylesheet order decides, which Panda 2 sorts by value rather than by authoring order.

## Depends On

Consumers provide `svelte`. The package may use Panda tooling for build/check generation and Ark UI for tested Svelte primitives exported through `./svelte`.

## Must Not Import

It must not import app packages, data/runtime packages, local collectors, sync or merge orchestration modules, private package paths, or relative workspace paths.

## Data Boundary

The package exports presentation components, styling helpers, and class
contracts. It receives display-ready props and must not fetch, derive, persist, or mutate report data.

## Test Strategy

Use TypeScript checks and focused component/helper tests where behavior exists. Panda generated output is validated through package build/check scripts.
