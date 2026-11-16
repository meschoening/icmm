/**
 * `.stepper` (#52; LaptopStyles): a whole number in a range, typed or
 * stepped with its stacked ▴ ▾ arrows, by 1 or by `step` to its next
 * multiple (#166). An arrow at its end is gray
 * (`aria-disabled`) and does nothing. The field is a spin button, so ↑ and
 * ↓ step it too, and the arrows aren't Tab stops of their own. What's typed
 * stays as typed; the caller checks it.
 */
export interface StepperProps {
  /** As typed. */
  value: string;
  min: number;
  max: number;
  /** What an arrow steps by, to the next multiple of it; 1 by default. */
  step?: number;
  /** The field's name: "Points per gap, gvE". */
  label: string;
  /** The arrows' names: "One more per gap", "One fewer per gap". */
  more: string;
  fewer: string;
  onChange: (value: string) => void;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** The value as a whole number, or `null` while it isn't one. */
function whole(value: string): number | null {
  const t = value.trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

export function Stepper(p: StepperProps) {
  const n = whole(p.value);
  const atMax = n !== null && n >= p.max;
  const atMin = n !== null && n <= p.min;
  const step = (by: 1 | -1) => {
    if (by > 0 ? atMax : atMin) return;
    const size = p.step ?? 1;
    const from = n ?? p.min - by * size;
    // To the next multiple of the step, so 22 steps up to 25 and down to 20.
    const to =
      by > 0 ? Math.floor(from / size) * size + size : Math.ceil(from / size) * size - size;
    p.onChange(String(Math.min(p.max, Math.max(p.min, to))));
  };
  const arrow = (by: 1 | -1, name: string, end: boolean, path: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={name}
      aria-disabled={end || undefined}
      onClick={() => step(by)}
    >
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
        <path d={path} stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  );
  return (
    <span className="stepper">
      <input
        id={p.id}
        role="spinbutton"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={p.value}
        aria-label={p.label}
        aria-valuemin={p.min}
        aria-valuemax={p.max}
        aria-valuenow={n !== null && n >= p.min && n <= p.max ? n : undefined}
        aria-describedby={p["aria-describedby"]}
        aria-invalid={p["aria-invalid"] || undefined}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            step(e.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      <span className="arr">
        {arrow(1, p.more, atMax, "M1 4 4 1l3 3")}
        {arrow(-1, p.fewer, atMin, "M1 1l3 3 3-3")}
      </span>
    </span>
  );
}
