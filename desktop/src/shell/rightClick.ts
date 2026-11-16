/**
 * The right-click menus ("The release app shows its WebView's own right-click menu", #298;
 * LaptopStyles' Right-click menus): a text field gets the system's Cut, Copy, Paste and Select
 * all, selected text gets Copy, and nothing else gets a menu. The WebView's own never shows.
 */

/** Which menu opens: a text field's, or selected text's. */
export type MenuKind = "field" | "selection";

/** Where a menu opens, in CSS px from the page's top-left corner. */
export interface At {
  x: number;
  y: number;
}

/** Opens the system's menu of that kind: at `at`, or at the pointer without one. */
export type OpenMenu = (kind: MenuKind, at?: At) => void;

/** The input types that hold text a person types, which get Cut, Copy, Paste and Select all. */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** `node`, if it's a text field that's on: a textarea, or an input that holds typed text. */
function textField(node: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  const field =
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement && TEXT_INPUTS.has(node.type))
      ? node
      : null;
  // `:disabled` also covers a field inside a disabled fieldset.
  return field && !field.matches(":disabled") ? field : null;
}

/** The selection's ranges, copied: they keep their place when the selection moves on. */
function rangesOf(doc: Document): Range[] {
  const selection = doc.getSelection();
  if (!selection) return [];
  return Array.from({ length: selection.rangeCount }, (_, i) =>
    selection.getRangeAt(i).cloneRange(),
  );
}

/** Whether (x, y) falls on text one of `ranges` selects. */
function onSelected(ranges: Range[], x: number, y: number): boolean {
  return ranges.some((range) =>
    Array.from(range.getClientRects()).some(
      (box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
    ),
  );
}

const same = (a: Range, b: Range) =>
  a.startContainer === b.startContainer &&
  a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer &&
  a.endOffset === b.endOffset;

/**
 * Puts the selection back to `ranges` if it has moved. WebKit on macOS selects the word under a
 * right-click before the page hears of it; a right-click here selects nothing.
 */
function restore(doc: Document, ranges: Range[]): void {
  const selection = doc.getSelection();
  const now = rangesOf(doc);
  if (!selection || (now.length === ranges.length && now.every((r, i) => same(r, ranges[i]!)))) {
    return;
  }
  selection.removeAllRanges();
  for (const range of ranges) selection.addRange(range);
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Puts the right-click menus on `doc`; the function it returns takes them off. */
export function installRightClickMenus(doc: Document, open: OpenMenu): () => void {
  // The selection as the last press found it, before the engine's own handling of the press, or
  // null once a key has been pressed since: then the menu is asked for from the keyboard.
  let pressed: Range[] | null = null;
  const onMouseDown = () => {
    pressed = rangesOf(doc);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // A held modifier (Shift-right-click, macOS's Control-click) is part of the pointer's.
    if (!MODIFIERS.has(e.key)) pressed = null;
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const field = textField(e.target);
    if (pressed === null) {
      // Shift+F10 or the menu key: at the field, as the pointer may be anywhere.
      if (field) {
        const box = field.getBoundingClientRect();
        open("field", { x: box.left, y: box.bottom });
      }
      return;
    }
    if (field) {
      open("field");
      return;
    }
    restore(doc, pressed);
    if (onSelected(pressed, e.clientX, e.clientY)) open("selection");
  };
  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("contextmenu", onContextMenu, true);
  };
}
