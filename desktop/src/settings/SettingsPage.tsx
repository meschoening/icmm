/**
 * Settings (LaptopSettings, LaptopPlatformForm, LaptopConnection): the
 * compute platforms this computer knows, under a facts line naming the
 * Active platform and its connection. Each saved platform has a card, This
 * computer last; Add puts a new card at the top, and Edit opens a card into
 * its form (as `?edit=<id>` does, which Home's Edit uses). The Active
 * platform's card also holds its Platform settings, which Change settings
 * opens into their form. One form is open at a time, and leaving one with
 * unsaved changes, or a save waiting for its connection (for another form,
 * to connect elsewhere, to reset, to leave Settings, or to close the window
 * or quit ICMM), asks first (#118's U07). General, Reset and a line of
 * versions follow.
 */
import { Link, useBlocker, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { settingsFacts } from "../connection/view";
import { inApp } from "../ipc";
import { PageHeading } from "../ui/PageHeading";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useAsked } from "../shell/asked";
import { useConnection } from "../shell/connection";
import { leavingWords } from "../shell/leaving";
import { commands as desktopCommands } from "../wire/api.gen";
import type { SavedPlatform } from "../wire/types.gen";
import { failureOf, usePlatformCommands, usePlatforms, useSetLaunch } from "./commands";
import { General } from "./General";
import { LocalFormCard } from "./LocalFormCard";
import { changeSettingsId, connectionOf, editId, headingId } from "./ids";
import { LaunchMenu } from "./launch";
import { PlatformCard } from "./PlatformCard";
import { PlatformSettings } from "./PlatformSettings";
import { Reset } from "./Reset";
import { SshFormCard } from "./SshFormCard";
import { ReportFromHere } from "../report/ReportFromHere";

export function SettingsPage() {
  const facts = settingsFacts(useConnection());
  const platforms = useRef<PlatformsHandle>(null);
  const list = usePlatforms().data?.platforms ?? [];
  const general = useSectionInView(useLocation().hash === "general");
  return (
    <div className="page settings-page">
      <nav className="sub" aria-label="Settings sections">
        <Link
          to="/settings"
          hash="platforms"
          className={general ? undefined : "on"}
          aria-current={general ? undefined : "true"}
        >
          Compute platforms
        </Link>
        <Link
          to="/settings"
          hash="general"
          className={general ? "on" : undefined}
          aria-current={general ? "true" : undefined}
        >
          General
        </Link>
      </nav>
      <div className="settings-main">
        <div className="page-head">
          <PageHeading>Settings</PageHeading>
          {facts !== undefined && <p className="facts">{facts}</p>}
        </div>
        <ReportFromHere name="Settings" />
        <Platforms ref={platforms} />
        <General />
        <Reset
          platforms={list}
          guard={(then) => (platforms.current === null ? then() : platforms.current.reset(then))}
        />
        <Versions platforms={list} />
      </div>
    </div>
  );
}

/**
 * Whether General is the section in view: from the URL's hash until the page scrolls, then
 * General once its top is in the window's upper half (#449's SF21), as when Reset ICMM… scrolls
 * it there.
 */
function useSectionInView(fromHash: boolean): boolean {
  const [scrolled, setScrolled] = useState<boolean>();
  const [hash, setHash] = useState(fromHash);
  if (hash !== fromHash) {
    // A section link pressed: its hash says until the next scroll.
    setHash(fromHash);
    setScrolled(undefined);
  }
  useEffect(() => {
    const onScroll = () => {
      const section = document.getElementById("general");
      if (section === null) return;
      setScrolled(section.getBoundingClientRect().top < window.innerHeight / 2);
    };
    // Any scroller's scroll, the page's own among them, which doesn't bubble.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  return scrolled ?? fromHash;
}

/**
 * The app's and engine's versions, the engine's only while connected, as
 * plain text to copy into a report. The wire's version stays out: to this
 * audience a protocol is a voltage protocol (#116).
 */
function Versions({ platforms }: { platforms: SavedPlatform[] }) {
  const c = useConnection();
  let engine = "";
  if (c.status === "connected" && c.engineVersion !== null) {
    const local = platforms.find((p) => p.id === c.platformId)?.type === "local";
    engine = ` · engine ${c.engineVersion} on ${local ? "this computer" : c.platform}`;
  }
  return (
    <footer className="versions">
      ICMM {__APP_VERSION__}
      {engine}
    </footer>
  );
}

/** What the page asks of the platforms section. */
interface PlatformsHandle {
  /** Runs `then` once any open form's unsaved changes may go. */
  reset: (then: () => void) => void;
}

type Open = { kind: "add" } | { kind: "edit"; id: string } | { kind: "settings"; id: string };

/** What waits on the discard question. */
type Pending =
  | { kind: "switch"; to: SavedPlatform }
  | { kind: "disconnect" }
  | { kind: "reset"; then: () => void }
  | { kind: "open"; next: Open; nextName: string | undefined }
  | { kind: "leave"; doing: string }
  | { kind: "quit" };

/** The event the desktop sends when the window closes or ICMM quits while the page asks first. */
const QUIT_EVENT = "quit_requested";

const ADD_ID = "platforms-add";
const SECTION_ID = "platforms-h";

function Platforms({ ref }: { ref: Ref<PlatformsHandle> }) {
  const list = usePlatforms();
  const connection = useConnection();
  const commands = usePlatformCommands();
  const [open, setOpen] = useState<Open | null>(null);
  const [changes, setChanges] = useState(0);
  /** A Platform settings save is waiting for its connection to come back. */
  const [waiting, setWaiting] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | undefined>();
  /** The element to focus once it's rendered: a new card shows after the list reloads. */
  const focusTo = useRef<string | null>(null);
  const setFocusTo = (id: string) => (focusTo.current = id);
  const initiator = useRef<HTMLElement | null>(null);

  const platforms = list.data?.platforms ?? [];
  useEffect(() => {
    const target = focusTo.current === null ? null : document.getElementById(focusTo.current);
    if (target !== null) {
      target.focus();
      focusTo.current = null;
    }
  });

  const onDirty = useCallback((n: number) => setChanges(n), []);
  const close = () => {
    setOpen(null);
    setChanges(0);
    setWaiting(false);
  };

  /**
   * Runs `action` now, or once the user agrees to lose the open form's
   * changes. A save waiting for its connection goes on when its form closes,
   * so ending that connection by switching or disconnecting asks about it.
   */
  const guarded = (action: () => void, ask: Pending) => {
    const unsaved = open !== null && changes > 0 && !waiting;
    if (unsaved || (waiting && ask.kind !== "open")) {
      initiator.current = document.activeElement as HTMLElement | null;
      setPending(ask);
    } else {
      action();
    }
  };

  const openForm = (next: Open) => {
    setOpen(next);
    setChanges(0);
    setWaiting(false);
    setFailure(undefined);
  };

  const run = async (action: () => Promise<unknown>) => {
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(failureOf(error).message);
    }
  };

  useImperativeHandle(ref, () => ({
    reset: (then) => guarded(then, { kind: "reset", then }),
  }));

  /**
   * Whether leaving Settings, closing the window or quitting asks: a form
   * holds unsaved changes, or a save waits for its connection.
   */
  const asks = (open !== null && changes > 0) || waiting;
  const asking = useRef(asks);
  /** Whether a question shows, which a quit leaves to be answered. */
  const showing = useRef(false);
  useEffect(() => {
    asking.current = asks;
  }, [asks]);
  // Every way out of Settings goes through the router: the header, the wordmark, links.
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname !== "/settings" || next.pathname === "/settings") return false;
      initiator.current = document.activeElement as HTMLElement | null;
      return true;
    },
    disabled: !asks,
    enableBeforeUnload: false,
    withResolver: true,
  });
  // Outside the app (plain `npm run dev`) there's no window to guard.
  useEffect(() => {
    if (inApp()) void desktopCommands.guard_quit({ guarded: asks }).catch(() => {});
  }, [asks]);
  useEffect(() => {
    if (!inApp()) return;
    const stop = listen(QUIT_EVENT, () => {
      // Answering at once tells the desktop the page is here to ask; one
      // that doesn't answer in 2 s quits anyway.
      void desktopCommands.guard_quit({ guarded: asking.current }).catch(() => {});
      if (!asking.current) {
        // Saved or canceled since the desktop asked: nothing is lost.
        void desktopCommands.quit_app().catch(() => {});
        return;
      }
      // A question already open stays, and its answer decides.
      if (showing.current) return;
      initiator.current = document.activeElement as HTMLElement | null;
      setPending({ kind: "quit" });
    }).catch(() => undefined);
    return () => {
      void desktopCommands.guard_quit({ guarded: false }).catch(() => {});
      // A test's IPC mock may be gone by the time the page unmounts.
      void stop.then((unlisten) => unlisten?.()).catch(() => {});
    };
  }, []);

  const setLaunch = useSetLaunch();
  const launch = list.data?.launch ?? null;
  const connect = (p: SavedPlatform) => void run(() => commands.connect(p.id));
  const disconnect = () => void run(() => commands.disconnect());
  const retry = () => void run(() => commands.retry());

  // Home's Edit lands here with the platform to open; the URL then drops it.
  const { edit, connect: connectTo } = useSearch({ from: "/settings" });
  const navigate = useNavigate();
  const [opened, setOpened] = useState<string | undefined>();
  if (edit !== undefined && edit !== opened && list.data !== undefined) {
    setOpened(edit);
    if (list.data.platforms.some((p) => p.id === edit)) openForm({ kind: "edit", id: edit });
  }
  useEffect(() => {
    if (edit !== undefined && edit === opened) {
      void navigate({ to: "/settings", hash: "platforms", search: {}, replace: true });
    }
  }, [edit, opened, navigate]);
  // ⌘K's Switch platform lands here to connect, asking first as Connect on its card does.
  useAsked(
    connectTo,
    list.data !== undefined,
    (id) => {
      const to = list.data?.platforms.find((p) => p.id === id);
      if (to !== undefined) guarded(() => connect(to), { kind: "switch", to });
    },
    () => void navigate({ to: "/settings", search: {}, replace: true }),
  );

  /** The question showing: leaving Settings, which the router holds, or what waits on it here. */
  const question: Pending | null =
    blocker.status === "blocked"
      ? {
          kind: "leave",
          doing: leavingWords(blocker.next, list.data?.platforms, "Leaving Settings"),
        }
      : pending;
  const asked = question !== null;
  useEffect(() => {
    showing.current = asked;
  }, [asked]);
  const answer = (discard: boolean) => {
    const ask = question;
    setPending(null);
    if (ask === null) return;
    if (!discard) {
      if (ask.kind === "leave") blocker.reset?.();
      initiator.current?.focus();
      return;
    }
    if (ask.kind === "leave") {
      close();
      blocker.proceed?.();
    } else if (ask.kind === "quit") {
      void desktopCommands.quit_app();
    } else if (ask.kind === "switch") {
      close();
      initiator.current?.focus();
      connect(ask.to);
    } else if (ask.kind === "disconnect") {
      close();
      initiator.current?.focus();
      disconnect();
    } else if (ask.kind === "reset") {
      close();
      ask.then();
    } else {
      openForm(ask.next);
    }
  };

  const nameOf = (id: string) => platforms.find((p) => p.id === id)?.name;
  const openName =
    open?.kind === "edit"
      ? nameOf(open.id)
      : open?.kind === "settings"
        ? `${nameOf(open.id)}’s Platform settings`
        : "the new platform";
  const live =
    connection.status === "connected" ||
    connection.status === "connecting" ||
    connection.status === "reconnecting";
  // The Platform settings form goes with its platform's connection.
  const settingsLive =
    open?.kind === "settings" &&
    connection.status !== "none" &&
    connection.platformId === open.id &&
    (connection.status === "connected" || connection.status === "reconnecting");
  if (open?.kind === "settings" && !settingsLive) close();

  return (
    <section id="platforms" className="platforms" aria-labelledby={SECTION_ID}>
      <div className="section-head">
        <h2 id={SECTION_ID} className="label" tabIndex={-1}>
          Compute platforms
        </h2>
        {list.data !== undefined && (
          <LaunchMenu
            platforms={platforms}
            launch={launch}
            launchSet={list.data.launch_set}
            onChange={(id) => void run(() => setLaunch(id))}
          />
        )}
        {open?.kind !== "add" && (
          <button
            type="button"
            id={ADD_ID}
            className="btn btn-sm"
            onClick={() =>
              guarded(() => openForm({ kind: "add" }), {
                kind: "open",
                next: { kind: "add" },
                nextName: undefined,
              })
            }
          >
            <PlusIcon />
            Add compute platform
          </button>
        )}
      </div>

      {list.data?.problem != null && (
        <div className="note-bad" role="alert">
          <p>{list.data.problem.reason}</p>
          {list.data.problem.moves_aside && (
            <p className="hint">
              Until it’s fixed, only This computer is listed. Saving a platform moves that file
              aside and starts a new one.
            </p>
          )}
          <p className="term fail-raw">{list.data.problem.details}</p>
        </div>
      )}
      {list.isError && (
        <div className="note-bad" role="alert">
          <p>{failureOf(list.error).message}</p>
        </div>
      )}
      {failure !== undefined && (
        <p className="field-issue" role="alert">
          {failure}
        </p>
      )}

      {open?.kind === "add" && (
        <SshFormCard
          liveElsewhere={live ? connection.platform : undefined}
          onDirty={onDirty}
          onCancel={() => {
            close();
            setFocusTo(ADD_ID);
          }}
          onSaved={(id) => {
            close();
            setFocusTo(headingId(id));
          }}
          onRemoved={close}
        />
      )}

      {platforms.map((p) => {
        const c = connectionOf(p, connection);
        const editing = open?.kind === "edit" && open.id === p.id;
        if (editing && p.type === "ssh") {
          return (
            <SshFormCard
              key={p.id}
              platform={p}
              connection={c}
              launch={launch === p.id}
              onDirty={onDirty}
              onCancel={() => {
                close();
                setFocusTo(editId(p.id));
              }}
              onSaved={() => {
                close();
                setFocusTo(headingId(p.id));
              }}
              onRemoved={() => {
                close();
                setFocusTo(SECTION_ID);
              }}
            />
          );
        }
        if (editing && p.type === "local") {
          return (
            <LocalFormCard
              key={p.id}
              platform={p}
              connection={c}
              onDirty={onDirty}
              onCancel={() => {
                close();
                setFocusTo(editId(p.id));
              }}
              onSaved={() => {
                close();
                setFocusTo(headingId(p.id));
              }}
            />
          );
        }
        const settings = { kind: "settings", id: p.id } as const;
        return (
          <PlatformCard
            key={p.id}
            platform={p}
            connection={c}
            launch={launch === p.id}
            onEdit={() =>
              guarded(() => openForm({ kind: "edit", id: p.id }), {
                kind: "open",
                next: { kind: "edit", id: p.id },
                nextName: p.name,
              })
            }
            onConnect={() => guarded(() => connect(p), { kind: "switch", to: p })}
            onDisconnect={() => guarded(disconnect, { kind: "disconnect" })}
            onRetry={retry}
            onUseThisComputer={(id) => {
              const here = platforms.find((x) => x.id === id);
              if (here !== undefined) guarded(() => connect(here), { kind: "switch", to: here });
            }}
          >
            {c !== undefined && (
              <PlatformSettings
                platform={p}
                connection={c}
                editing={open?.kind === "settings" && open.id === p.id}
                setupAllowed={open === null || (open.kind === "settings" && open.id === p.id)}
                onChange={() =>
                  guarded(() => openForm(settings), {
                    kind: "open",
                    next: settings,
                    nextName: `${p.name}’s Platform settings`,
                  })
                }
                onClose={() => {
                  close();
                  setFocusTo(changeSettingsId(p.id));
                }}
                onSetUp={() => {
                  if (open?.kind === "settings" && open.id === p.id) close();
                  setFocusTo(changeSettingsId(p.id));
                }}
                onSetupDirty={(n) => {
                  setOpen((now) => now ?? settings);
                  setChanges(n);
                }}
                onDirty={onDirty}
                onWaiting={setWaiting}
              />
            )}
          </PlatformCard>
        );
      })}

      {question !== null && (
        <ConfirmDialog
          title={TITLES[question.kind]}
          keep={waiting ? "Keep waiting" : "Keep editing"}
          confirm={CONFIRMS[question.kind]}
          onKeep={() => answer(false)}
          onConfirm={() => answer(true)}
        >
          {leaving(question, changes, openName, waiting)}
        </ConfirmDialog>
      )}
    </section>
  );
}

const TITLES: Record<Pending["kind"], string> = {
  switch: "Discard changes and switch?",
  disconnect: "Discard changes and disconnect?",
  reset: "Discard changes?",
  open: "Discard changes?",
  leave: "Discard changes and leave Settings?",
  quit: "Discard changes and quit ICMM?",
};

const CONFIRMS: Record<Pending["kind"], string> = {
  switch: "Discard and switch",
  disconnect: "Discard and disconnect",
  reset: "Discard changes",
  open: "Discard changes",
  leave: "Discard and leave",
  quit: "Discard and quit",
};

/** What leaving the open form loses: its unsaved changes, or a save waiting for its connection. */
function leaving(
  pending: Pending,
  changes: number,
  name: string | undefined,
  waiting: boolean,
): string {
  const to = name ?? "the platform";
  const one = changes <= 1;
  let doing: string;
  switch (pending.kind) {
    case "switch":
      doing = `Switching to ${pending.to.name}`;
      break;
    case "disconnect":
      doing = "Disconnecting";
      break;
    case "reset":
      doing = "Resetting ICMM";
      break;
    case "open":
      doing = pending.nextName !== undefined ? `Editing ${pending.nextName}` : "Adding a platform";
      break;
    case "leave":
      doing = pending.doing;
      break;
    case "quit":
      doing = "Quitting";
      break;
  }
  // Quitting ends only the app: the platform's runs go on without it.
  const runs = pending.kind === "quit" ? " Your runs keep going." : "";
  if (waiting) {
    const yours =
      changes === 0
        ? `Saving ${to} is`
        : one
          ? `Your change to ${to} is`
          : `Your ${changes} changes to ${to} are`;
    const it = changes > 1 ? "they" : "it";
    return `${yours} waiting for it to reconnect. ${doing} stops the wait, so ${it} may not be saved.${runs}`;
  }
  const unsaved = one
    ? `Your change to ${to} isn’t saved.`
    : `Your ${changes} changes to ${to} aren’t saved.`;
  return `${unsaved} ${doing} discards ${one ? "it" : "them"}.${runs}`;
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
