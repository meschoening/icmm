/**
 * ICMM's key (ADR-0012): `~/.ssh/icmm_ed25519`, one per computer, made the
 * first time a platform accepts none of the user's keys and added there with
 * their password. A platform that signs in with it names it as its key, or
 * as a jump host's.
 */
import type { SavedPlatform } from "../wire/types.gen";

export const ICMM_KEY = "~/.ssh/icmm_ed25519";

/** Whether `p` signs in to its login host, or a host on the way, with ICMM's key. */
export function usesIcmmKey(p: SavedPlatform): boolean {
  if (p.type !== "ssh") return false;
  return p.identity_file === ICMM_KEY || p.jump.some((j) => j.identity_file === ICMM_KEY);
}
