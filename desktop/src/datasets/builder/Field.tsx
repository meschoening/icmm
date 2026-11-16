/**
 * A builder field's text input, outlined with its issue, and the issue under
 * it; outlined too once you changed it, with Settings' marks beside it (#164).
 */
import type { FieldMark } from "../../setup/form";

export function TextField({
  id,
  value,
  issue,
  mark,
  width = "b-num",
  onChange,
}: {
  id: string;
  value: string;
  issue: string | undefined;
  /** You or another computer changed it: `MarkWords` says so beside it. */
  mark?: FieldMark;
  width?: "b-num" | "b-pname";
  onChange: (value: string) => void;
}) {
  const described = [issue ? `${id}-issue` : null, mark ? `${id}-was` : null].filter(Boolean);
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
 * and says what they saved.
 */
export function MarkWords({ id, mark }: { id: string; mark: FieldMark | undefined }) {
  if (mark === undefined) return null;
  return (
    <span id={`${id}-was`} className="hint b-mark">
      <span className="chg">{mark.kind === "theirs" ? "From another computer" : "Changed"}</span> ·
      was <span className="mono">{mark.was}</span>
      {mark.kind === "both" && (
        <>
          {" "}
          · another computer saved <span className="mono">{mark.saved}</span>
        </>
      )}
    </span>
  );
}
