/**
 * Light or dark, on `<html data-theme>`. The app follows the system unless
 * the user chooses Light or Dark in Settings; the proto harness can pin
 * either. The stylesheet keys its tokens and `color-scheme` to the
 * attribute, so UA-drawn parts (scrollbars, select popups) follow too.
 */
import type { Theme as ThemeChoice } from "./wire/types.gen";

export type Theme = "light" | "dark";
export type { ThemeChoice };

let now: { system: MediaQueryList; choice: ThemeChoice } | undefined;

function apply() {
  if (now === undefined) return;
  const { system, choice } = now;
  document.documentElement.dataset.theme =
    choice === "system" ? (system.matches ? "dark" : "light") : choice;
}

/**
 * Applies `choice` now, and the system's theme whenever `system` changes
 * while the choice is System. Returns a function that stops following.
 */
export function startTheme(system: MediaQueryList, choice: ThemeChoice = "system"): () => void {
  const started = { system, choice };
  now = started;
  apply();
  system.addEventListener("change", apply);
  return () => {
    system.removeEventListener("change", apply);
    if (now === started) now = undefined;
  };
}

/** Applies the user's choice at once; System follows the system again. */
export function chooseTheme(choice: ThemeChoice): void {
  if (now === undefined) {
    startTheme(window.matchMedia("(prefers-color-scheme: dark)"), choice);
    return;
  }
  now.choice = choice;
  apply();
}
