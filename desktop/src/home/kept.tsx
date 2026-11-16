/**
 * Whether Home shows its reads as of when the connection went (#386, #388),
 * for each of its regions to read: not connected, below the platform's card
 * (`kept`, LaptopHomeOffline's `kept` view), or while it reconnects
 * (LaptopMain's `reconnecting`). Either way pulses stop, and an action that
 * needs the platform's agent (Open its log, Resume) is gray with why: `offFor`
 * words its hover, "Connect to McKelvey HPC to resume".
 */
import { createContext, useContext } from "react";

export interface HomeKept {
  /** Not connected: the platform's card, then Home as of when the connection went. */
  kept: boolean;
  /** Not connected or reconnecting: Home's reads are as of `asOf`, and pulses stop. */
  stale: boolean;
  /** When the connection went, in Unix ms, while `stale`. */
  asOf: number | undefined;
  /**
   * What an action that needs the agent waits on, while `stale`: "Connect to
   * McKelvey HPC", or "Wait for McKelvey HPC to reconnect".
   */
  waitOn: string | undefined;
}

const LIVE: HomeKept = { kept: false, stale: false, asOf: undefined, waitOn: undefined };

export const HomeKeptContext = createContext<HomeKept>(LIVE);

/** Home's kept state, for a region of Home; live outside it. */
export const useHomeKept = (): HomeKept => useContext(HomeKeptContext);

/**
 * Why an action that needs the agent is gray, for its blocker (`useBlocker`):
 * `offFor(k, "open its log")` is "Connect to McKelvey HPC to open its log";
 * `undefined` while connected.
 */
export const offFor = (k: HomeKept, what: string): string | undefined =>
  k.waitOn === undefined ? undefined : `${k.waitOn} to ${what}`;
