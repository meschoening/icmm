/**
 * The app's own Tauri commands, with the app's conveniences on top of the
 * wrappers `icmm-wire gen` generates in `wire/api.gen.ts`.
 */
import { commands } from "./wire/api.gen";
import type { LogLevel, WebviewInfo } from "./wire/types.gen";

export type { LogLevel, WebviewInfo };

/**
 * Writes `message` into the app log. Never throws: outside the app (plain
 * `npm run dev`, tests) there is no log, and a failed report must not
 * become a second error.
 */
export function logFrontendEvent(level: LogLevel, message: string): void {
  if (!inApp()) return;
  commands.log_frontend_event({ level, message }).catch(() => {});
}

export const webviewInfo = commands.webview_info;

/** Whether a Tauri IPC bridge is there to call: the app, or the proto harness. */
export function inApp(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
