/** The element ids Settings moves focus to, per platform. */
import type { Connection, ConnectionState } from "../shell/connection";
import type { SavedPlatform } from "../wire/types.gen";

export const headingId = (id: string) => `platform-${id}-h`;
export const editId = (id: string) => `platform-${id}-edit`;
export const actionId = (id: string) => `platform-${id}-action`;
export const changeSettingsId = (id: string) => `platform-${id}-change-settings`;

/** The platform's connection, or `undefined` when it isn't the Active one. */
export function connectionOf(p: SavedPlatform, c: ConnectionState): Connection | undefined {
  return c.status !== "none" && c.platformId === p.id ? c : undefined;
}
