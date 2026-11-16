/**
 * Gray until the progress shows (#105), for the buttons whose progress shows
 * in the connection rather than in a working state of their own (`working.ts`):
 * Connect, Trust and connect, Retry now, and the key question's Connect with
 * this key, which each start the connect again. From the press, the pressed
 * button keeps its words, but is `aria-disabled` in the disabled look with a
 * progress cursor (`ui/gray.ts`), keeps focus and ignores presses, until the
 * connection's next state arrives (for Connect, its platform's); then it goes
 * on as before. A command that fails first takes it back to rest, its error
 * shown as before.
 *
 * The press is kept here, beside the connection, rather than in the button:
 * a Connect that asks first (an unsaved form) presses when it's answered, and
 * a card that replaces a form shows the press the form made.
 */
import { useSyncExternalStore } from "react";
import { type ConnectionState, getConnection, watchConnection } from "../shell/connection";

/** The button waiting for its progress to show. */
export type Pressed =
  { button: "connect"; platformId: string } | { button: "retry" | "trust" | "use_key" };

/** Each press under way, and the command it sent. */
const pressed = new Set<{ button: Pressed; command: Promise<unknown> }>();
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

const same = (a: Pressed, b: Pressed) =>
  a.button === b.button &&
  (a.button !== "connect" || b.button !== "connect" || a.platformId === b.platformId);

/**
 * Whether `state` shows the progress `button` waits for: a connect's comes as
 * a state for its platform, which another platform's states, still coming in
 * until it's replaced, aren't.
 */
function shows(button: Pressed, state: ConnectionState): boolean {
  if (button.button !== "connect") return true;
  return state.status !== "none" && state.platformId === button.platformId;
}

/**
 * Presses `button`, which sends `command` and stays gray until the
 * connection's next state, or until `command` fails. While it's gray, another
 * press of it sends nothing and answers as the first does.
 */
export function press<T>(button: Pressed, command: () => Promise<T>): Promise<T> {
  const pending = [...pressed].find((p) => same(p.button, button));
  if (pending !== undefined) return pending.command as Promise<T>;
  const now = { button, command: Promise.resolve() as Promise<unknown> };
  const end = () => {
    stop();
    if (pressed.delete(now)) changed();
  };
  const stop = watchConnection(() => {
    if (shows(button, getConnection())) end();
  });
  pressed.add(now);
  changed();
  const sent = command();
  now.command = sent;
  sent.catch(end);
  return sent;
}

/** Whether `button` waits for its progress to show. */
export function usePressed(button: Pressed): boolean {
  return useSyncExternalStore(subscribe, () => [...pressed].some((p) => same(p.button, button)));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
