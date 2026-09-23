import type { Snippet } from 'svelte';

export interface TabItem {
  content: Snippet;
  disabled?: boolean;
  label: string;
  value: string;
}

export interface TabsProps {
  ariaLabel: string;
  items: readonly TabItem[];
  onValueChange: (value: string) => void;
  unmountOnExit?: boolean;
  value: string;
}
