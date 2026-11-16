/**
 * A saved platform's card: its name, how it's reached and where its data
 * is, and the connection when it's the Active platform (LaptopConnection).
 * Edit opens it into its form; the other action follows the connection:
 * Connect, Cancel while connecting, Stop reconnecting, or Disconnect. It's
 * one button whose words change, so it keeps focus. Connect is gray from the
 * press until the connect's first state (`connection/pressed.ts`). A failure
 * has no such button: its strip has Retry now.
 *
 * The strip across the card's foot shows the connect's steps, a failure, a
 * reconnect's countdown, a host key to trust or forget, or a key to add or
 * choose. When the element
 * focus was on goes (a strip is replaced, or Cancel goes with a failed
 * connect), focus moves to the card's heading rather than falling to the page.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { ConnectionStrip } from "../connection/ConnectionStrip";
import { usePressed } from "../connection/pressed";
import { useNow } from "../connection/useNow";
import { cardView, countsFrom, type StatusLine as StatusLineView } from "../connection/view";
import type { Connection } from "../shell/connection";
import { grayProps } from "../ui/gray";
import type { SavedPlatform, WireError } from "../wire/types.gen";
import { failureOf, usePlatformCommands, usePlatforms } from "./commands";
import { actionId, editId, headingId } from "./ids";
import { LaunchTag } from "./launch";
import { useShownPath } from "../ui/paths";

/** How a platform is reached, and where its data is. */
export function Where({ p }: { p: SavedPlatform }) {
  const shown = useShownPath(p);
  const data = <span className="mono ink-2">{shown(p.data_folder)}</span>;
  if (p.type === "local") return <>Runs here, with no SSH or queue · data in {data}</>;
  const port = p.port === 22 ? "" : `:${p.port}`;
  return (
    <>
      <span className="mono ink-2">
        {p.user}@{p.host}
        {port}
      </span>{" "}
      · data in {data}
    </>
  );
}

/**
 * The status line: the pill's glyph and words, then the facts. On the
 * Active platform the words and the stable facts are a live region; the
 * seconds that tick after them aren't, so a screen reader hears each state
 * once.
 */
function StatusLine({ line, live }: { line: StatusLineView; live: boolean }) {
  return (
    <div className="platform-status">
      <span className={`g ${line.glyph}`} aria-hidden="true" />
      <span>
        <span role={live ? "status" : undefined}>
          <span className={live ? `ink${line.glyph === "g-failed" ? " bad" : ""}` : undefined}>
            {line.words}
          </span>
          {line.fact}
        </span>
        {line.ticking}
      </span>
    </div>
  );
}

/**
 * A platform form's status, centered on its title: the card's status line,
 * so the form says what the card did (#117).
 */
export function FormStatus({
  connection,
  kind,
}: {
  connection: Connection;
  kind: SavedPlatform["type"];
}) {
  const now = useNow(countsFrom(connection));
  return <StatusLine line={cardView(connection, kind, now).status} live />;
}

export interface PlatformCardProps {
  platform: SavedPlatform;
  /** Its connection when it's the Active platform. */
  connection: Connection | undefined;
  /** ICMM connects to it when it opens: the auto-connects tag. */
  launch?: boolean;
  onEdit: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
  /** Connects to This computer instead, where the cluster can't be used. */
  onUseThisComputer: (id: string) => void;
  /** Home makes Connect the page's primary button. */
  primary?: boolean;
  /** First launch's Edit and the connection's action; `false` hides both once step 1 is done. */
  actions?: boolean;
  /**
   * "Its runs keep going." under Disconnect and Stop reconnecting; First
   * launch leaves it out, since setup comes before any run.
   */
  keepGoing?: boolean;
  /** What First launch shows under the connection: Platform setup, or its summary. */
  children?: ReactNode;
  className?: string;
}

export function PlatformCard({
  platform: p,
  connection,
  launch = false,
  onEdit,
  onConnect,
  onDisconnect,
  onRetry,
  onUseThisComputer,
  primary = false,
  actions = true,
  keepGoing = true,
  children,
  className,
}: PlatformCardProps) {
  // A reconnect counts down while it waits, and counts up while it tries.
  const now = useNow(countsFrom(connection));
  const view = cardView(connection, p.type, now);
  const focused = useRef<Element | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const commands = usePlatformCommands();
  const connecting = usePressed({ button: "connect", platformId: p.id });
  const thisComputer = usePlatforms().data?.platforms.find((x) => x.type === "local")?.id;

  useEffect(() => {
    const was = focused.current;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (was !== null && !was.isConnected && lost) {
      focused.current = null;
      heading.current?.focus();
    }
  });

  return (
    <article
      className={["surface-card platform", className].filter(Boolean).join(" ")}
      aria-labelledby={headingId(p.id)}
      onFocus={(e) => (focused.current = e.target)}
      // An element removed while focused doesn't blur, so only focus that
      // left on its own clears this.
      onBlur={() => (focused.current = null)}
    >
      <div className="platform-top">
        <div className="platform-facts">
          <div className="platform-name">
            <h3 id={headingId(p.id)} ref={heading} tabIndex={-1}>
              {p.name}
            </h3>
            {launch && <LaunchTag />}
          </div>
          <div className="platform-where">
            <Where p={p} />
          </div>
          <StatusLine line={view.status} live={connection !== undefined} />
        </div>
        {actions && (
          <div className="platform-side">
            <div className="platform-actions">
              <button
                type="button"
                className="btn btn-sm"
                id={editId(p.id)}
                aria-label={`Edit ${p.name}`}
                onClick={onEdit}
              >
                Edit
              </button>
              {view.action !== null && (
                <button
                  type="button"
                  className={
                    primary && view.action === "Connect" ? "btn btn-sm btn-primary" : "btn btn-sm"
                  }
                  id={actionId(p.id)}
                  {...grayProps(connecting && view.action === "Connect")}
                  onClick={() => {
                    if (view.action !== "Connect") onDisconnect();
                    else if (!connecting) onConnect();
                  }}
                >
                  {view.action}
                </button>
              )}
            </div>
            {keepGoing && view.keepGoing && <p className="hint">Its runs keep going.</p>}
          </div>
        )}
      </div>
      {connection !== undefined && view.strip !== null && (
        <ConnectionStrip
          view={view.strip}
          platform={p.name}
          onRetry={onRetry}
          onEdit={onEdit}
          thisComputer={thisComputer}
          onUseThisComputer={() => {
            if (thisComputer !== undefined) onUseThisComputer(thisComputer);
          }}
          onCancel={onDisconnect}
          // A key the connect no longer waits on needs nothing: the next
          // state replaces the strip.
          onTrust={(fingerprint) => void commands.trust(fingerprint).catch(() => {})}
          onForget={(fingerprint) =>
            commands.forget(fingerprint).catch((e: unknown) => {
              throw failureOf(e).message;
            })
          }
          // A key question the connect no longer asks needs nothing either.
          onSetUpKey={() => void commands.setUpKey().catch(() => {})}
          onAddKey={(password) =>
            commands.addKey(password).catch((e: unknown) => {
              const failure = failureOf(e, (path) => path[0]);
              throw failure.fields.password ?? failure.message;
            })
          }
          onUseKey={(file) =>
            commands.useKey(file).catch((e: unknown) => {
              if ((e as Partial<WireError> | undefined)?.code === "conflict") return;
              const failure = failureOf(e, (path) => path[0]);
              throw failure.fields.identity_file ?? failure.message;
            })
          }
        />
      )}
      {children}
    </article>
  );
}
