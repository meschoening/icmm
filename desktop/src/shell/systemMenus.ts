/**
 * The right-click menus as the system draws them: Tauri's menu popup. On macOS and Windows its
 * items are muda's predefined Cut, Copy, Paste and Select all, the system's own (its undo, no
 * clipboard prompt). On Linux those do nothing (muda fakes their keys through libxdo, and not at
 * all under Wayland), so there they are plain items the desktop runs as WebKitGTK's own editing
 * commands (`src-tauri/src/edit.rs`, by these ids).
 */
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import type { At, MenuKind } from "./rightClick";

export type Platform = "macos" | "windows" | "linux";

/** Which system the WebView runs on, from its user agent. */
export function platformOf(userAgent: string): Platform {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Linux")) return "linux";
  return "macos";
}

/** GTK's words for them, as GtkEntry's own menu has them. */
const LINUX = {
  cut: { id: "edit-cut", text: "Cu&t" },
  copy: { id: "edit-copy", text: "&Copy" },
  paste: { id: "edit-paste", text: "&Paste" },
  selectAll: { id: "edit-select-all", text: "Select &All" },
};

/** Each menu's items; Windows' own menus say "Select all". */
function items(
  kind: MenuKind,
  platform: Platform,
): (PredefinedMenuItemOptions | MenuItemOptions)[] {
  if (platform === "linux") {
    return kind === "selection"
      ? [LINUX.copy]
      : [LINUX.cut, LINUX.copy, LINUX.paste, { item: "Separator" }, LINUX.selectAll];
  }
  if (kind === "selection") return [{ item: "Copy" }];
  return [
    { item: "Cut" },
    { item: "Copy" },
    { item: "Paste" },
    { item: "Separator" },
    platform === "windows" ? { item: "SelectAll", text: "Select &all" } : { item: "SelectAll" },
  ];
}

/**
 * Opens the system's menu of that kind at `at`, or at the pointer. Each menu is built on its first
 * use and kept: GTK's popup returns while the menu is still open, so it can't be freed after.
 */
export function systemMenus({
  platform,
}: {
  platform: Platform;
}): (kind: MenuKind, at?: At) => Promise<void> {
  const menus = new Map<MenuKind, Promise<Menu>>();
  return async (kind, at) => {
    let menu = menus.get(kind);
    if (!menu) {
      menu = Menu.new({ items: items(kind, platform) });
      menus.set(kind, menu);
      menu.catch(() => menus.delete(kind));
    }
    await (await menu).popup(at && new LogicalPosition(at.x, at.y));
  };
}
