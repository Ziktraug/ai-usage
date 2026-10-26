import type {
  DelegationConfig,
  DelegationConfigIssue,
  DelegationQualification,
} from '@ai-usage/report-core/delegation-contracts';
import type { ReviewTargetDeclaration } from '@ai-usage/report-core/work-attempts';
import type { ExecutorDeclaration } from '@ai-usage/report-core/work-executors';
import type { DelegationSettingsView, DelegationSimulateInput } from '@ai-usage/web-contract/delegation';

/**
 * The shapes the Delegation page renders and builds. What the page reads comes from the web
 * contract (`@ai-usage/web-contract/delegation`, the `*View` types below); what it writes is built
 * by the report-core parsers the engine runs, so it is typed with the report-core domain types.
 * This module is the single seam between the page and the contract; browser code never imports a
 * server module.
 */

export type {
  DelegationConfig,
  DelegationConfigIssue,
  DelegationQualification,
} from '@ai-usage/report-core/delegation-contracts';
export type { ReviewTargetDeclaration } from '@ai-usage/report-core/work-attempts';
export type { ExecutorDeclaration } from '@ai-usage/report-core/work-executors';
export type {
  DelegationHarnessSupport,
  DelegationRouteStatus,
  DelegationSettingsView,
  DelegationSimulateInput,
} from '@ai-usage/web-contract/delegation';

// --- What the settings view carries (wire shapes, as read) ----------------------------------------

export type DelegationConfigView = DelegationSettingsView['delegation']['config'];
export type DelegationDefaultsView = DelegationConfigView['defaults'];
export type DelegationPreferencesView = DelegationConfigView['preferences'];
export type DelegationRouteAnnotationView = DelegationConfigView['routes'][number];
export type DelegationRuleView = DelegationConfigView['rules'][number];
export type DelegationModelEntryView = DelegationConfigView['models'][number];
export type ExecutorDeclarationView = DelegationSettingsView['executors']['declarations'][number];
export type ReviewTargetDeclarationView = DelegationSettingsView['reviewTargets']['targets'][number];
export type DelegationCatalogModel = DelegationSettingsView['models'][number];
export type DelegationObservedModel = DelegationSettingsView['observedModels'][number];

// --- What the page writes and how a write ends -----------------------------------------------------

/**
 * `delegation.saveSettings` as the page builds it: typed sections, only the touched ones present.
 * The wire schema takes the sections as raw JSON records; the client adapter converts them.
 */
export interface DelegationSaveSettingsInput {
  readonly delegation?: DelegationConfig;
  readonly executors?: readonly ExecutorDeclaration[];
  readonly expectedRevision: string;
  readonly reviewTargets?: readonly ReviewTargetDeclaration[];
}

/**
 * How a save ended, as the page renders it. `conflict` carries the revision now on disk when the
 * server names it; `invalid` lists issues by config path; `unavailable` keeps the public tag.
 */
export type DelegationSaveOutcome =
  | { readonly issues: readonly DelegationConfigIssue[]; readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string; readonly revision: string | null }
  | { readonly kind: 'unavailable'; readonly message: string; readonly tag: string }
  | { readonly kind: 'written'; readonly revision: string };

export type DelegationSimulateOutcome =
  | { readonly kind: 'qualified'; readonly qualification: DelegationQualification }
  | { readonly kind: 'unavailable'; readonly message: string; readonly tag: string };

/** What the page needs from the browser client; the adapter over the oRPC client satisfies it. */
export interface DelegationPageClient {
  readonly saveSettings: (input: DelegationSaveSettingsInput) => Promise<DelegationSaveOutcome>;
  readonly simulate: (input: DelegationSimulateInput) => Promise<DelegationSimulateOutcome>;
}
