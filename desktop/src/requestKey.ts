/**
 * A write's `request_key` (ADR-0009): made once per user action and sent
 * again with the same inputs on a retry, so the agent applies it once.
 */
export function newRequestKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Keys each distinct input once: the same input gets the key it had, so a
 * retried save is the same request, and a changed one gets a new key.
 */
export function keyFor(last: { key: string; body: string } | null, input: unknown) {
  const body = JSON.stringify(input);
  return last !== null && last.body === body ? last : { key: newRequestKey(), body };
}

/** What a write whose answer was lost may have done, and doing it again (`unconfirmedWords`). */
export interface Unconfirmed {
  /** What may have happened: "herg-wt saved". */
  happened: string;
  /** Doing it again, as the sentence starts it: "Saving". */
  again: string;
  /** Why that's safe, where it needs saying: "it won’t make a second copy". */
  safe?: string;
}

/**
 * What a write says when its answer was lost (#168): it may have landed, and
 * doing it again is safe, since the retry sends the same key and the agent
 * applies it once (ADR-0009). Not connected, it's safe once `platform` is.
 */
export function unconfirmedWords(u: Unconfirmed, platform?: string): string {
  const once = platform === undefined ? "" : ` once ${platform} is connected`;
  return `Couldn’t confirm ${u.happened}. ${u.again} again is safe${once}${u.safe === undefined ? "" : `: ${u.safe}`}.`;
}

/** A dataset's save whose answer was lost: a retry won't make a second copy. */
export const savedWords = (name: string): Unconfirmed => ({
  happened: `${name} saved`,
  again: "Saving",
  safe: "it won’t make a second copy",
});
