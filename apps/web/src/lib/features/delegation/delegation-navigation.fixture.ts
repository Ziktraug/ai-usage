/** `$app/navigation` while rendering the Delegation page on the server in tests: nothing navigates. */
export const goto = (): Promise<void> => Promise.resolve();
