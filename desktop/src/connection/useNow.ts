import { useCallback, useSyncExternalStore } from "react";

/**
 * The time now, in Unix milliseconds, as of the last whole second counted
 * from any of `origins` (when a connect, a step or a retry began): every
 * figure counted in whole seconds from one of them reads as it would at this
 * very moment, from the first second. Each render reads it afresh, and while
 * there are origins the component renders again as each such second passes.
 * Without any, it's the clock's own second.
 */
export function useNow(origins: readonly number[]): number {
  const key = origins.join(",");
  const subscribe = useCallback(
    (onChange: () => void) => {
      const from = toOrigins(key);
      if (from.length === 0) return () => {};
      const tick = () => {
        onChange();
        timer = setTimeout(tick, untilNext(from, Date.now()));
      };
      let timer = setTimeout(tick, untilNext(from, Date.now()));
      return () => clearTimeout(timer);
    },
    [key],
  );
  return useSyncExternalStore(subscribe, () => lastSecond(toOrigins(key), Date.now()));
}

const toOrigins = (key: string) => (key === "" ? [] : key.split(",").map(Number));

/** How far `t` is into the second counted from `origin`, in ms. */
const into = (origin: number, t: number) => (((t - origin) % 1000) + 1000) % 1000;

/** The latest whole second at or before `t` counted from any origin; the clock's without one. */
function lastSecond(origins: number[], t: number): number {
  if (origins.length === 0) return Math.floor(t / 1000) * 1000;
  return t - Math.min(...origins.map((o) => into(o, t)));
}

/** The time from `t` to the next whole second counted from any origin: 1 to 1000 ms. */
function untilNext(origins: number[], t: number): number {
  return 1000 - Math.max(...origins.map((o) => into(o, t)));
}
