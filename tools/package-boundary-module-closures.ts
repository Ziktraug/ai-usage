import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isPackageOrSubpath,
  lineNumberFor,
  moduleImportPattern,
  type PackageBoundaryViolation,
  resolveRelativeModule,
} from './package-boundary-reviewed-rules';

// The import-closure rules that replaced source-text tests (plan 128 B2): portable-report, the
// framework-neutral Web presentation models and the passive design recipes. tools/check-package-boundaries.ts
// runs them; this module imports only the shared scan primitives, so the modules stay acyclic.

/** What a closure reads from a discovered workspace package. */
interface ClosurePackage {
  readonly directory: string;
  readonly packageName: string;
}

const reportDataPackage = '@ai-usage/report-data';
const isWorkspaceSpecifier = (specifier: string): boolean => specifier.startsWith('@ai-usage/');

/**
 * An import closure that must stay inside a set of allowed modules: every module reachable from the
 * entrypoints through relative imports (and, for the Web app, `#lib/` aliases) is read, and each
 * import specifier and each reached module is judged by the policy.
 */
interface ModuleClosurePolicy {
  /** The package directory an import alias such as `#lib/` points into, if the closure follows one. */
  readonly aliases?: ReadonlyMap<string, string>;
  /** Package-relative entrypoints. Each must exist while the policy's package does. */
  readonly entrypoints: readonly string[];
  /** Why a non-relative specifier may not appear in the closure, if it may not. */
  readonly importReason: (specifier: string) => string | undefined;
  /** Why a reached module may not be part of the closure, if it may not; given package-relative. */
  readonly moduleReason?: (packageRelativeFile: string) => string | undefined;
  readonly name: string;
  /** How a relative import that leaves the package or resolves to nothing names it; the package name by default. */
  readonly packageLabel?: string;
  readonly packageName: string;
}

const webPresentationForbiddenPrefixes = [
  'solid-js',
  'svelte',
  '@ark-ui/solid',
  '@ark-ui/svelte',
  '@ai-usage/design-system/solid',
  '@ai-usage/design-system/svelte',
  '@tanstack/solid',
  '@tanstack/svelte',
  '$app',
] as const;
const passiveDesignRuntimes = ['@ark-ui/solid', '@ark-ui/svelte', 'solid-js', 'svelte'] as const;
const passiveDesignExternalImports = new Set(['@ai-usage/design-system/css']);

const moduleClosurePolicies: readonly ModuleClosurePolicy[] = [
  {
    entrypoints: ['src/portable-report.ts'],
    importReason: (specifier) =>
      isWorkspaceSpecifier(specifier) && !isPackageOrSubpath(specifier, '@ai-usage/report-core')
        ? 'The portable-report import closure may depend only on report-core workspace modules.'
        : undefined,
    name: 'portable-report',
    packageLabel: 'report-data',
    packageName: reportDataPackage,
  },
  {
    // Reusable presentation and dashboard models stay framework-neutral, so any client (and any test)
    // can run them without a component runtime, a SvelteKit module or server code.
    aliases: new Map([['#lib/', 'src/lib/']]),
    entrypoints: [
      'src/lib/foundation/dashboard/dashboard-analytics.ts',
      'src/lib/foundation/dashboard/dashboard-model.ts',
      'src/lib/features/sessions/dashboard-sort.ts',
      'src/lib/foundation/overview-model.ts',
      'src/lib/features/report/provider-status-model.ts',
      'src/lib/foundation/campaign-label-overrides.ts',
      'src/lib/foundation/session/session-analysis-target.ts',
      'src/lib/foundation/presentation/format.ts',
      'src/lib/foundation/presentation/report-value.ts',
      'src/lib/foundation/machine-freshness-presentation.ts',
    ],
    importReason: (specifier) =>
      specifier.startsWith('node:') ||
      specifier.startsWith('#lib/server') ||
      webPresentationForbiddenPrefixes.some((forbidden) => specifier.startsWith(forbidden))
        ? 'The framework-neutral Web presentation closure cannot reach a client framework, SvelteKit, Node or server module.'
        : undefined,
    moduleReason: (file) =>
      path.posix.extname(file) !== '.ts' || file.includes('.server.') || file.split('/').includes('server')
        ? 'The framework-neutral Web presentation closure may contain only TypeScript modules outside server code.'
        : undefined,
    name: 'framework-neutral Web presentation',
    packageName: '@ai-usage/web',
  },
  {
    // Passive design modules are plain style recipes: no component or framework runtime, and no
    // package beyond the generated `css` entry.
    entrypoints: [
      'src/components/button.ts',
      'src/components/chart.ts',
      'src/components/empty-state.ts',
      'src/components/field.ts',
      'src/components/layout.ts',
      'src/components/overview.ts',
      'src/components/panel.ts',
      'src/components/skills.ts',
      'src/components/status.ts',
      'src/components/table.ts',
      'src/components/time-slider.ts',
    ],
    importReason: (specifier) => {
      if (passiveDesignRuntimes.some((runtime) => specifier === runtime || specifier.startsWith(`${runtime}/`))) {
        return 'The passive design closure imports no component or framework runtime.';
      }
      return passiveDesignExternalImports.has(specifier)
        ? undefined
        : 'The passive design closure may import only the generated css entry outside its own modules.';
    },
    moduleReason: (file) =>
      path.posix.extname(file) === '.ts'
        ? undefined
        : 'The passive design closure may contain only TypeScript modules.',
    name: 'passive design',
    packageName: '@ai-usage/design-system',
  },
];

const existingFiles = async (files: readonly string[]): Promise<string[]> => {
  const present = await Promise.all(
    files.map((file) =>
      readFile(file, 'utf8').then(
        () => file,
        () => undefined,
      ),
    ),
  );
  return present.filter((file) => file !== undefined);
};

/** A relative specifier for an import the closure follows: relative already, or through a known alias. */
const followedSpecifier = (
  policy: ModuleClosurePolicy,
  packageDirectory: string,
  importer: string,
  specifier: string,
): string | undefined => {
  if (specifier.startsWith('.')) {
    return specifier;
  }
  for (const [alias, target] of policy.aliases ?? []) {
    if (specifier.startsWith(alias)) {
      const aliased = path.join(packageDirectory, target, specifier.slice(alias.length));
      return `./${path.relative(path.dirname(importer), aliased).split(path.sep).join('/')}`;
    }
  }
};

interface ClosureModuleScan {
  readonly followed: string[];
  readonly violations: PackageBoundaryViolation[];
}

/** Judges one module of a closure: the module itself, then each import it holds. */
const scanClosureModule = async (
  root: string,
  packageInfo: ClosurePackage,
  policy: ModuleClosurePolicy,
  file: string,
): Promise<ClosureModuleScan> => {
  const relativeFile = path.relative(root, file).split(path.sep).join('/');
  const violations: PackageBoundaryViolation[] = [];
  const followed: string[] = [];
  const moduleReason = policy.moduleReason?.(path.relative(packageInfo.directory, file).split(path.sep).join('/'));
  if (moduleReason) {
    violations.push({
      file: relativeFile,
      message: moduleReason,
      packageName: policy.packageName,
      specifier: relativeFile,
    });
  }
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(moduleImportPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) {
      continue;
    }
    const followedImport = followedSpecifier(policy, packageInfo.directory, file, specifier);
    const resolved =
      followedImport === undefined
        ? undefined
        : await resolveRelativeModule(packageInfo.directory, file, followedImport);
    if (resolved?.status === 'resolved') {
      followed.push(resolved.file);
      continue;
    }
    const reason =
      resolved === undefined
        ? policy.importReason(specifier)
        : `The ${policy.name} import closure must resolve relative modules inside ${policy.packageLabel ?? policy.packageName}.`;
    if (reason) {
      violations.push({
        file: relativeFile,
        line: lineNumberFor(text, match.index),
        message: reason,
        packageName: policy.packageName,
        specifier,
      });
    }
  }
  return { followed, violations };
};

const collectPolicyViolations = async (
  root: string,
  packageInfo: ClosurePackage,
  policy: ModuleClosurePolicy,
): Promise<PackageBoundaryViolation[]> => {
  const entrypoints = policy.entrypoints.map((entrypoint) => path.join(packageInfo.directory, entrypoint));
  const present = await existingFiles(entrypoints);
  if (present.length === 0) {
    // A closure that lost every entrypoint (a rename, a move) would otherwise pass while checking nothing.
    return [
      {
        file: path.relative(root, packageInfo.directory).split(path.sep).join('/'),
        message: `The ${policy.name} import closure has none of its ${entrypoints.length} entrypoints: update its policy in tools/package-boundary-module-closures.ts instead of leaving the closure unchecked.`,
        packageName: policy.packageName,
        specifier: policy.entrypoints.join(', '),
      },
    ];
  }
  const violations: PackageBoundaryViolation[] = entrypoints
    .filter((entrypoint) => !present.includes(entrypoint))
    .map((entrypoint) => {
      const relativeEntrypoint = path.relative(root, entrypoint).split(path.sep).join('/');
      return {
        file: relativeEntrypoint,
        message: `The ${policy.name} import closure entrypoint is missing.`,
        packageName: policy.packageName,
        specifier: relativeEntrypoint,
      };
    });
  const pending = [...present];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!(file && !visited.has(file))) {
      continue;
    }
    visited.add(file);
    const scan = await scanClosureModule(root, packageInfo, policy, file);
    violations.push(...scan.violations);
    pending.push(...scan.followed);
  }
  return violations;
};

/** Every closure policy whose package is in the workspace; a policy whose package is absent is skipped. */
export const collectModuleClosureViolations = async (
  root: string,
  packages: ReadonlyMap<string, ClosurePackage>,
): Promise<PackageBoundaryViolation[]> => {
  const violations: PackageBoundaryViolation[] = [];
  for (const policy of moduleClosurePolicies) {
    const packageInfo = packages.get(policy.packageName);
    if (packageInfo) {
      violations.push(...(await collectPolicyViolations(root, packageInfo, policy)));
    }
  }
  return violations;
};
