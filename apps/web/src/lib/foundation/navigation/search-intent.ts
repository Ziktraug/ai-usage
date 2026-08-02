export interface SearchNavigationOptions {
  replace?: boolean;
  resetScroll?: boolean;
}

export type SearchNavigationIntent<Search> = (
  update: (current: Search) => Search,
  options?: SearchNavigationOptions,
) => void;
