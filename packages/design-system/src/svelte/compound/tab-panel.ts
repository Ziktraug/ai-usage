export type FrameScheduler = (callback: () => void) => void;

export interface TabPanelElement {
  isConnected: boolean;
  tabIndex: number;
}

export const keepTabPanelInTabOrder = (element: TabPanelElement, scheduleAnimationFrame: FrameScheduler): void => {
  element.tabIndex = 0;
  scheduleAnimationFrame(() => {
    if (element.isConnected) {
      element.tabIndex = 0;
    }
  });
};
