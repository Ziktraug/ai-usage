<script lang="ts">
  import { type TabItem, Tabs } from '@ai-usage/design-system/svelte';
  import type { DelegationPageClient, DelegationSettingsView } from './delegation-contract';
  import { DELEGATION_SECTIONS, type DelegationSection, delegationSectionFor } from './delegation-model';
  import ModelsSection from './models-section.svelte';
  import RoutesSection from './routes-section.svelte';
  import RulesSection from './rules-section.svelte';

  let {
    client,
    onReload,
    onSectionChange,
    section,
    settings,
  }: {
    client: DelegationPageClient | null;
    onReload: () => Promise<void>;
    onSectionChange: (section: DelegationSection) => void;
    section: DelegationSection;
    settings: DelegationSettingsView;
  } = $props();

  const contentFor = (value: DelegationSection) => {
    if (value === 'routes') {
      return routes;
    }
    return value === 'rules' ? rules : models;
  };
  const items = $derived<readonly TabItem[]>(
    DELEGATION_SECTIONS.map((entry) => ({ content: contentFor(entry.value), label: entry.label, value: entry.value })),
  );
</script>

{#snippet routes()}
  <RoutesSection {client} {onReload} {settings} />
{/snippet}
{#snippet rules()}
  <RulesSection {client} {onReload} {settings} />
{/snippet}
{#snippet models()}
  <ModelsSection {client} {onReload} {settings} />
{/snippet}

<div data-delegation-section-active={section} data-delegation-workbench>
  <Tabs
    ariaLabel="Delegation sections"
    {items}
    onValueChange={(value) => onSectionChange(delegationSectionFor(value))}
    unmountOnExit={false}
    value={section}
  />
</div>
