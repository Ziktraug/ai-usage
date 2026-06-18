# @ai-usage/design-system

Shared Solid/Panda design primitives for ai-usage apps.

## Public API

Use the root export for reusable primitives that are not tied to the report app:

```ts
import { HarnessBadge, MetricTile, SegmentBar, aiUsagePreset } from '@ai-usage/design-system';
```

The root export intentionally exposes only generic primitives and their prop
types. Style slots, layout classes, and report-specific helpers stay out of the
default API.

Use the report namespace for styles and slots that encode the current report UI:

```ts
import { page, shell, tableWrap } from '@ai-usage/design-system/report';
```

This keeps app-specific vocabulary out of the default API while still allowing
the report app to share its extracted styles. Treat `@ai-usage/design-system/report`
as report-app-specific API; future apps should not import it by default.

## Panda consumer contract

This package ships its Panda build info from `styled-system/panda.buildinfo.json`.
A consuming app must run the design-system build before its own Panda
codegen/cssgen, then include the package-exported build info in its Panda scan:

```ts
import { aiUsagePreset } from '@ai-usage/design-system/preset';
import { defineConfig } from '@pandacss/dev';

const designSystemBuildInfoPackage = '@ai-usage/design-system/panda.buildinfo.json';
const designSystemBuildInfo = require.resolve(designSystemBuildInfoPackage);

export default defineConfig({
  include: ['./src/**/*.{ts,tsx}', designSystemBuildInfo],
  importMap: '@ai-usage/design-system',
  jsxFramework: 'solid',
  outdir: 'styled-system',
  presets: ['@pandacss/preset-panda', aiUsagePreset],
});
```

The package exports `@ai-usage/design-system/css` and
`@ai-usage/design-system/styles.css` from generated Panda output. Those files
exist after `bun run build` or `bun run check` in this package. Workspace apps
should depend on this package's `build` task before their own check/build task.
Direct app scripts should run `bun --filter @ai-usage/design-system build`
first if they import `@ai-usage/design-system/css` without going through Turbo.

## Dependency contract

Consumers provide `solid-js`. The design-system package keeps Solid as a peer
dependency because it exports Solid JSX components such as `HarnessBadge`.
