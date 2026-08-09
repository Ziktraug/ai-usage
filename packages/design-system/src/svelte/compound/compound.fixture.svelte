<script lang="ts">
  import MultiSelect from './multi-select.svelte';
  import SegmentedControl from './segmented-control.svelte';
  import Tabs from './tabs.svelte';

  const machineLabels: Readonly<Record<string, string>> = {
    alpha: 'Alpha workstation',
    beta: 'Beta workstation',
    gamma: 'Gamma workstation',
  };
  let machineOptions = $state(['alpha', 'beta']);
  let selectedMachines = $state<string[]>([]);
  let selectedRange = $state('week');
  let selectedTab = $state('overview');
</script>

{#snippet overviewPanel()}
  <p>Overview fixture panel</p>
{/snippet}

{#snippet sessionsPanel()}
  <button type="button">Focusable session fixture</button>
{/snippet}

{#snippet unavailablePanel()}
  <p>Disabled fixture panel</p>
{/snippet}

<section aria-label="Compound controls fixture">
  <div data-selection={selectedMachines.join(',')} data-testid="multi-select-fixture">
    <MultiSelect
      label="Filter fixture machines"
      name="fixture-machines"
      noun="machines"
      onValueChange={(value) => (selectedMachines = value)}
      optionLabel={(value) => machineLabels[value] ?? value}
      options={machineOptions}
      placeholder="All machines"
      value={selectedMachines}
    />
    <button
      onclick={() => (machineOptions = machineOptions.includes('gamma') ? ['alpha', 'beta'] : [...machineOptions, 'gamma'])}
      type="button"
    >
      Toggle dynamic option
    </button>
  </div>

  <div data-testid="segmented-control-fixture" data-value={selectedRange}>
    <SegmentedControl
      ariaLabel="Fixture range"
      defaultValue="week"
      items={[
        { label: 'Day', value: 'day' },
        { label: 'Week', value: 'week' },
        { label: 'Month', value: 'month' },
      ]}
      label="Range"
      onValueChange={(value) => (selectedRange = value)}
      value={selectedRange}
    />
  </div>

  <div data-testid="tabs-fixture" data-value={selectedTab}>
    <Tabs
      ariaLabel="Fixture sections"
      items={[
        { content: overviewPanel, label: 'Overview', value: 'overview' },
        { content: sessionsPanel, label: 'Sessions', value: 'sessions' },
        { content: unavailablePanel, disabled: true, label: 'Unavailable', value: 'unavailable' },
      ]}
      onValueChange={(value) => (selectedTab = value)}
      value={selectedTab}
    />
  </div>
</section>
