export interface SearchNavigationOptions {
  keepFocus?: boolean;
  replace?: boolean;
  resetScroll?: boolean;
  shallow?: boolean;
}

export type SearchNavigationIntent<Search> = (
  update: (current: Search) => Search,
  options?: SearchNavigationOptions,
) => void;
