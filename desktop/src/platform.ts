/** Whether the app runs on macOS, where shortcuts use ⌘ rather than Ctrl. */
export function isMac(): boolean {
  return /Mac/.test(navigator.userAgent);
}

/** A shortcut's label as the OS writes it: `⌘K` on macOS, `Ctrl K` elsewhere. */
export function shortcutLabel(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl ${key}`;
}
