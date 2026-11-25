/**
 * A builder field's text input, outlined with its issue, and the issue under
 * it; outlined too once you changed it, with Settings' marks beside it (#164).
 */
import type { FieldMark } from "../../setup/form";
import { BreakingName } from "../../ui/BreakingName";

export function TextField({
  id,
  value,
  issue,
  mark,
  hint = false,
  width = "b-num",
  onChange,
}: {
  id: string;
  value: string;
  issue: string | undefined;
  /** You or another computer changed it: `MarkWords` says so beside it, or under a name. */
  mark?: FieldMark;
  /** A hint under it, `${id}-h`, that its issue takes the place of. */
  hint?: boolean;
  width?: "b-num" | "b-pname";
  onChange: (value: string) => void;
}) {
  // In the order they read: the mark beside it or first under it, then its issue or hint (#572).
  const described = [
    mark ? `${id}-was` : null,
    issue ? `${id}-issue` : hint ? `${id}-h` : null,
  ].filter(Boolean);
  return (
    <input
      id={id}
      className={`input mono ${width}${issue ? " bad" : ""}${mark && mark.kind !== "theirs" ? " dirty" : ""}`}
      value={value}
      spellCheck={false}
      autoComplete="off"
      aria-invalid={issue ? true : undefined}
      aria-describedby={described.length > 0 ? described.join(" ") : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function FieldIssue({ id, issue }: { id: string; issue: string | undefined }) {
  return issue ? (
    <span id={`${id}-issue`} className="err">
      {issue}
    </span>
  ) : null;
}

/**
 * What a mark says (Settings' words): "Changed · was 1000" for yours, "From
 * another computer · was 1500" for theirs; one you both changed keeps yours
 * and says what they saved. Beside its field, on one line; `under` a protocol
 * name, the first line under the field, wrapping where the names break (#572 D10).
 */
export function MarkWords({
  id,
  mark,
  under = false,
}: {
  id: string;
  mark: FieldMark | undefined;
  under?: boolean;
}) {
  if (mark === undefined) return null;
  const value = (v: string) => <span className="mono">{under ? <BreakingName name={v} /> : v}</span>;
  return (
    <span id={`${id}-was`} className={under ? "hint" : "hint b-mark"}>
      <span className="chg">{mark.kind === "theirs" ? "From another computer" : "Changed"}</span> ·
      was {value(mark.was)}
      {mark.kind === "both" && (
        <>
          {" "}
          · another computer saved {value(mark.saved)}
        </>
      )}
    </span>
  );
}
