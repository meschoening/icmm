/** The buttons of a slow action's working state (`working.ts`). */
import type { Working } from "./working";

export interface WorkingButtonProps extends React.ComponentPropsWithRef<"button"> {
  working: Working;
  /** What it's doing, in the screen's own terms: "Saving…". */
  words: string;
}

/**
 * A button whose label becomes dots and `words` while `working` shows. Both
 * labels are always there, one hidden, so its width never changes.
 */
export function WorkingButton({ working, words, children, ...props }: WorkingButtonProps) {
  const { shown } = working;
  return (
    <button
      {...props}
      aria-busy={shown || undefined}
      aria-disabled={shown || props["aria-disabled"] || undefined}
    >
      <span className="swap">
        <span aria-hidden={shown || undefined}>{children}</span>
        <span aria-hidden={!shown || undefined}>
          <span className="btn-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {words}
        </span>
      </span>
    </button>
  );
}

export interface BesideButtonProps extends React.ComponentPropsWithRef<"button"> {
  /** The working button's state. */
  working: Working;
}

/**
 * A button beside a `WorkingButton`: from its press, this one does nothing,
 * and while its working state shows, this one is `disabled`.
 */
export function BesideButton({ working, onClick, disabled, ...props }: BesideButtonProps) {
  return (
    <button
      {...props}
      disabled={working.shown || disabled}
      onClick={(e) => {
        if (!working.busy()) onClick?.(e);
      }}
    />
  );
}

export interface GrowingButtonProps extends Omit<
  React.ComponentPropsWithRef<"button">,
  "children"
> {
  working: Working;
  /** Its word at rest: "Export". */
  word: string;
  /** What follows the word while it works: "ing…", for "Exporting…". */
  ending: string;
}

/**
 * Export's working button (#140), the one exception to `WorkingButton`'s
 * width: at rest it's as wide as its word. While it works, the dots open in
 * front of the word and `ending` after it, from no width, in 220 ms, so in a
 * row aligned to its end it grows toward its start and the buttons after it
 * stay put. With reduced motion it changes at once.
 */
export function GrowingButton({ working, word, ending, className, ...props }: GrowingButtonProps) {
  const { shown } = working;
  return (
    <button
      {...props}
      className={`${className ?? "btn"} grow-btn`}
      aria-busy={shown || undefined}
      aria-disabled={shown || props["aria-disabled"] || undefined}
      // Its parts open as inline grids, which a name computed from them would
      // space apart ("Export ing…"); while it works it's labeled whole.
      aria-label={shown ? `${word}${ending}` : undefined}
    >
      <span className="grow-label">
        <span className="grow-r" aria-hidden="true">
          <span>
            <span className="btn-dots">
              <i />
              <i />
              <i />
            </span>
            <i className="grow-gap" />
          </span>
        </span>
        {word}
        <span className="grow-r" aria-hidden={!shown || undefined}>
          <span>{ending}</span>
        </span>
      </span>
    </button>
  );
}
