# Frontend case study

## Product problem

AI coding tools record usage in different local files and databases. ai-usage turns those records into one explorable report: an Overview for the shape of activity, a continuously scrolling session inventory, breakdowns by model/provider/harness/project, and a detailed drawer that keeps a session in context.

The frontend is not a hosted analytics service. It is a local application whose useful data is also private data, so the interface and its runtime boundary have to be designed together.

![Synthetic ai-usage Overview with session detail](assets/ai-usage-overview-session-detail.png)

## Constraints

- Normal report data comes from local histories and must not be rendered into server HTML.
- Demo, browser tests, benchmarks, and screenshots must use deterministic synthetic records only.
- Live collection may publish while a user is filtering or reading a session.
- A useful report can contain thousands of sessions, but requests, the DOM, and the client bundle remain bounded.
- Dense visualizations must retain their compact comparative shape while exposing equivalent keyboard, touch, and assistive-technology interactions.

## Architecture

The app is built with Solid, TanStack Router, TanStack Query, Panda CSS, and a workspace design-system package.

The report route uses a client-only Router loader with explicit pending and error states. In live mode, that loader returns a bounded support bootstrap for one immutable report revision. A dashboard lifecycle owner then coordinates destination-focused Overview, Breakdown, and paged Session requests against the exact revision. Ordinary finite reads such as Skills and quota history use TanStack Query instead of sharing the report's consistency machinery. [ADR 0001](adr/0001-client-only-report-route-loading.md) and [ADR 0002](adr/0002-immutable-focused-report-revisions.md) record the boundary.

Dashboard remains the composition root, while three concrete modules own the complicated state transitions: report destination lifecycle, session selection/navigation, and provider status/history. TimeRange keeps DOM measurement and pointer capture in its component, with keyboard/pointer state transitions in a pure reducer. Shared styles are promoted only when they have a stable semantic name and more than one consumer.

The public demo is a separate runtime mode, not a hidden live screen. Its launcher creates an isolated temporary home, binds to `127.0.0.1`, and serves committed fixtures. Server guards reject local reads and mutations before their live runtime is constructed, while the browser source-control client stays inert. [ADR 0003](adr/0003-synthetic-inert-demo.md) describes the decision.

## Accessibility

The report uses semantic tabs, tables, dialogs, headings, labelled form controls, live status regions, visible focus, and a shared navigation pattern. The activity heatmap keeps small GitHub-style cells and roving keyboard focus; an adjacent labelled date input supplies an equivalent touch target. Punchcard keeps its visual plot out of the accessibility tree and exposes the same non-empty cells through a visually hidden semantic table. Reduced-motion rules preserve feedback without long transitions.

Automated axe checks cover the major report and Skills states, including an open session drawer, but automation does not replace keyboard and visual review. The interaction contract is summarized in [ADR 0005](adr/0005-compact-accessible-visualizations.md).

## 5,000-session performance

The session surface uses 100-row exact-revision pages and one cancellation-aware request coordinator. Both desktop rows and mobile cards are windowed behind continuous scrolling; there is no Load more product step. A scale test traverses the actual scroll roots and proves all 5,000 stable opaque IDs appear exactly once on desktop and mobile while enforcing request and DOM bounds.

On the documented local synthetic run, mobile mounted rows fell from 5,000 to 20 and DOM nodes from about 70,000 to 283. Desktop stayed at 32 mounted rows. Heap and interaction timings are recorded as diagnostics rather than portable CI promises because they vary by machine. The complete method and before/after values are in [the session-scroll benchmark](session-scroll-benchmark.md) and the decision is in [ADR 0004](adr/0004-bounded-continuous-session-scrolling.md).

## Regression strategy

Bun tests cover pure domain/state owners and server boundaries. Playwright exercises the real app in ordinary synthetic, privacy-safe demo, and built production modes. One shared fixture fails tests for uncaught page errors, unexpected console errors, failed critical requests, or critical HTTP errors. Axe runs in the same stack, and four deliberate snapshots cover stable, high-value UI states. The 5,000-session proof has a separate deterministic production fixture because it is intentionally slower.

Repository gates also check formatting, lint rules, types, package boundaries, public exports, the Turbo test graph, the production listener, and loopback-only setup. [ADR 0006](adr/0006-one-browser-regression-stack.md) explains why the project does not add a second component or visual-test platform.

## Trade-offs and limitations

- API-equivalent value estimates standard API pricing; it is not a claim about savings, ROI, or subscription billing.
- Cursor coverage is partial because some counters are server-side.
- Normal history collection is local, but an enabled Codex quota source can delegate provider communication to the installed `codex app-server`.
- Detailed prompt bodies are read only on explicit demand, locally, and within safety budgets; source availability still varies by harness.
- Windowed scrolling makes all records reachable but intentionally keeps only the nearby DOM mounted, so browser find-in-page cannot search all 5,000 sessions at once.
- The public demo is loopback-only and synthetic. There is no hosted demo or automatic multi-machine sync.
