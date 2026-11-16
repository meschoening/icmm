/**
 * An SSH platform's Connection details as its forms hold them: Settings'
 * card (`SshFormCard`) and First launch's step 1 (`ConnectForm`).
 */
import type { JumpHost, SshConfigHost, SshPlatform } from "../wire/types.gen";

export const DATA_FOLDER = "~/icmm";
export const CHOOSE = "\u0000choose";
/** Add's key until the user picks one: the first of the usual keys in `~/.ssh`. */
export const FIRST_FOUND = "\u0000first";
/** The keys the connect tries on its own, in its order. */
export const USUAL = ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"];

export interface Fields {
  name: string;
  host: string;
  port: string;
  user: string;
  key: string;
  data: string;
}
export type Field = keyof Fields;

/** The wire's name for each field, for its issues. */
export const WIRE: Record<Field, string> = {
  name: "name",
  host: "host",
  port: "port",
  user: "user",
  key: "identity_file",
  data: "data_folder",
};
export const ORDER: Field[] = ["name", "host", "port", "user", "key", "data"];

export function fieldsOf(p: SshPlatform | undefined): Fields {
  return {
    name: p?.name ?? "",
    host: p?.host ?? "",
    port: String(p?.port ?? 22),
    user: p?.user ?? "",
    key: p === undefined ? FIRST_FOUND : (p.identity_file ?? ""),
    data: p?.data_folder ?? DATA_FOLDER,
  };
}

/** The fields that differ from `was`, ignoring surrounding spaces. */
export function changedFields(now: Fields, was: Fields): Field[] {
  return ORDER.filter((f) => now[f].trim() !== was[f].trim());
}

/** The fields as a `~/.ssh/config` host fills them in, named for its alias. */
export function filledIn(now: Fields, alias: string, host: SshConfigHost): Fields {
  return {
    ...now,
    name: alias,
    host: host.host,
    port: String(host.port),
    user: host.user,
    key: host.identity_file ?? "",
  };
}

/** Whether two routes go through the same hosts the same way. */
export function sameRoute(a: JumpHost[], b: JumpHost[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The jump hosts that reach a Login host, and the host and port they were resolved for. */
export interface ResolvedRoute {
  jump: JumpHost[];
  host: string;
  port: string;
}

/** The route a saved platform keeps, or none. */
export function routeOf(p: SshPlatform | undefined): ResolvedRoute {
  return { jump: p?.jump ?? [], host: p?.host ?? "", port: String(p?.port ?? 22) };
}

/** The route a `~/.ssh/config` host came with. */
export function routeFrom(host: SshConfigHost): ResolvedRoute {
  return { jump: host.jump, host: host.host, port: String(host.port) };
}

/**
 * The jump hosts the form sends: the route's while the form still reaches
 * the host on the port it was resolved for, and none once either changes.
 */
export function jumpFor(f: Fields, route: ResolvedRoute): JumpHost[] {
  const same = (a: string, b: string) => a.trim() === b.trim();
  return same(f.host, route.host) && same(f.port, route.port) ? route.jump : [];
}

/** The key a form shows and sends: Add's is the first of the usual keys found in `~/.ssh`. */
export function shownKey(key: string, found: string[] | undefined): string {
  return key === FIRST_FOUND ? (USUAL.find((k) => found?.includes(k)) ?? found?.[0] ?? "") : key;
}
