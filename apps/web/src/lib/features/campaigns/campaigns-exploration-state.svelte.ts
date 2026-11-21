import type { CampaignTimelineAxis } from './campaign-timeline-model';
import type { CampaignScrollState } from './campaign-virtual-window';
import type { CampaignRevision } from './campaigns-page-model';
import type { CampaignExplorationAnchors } from './campaigns-query';

export interface CampaignMatchingRestoration {
  campaignKey: string;
  depth: number;
  rowIds: readonly string[];
}

export interface CampaignTimelineAxisState {
  axis: CampaignTimelineAxis | null;
  context: string;
}

export interface CampaignExpansion {
  key: string;
  open: boolean;
}

/** What a history entry keeps of the exploration, as SvelteKit serialises it with the app transport. */
export interface CampaignExplorationSnapshot {
  readonly anchors: CampaignExplorationAnchors;
  readonly automaticCampaign: string;
  readonly collapsedNodes: string[];
  readonly collapsedProjects: string[];
  readonly detailOpenerId: string;
  readonly expansion: CampaignExpansion | null;
  readonly inspected: CampaignRevision | null;
  readonly listNavigation: CampaignScrollState;
  readonly mapNavigation: CampaignScrollState;
  readonly matchingRestoration: CampaignMatchingRestoration | null;
  readonly memberDepths: Record<string, number>;
  readonly mobileMap: boolean;
  readonly scope: string;
  readonly searchExpanded: boolean;
  readonly searchNavigation: CampaignScrollState;
  readonly timelineAxis: CampaignTimelineAxisState | null;
  readonly timelineNavigation: CampaignScrollState;
  readonly topDepth: number;
}

/** What a refresh onto the latest revision keeps of the current exploration. */
export interface CampaignExplorationRefresh {
  readonly anchors: CampaignExplorationAnchors;
  readonly inspected: CampaignRevision;
  readonly listPageCount: number;
  readonly matchingRestoration: CampaignMatchingRestoration | null;
  readonly memberPageCount: number;
  readonly selectedKey: string;
}

export interface CampaignExplorationStateOptions {
  /** The session panel opener, captured with the exploration. */
  readonly focus: { detailOpenerId: string };
  /** The filters the exploration belongs to; a new scope starts a new exploration. */
  readonly scope: () => string;
}

/**
 * The reader's position in the campaign exploration: inspected revision, acquired depths, anchors,
 * scroll positions of the four virtual lists, collapsed and expanded rows. Back/Forward and a reload
 * return to it through `capture` and `restore`. Every field is reactive state read through its
 * getter; the component's effects and bindings read and write it there.
 */
export const createCampaignExplorationState = (options: CampaignExplorationStateOptions) => {
  let inspected = $state<CampaignRevision | null>(null);
  let topDepth = $state(1);
  let memberDepths = $state<Record<string, number>>({});
  let automaticCampaign = $state('');
  let anchors = $state<CampaignExplorationAnchors>({});
  let matchingRestoration = $state<CampaignMatchingRestoration | null>(null);
  let listNavigation = $state<CampaignScrollState>({});
  let mapNavigation = $state<CampaignScrollState>({});
  let timelineNavigation = $state<CampaignScrollState>({});
  let collapsedNodes = $state<ReadonlySet<string>>(new Set());
  let collapsedProjects = $state<ReadonlySet<string>>(new Set());
  let expansion = $state<CampaignExpansion | null>(null);
  let timelineAxis = $state<CampaignTimelineAxisState | null>(null);
  let mobileMap = $state(false);
  let searchExpanded = $state(false);
  let searchNavigation = $state<CampaignScrollState>({});
  let previousScope = '';

  return {
    get anchors(): CampaignExplorationAnchors {
      return anchors;
    },
    set anchors(value: CampaignExplorationAnchors) {
      anchors = value;
    },
    get automaticCampaign(): string {
      return automaticCampaign;
    },
    set automaticCampaign(value: string) {
      automaticCampaign = value;
    },
    capture: (): CampaignExplorationSnapshot => ({
      scope: options.scope(),
      anchors,
      matchingRestoration,
      inspected,
      automaticCampaign,
      topDepth,
      memberDepths,
      listNavigation,
      mapNavigation,
      timelineNavigation,
      timelineAxis,
      collapsedNodes: [...collapsedNodes],
      collapsedProjects: [...collapsedProjects],
      expansion,
      mobileMap,
      searchExpanded,
      searchNavigation,
      detailOpenerId: options.focus.detailOpenerId,
    }),
    get collapsedNodes(): ReadonlySet<string> {
      return collapsedNodes;
    },
    set collapsedNodes(value: ReadonlySet<string>) {
      collapsedNodes = value;
    },
    get collapsedProjects(): ReadonlySet<string> {
      return collapsedProjects;
    },
    set collapsedProjects(value: ReadonlySet<string>) {
      collapsedProjects = value;
    },
    get expansion(): CampaignExpansion | null {
      return expansion;
    },
    set expansion(value: CampaignExpansion | null) {
      expansion = value;
    },
    /** A new filter scope starts the exploration over; the first scope seen is only recorded. */
    followScope: (scope: string): void => {
      if (previousScope && previousScope !== scope) {
        automaticCampaign = '';
        searchExpanded = false;
        searchNavigation = {};
        topDepth = 1;
        memberDepths = {};
        anchors = {};
        matchingRestoration = null;
        listNavigation = {};
        mapNavigation = {};
        timelineNavigation = {};
        collapsedNodes = new Set();
        collapsedProjects = new Set();
      }
      previousScope = scope;
    },
    get inspected(): CampaignRevision | null {
      return inspected;
    },
    set inspected(value: CampaignRevision | null) {
      inspected = value;
    },
    get listNavigation(): CampaignScrollState {
      return listNavigation;
    },
    set listNavigation(value: CampaignScrollState) {
      listNavigation = value;
    },
    get mapNavigation(): CampaignScrollState {
      return mapNavigation;
    },
    set mapNavigation(value: CampaignScrollState) {
      mapNavigation = value;
    },
    get matchingRestoration(): CampaignMatchingRestoration | null {
      return matchingRestoration;
    },
    set matchingRestoration(value: CampaignMatchingRestoration | null) {
      matchingRestoration = value;
    },
    get memberDepths(): Record<string, number> {
      return memberDepths;
    },
    set memberDepths(value: Record<string, number>) {
      memberDepths = value;
    },
    get mobileMap(): boolean {
      return mobileMap;
    },
    set mobileMap(value: boolean) {
      mobileMap = value;
    },
    /** Moves onto the latest revision, keeping the reader's anchors and acquired depths. */
    refresh: (next: CampaignExplorationRefresh): void => {
      matchingRestoration = next.matchingRestoration;
      anchors = next.anchors;
      topDepth = Math.max(topDepth, next.listPageCount);
      memberDepths = {
        ...memberDepths,
        [next.selectedKey]: Math.max(memberDepths[next.selectedKey] ?? 1, next.memberPageCount),
      };
      inspected = next.inspected;
    },
    /** Returns to the latest results from the top, forgetting anchors, depths and positions. */
    restart: (latest: CampaignRevision | null): void => {
      anchors = {};
      matchingRestoration = null;
      topDepth = 1;
      memberDepths = {};
      listNavigation = {};
      mapNavigation = {};
      timelineNavigation = {};
      timelineAxis = null;
      inspected = latest;
    },
    restore: (saved: CampaignExplorationSnapshot): void => {
      previousScope = saved.scope;
      anchors = saved.anchors;
      matchingRestoration = saved.matchingRestoration;
      inspected = saved.inspected;
      automaticCampaign = saved.automaticCampaign;
      topDepth = saved.topDepth;
      memberDepths = saved.memberDepths;
      listNavigation = saved.listNavigation;
      mapNavigation = saved.mapNavigation;
      timelineNavigation = saved.timelineNavigation;
      timelineAxis = saved.timelineAxis;
      collapsedNodes = new Set(saved.collapsedNodes);
      collapsedProjects = new Set(saved.collapsedProjects);
      expansion = saved.expansion;
      mobileMap = saved.mobileMap;
      searchExpanded = saved.searchExpanded;
      searchNavigation = saved.searchNavigation;
      options.focus.detailOpenerId = saved.detailOpenerId;
    },
    get searchExpanded(): boolean {
      return searchExpanded;
    },
    set searchExpanded(value: boolean) {
      searchExpanded = value;
    },
    get searchNavigation(): CampaignScrollState {
      return searchNavigation;
    },
    set searchNavigation(value: CampaignScrollState) {
      searchNavigation = value;
    },
    get timelineAxis(): CampaignTimelineAxisState | null {
      return timelineAxis;
    },
    set timelineAxis(value: CampaignTimelineAxisState | null) {
      timelineAxis = value;
    },
    get timelineNavigation(): CampaignScrollState {
      return timelineNavigation;
    },
    set timelineNavigation(value: CampaignScrollState) {
      timelineNavigation = value;
    },
    get topDepth(): number {
      return topDepth;
    },
    set topDepth(value: number) {
      topDepth = value;
    },
  };
};

export type CampaignExplorationState = ReturnType<typeof createCampaignExplorationState>;
