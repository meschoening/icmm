/**
 * Submit run's Config section (LaptopSubmitRun): the config a run would fit,
 * as it was last saved, with Edit config and Change… (which opens the
 * picker). Readable, it shows every setting a run is made from; a config a
 * newer ICMM saved, one that can't be read, or one that's gone says so in
 * place of them; none on the platform invites making one.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Which } from "../configs/ConfigDetail";
import { UnreadableBox } from "../configs/UnreadableBox";
import { bound, whole } from "../configs/words";
import { newerWords } from "../newer";
import { FailureBox } from "../setup/FailureBox";
import { Reading } from "../setup/PlatformSetup";
import { inSentence } from "../setup/form";
import { useBlocker } from "../ui/blocker";
import { besideProps, type Working } from "../ui/working";
import type { ConfigCheck, ConfigSummary, SavedConfig, SavedPlatform } from "../wire/types.gen";
import { plural } from "./estimate";
import { PICKER_ID, Picker } from "./Picker";
import { RunStatus } from "./RunStatus";
import type { Shown } from "./shown";

type Platform = Pick<SavedPlatform, "type" | "name">;

/** What the card waits on, said by what needs the platform. */
const OFFLINE = "Opens once you’re connected";

/** Why Edit config can't open the config in the builder, if it can't. */
function editWhy(live: boolean, shown: Shown): string | undefined {
  if (!live) return OFFLINE;
  switch (shown.kind) {
    case "loading":
      return `Waiting for ${shown.name} to load`;
    case "failed":
      return `ICMM couldn’t read ${shown.name}`;
    case "unreadable":
      return shown.error.data.problem === "newer"
        ? newerWords(shown.name)
        : `ICMM can’t read ${shown.name}.`;
    default:
      return undefined;
  }
}

export interface ConfigCardProps {
  platform: Platform;
  /** The connection is up, or reconnecting: what needs the agent can be asked. */
  live: boolean;
  shown: Shown;
  /** The platform's configs, for the picker and the run status. */
  configs: ConfigSummary[];
  /** The config shown. */
  id: string | undefined;
  /** How many protocols its dataset has. */
  protocols: number | undefined;
  /** The engine's counts for it, as read while connected. */
  counts: ConfigCheck | undefined;
  now: number;
  /** Submit run's: while a submit is under way, nothing here can take the page elsewhere. */
  working: Working;
  /** Reads the config again, for a failed read's Try again. */
  onRetry: () => Promise<unknown>;
  /** When that retry last failed the same way. */
  again: number | undefined;
}

export function ConfigCard({
  platform,
  live,
  shown,
  configs,
  id,
  protocols,
  counts,
  now,
  working,
  onRetry,
  again,
}: ConfigCardProps) {
  const navigate = useNavigate();
  const change = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  // The picker needs the platform's configs, and the config shown can't change while a run is
  // made of it. When it can't show, it's closed, so it isn't open again when it can.
  if (picking && (!live || working.pending)) setPicking(false);
  const open = picking;
  const offline = useBlocker(live ? undefined : OFFLINE);
  const editing = useBlocker(editWhy(live, shown));

  const close = useCallback((refocus: boolean) => {
    setPicking(false);
    if (refocus) change.current?.focus();
  }, []);
  const pick = (to: string) => {
    setPicking(false);
    if (to !== id) void navigate({ to: "/runs/submit", search: { config: to }, replace: true });
    change.current?.focus();
  };

  if (shown.kind === "none") return <Empty platform={platform} offline={!live} />;
  const listed = configs.find((c) => c.id === id);
  const gone = shown.kind === "not_found";

  return (
    <div className="sub-card">
      <div className="sub-card-top">
        <div className="sub-card-head">
          {gone ? (
            <span className="sub-gone">This config isn’t on {inSentence(platform)} any more.</span>
          ) : (
            <>
              <span className="mono sub-name">{shown.name}</span>
              <RunStatus run={listed?.latest_run ?? null} now={now} />
            </>
          )}
          <span className="sub-spacer" />
          <div className="sub-card-actions">
            {!gone && id !== undefined && (
              <>
                <Link
                  to="/configs/$id/edit"
                  params={{ id }}
                  className="btn"
                  {...editing.props}
                  {...besideProps(working)}
                >
                  Edit config
                </Link>
                {editing.bubble}
              </>
            )}
            <button
              ref={change}
              type="button"
              className="btn"
              aria-expanded={open}
              aria-controls={PICKER_ID}
              {...offline.props}
              {...besideProps(working)}
              onClick={(e) => {
                offline.props.onClick(e);
                if (live) setPicking(!open);
              }}
            >
              Change…
            </button>
            {offline.bubble}
          </div>
        </div>
        {/* Under the head, wherever it wraps to, and next to Change… for Tab. */}
        {open && (
          <Picker
            configs={configs}
            chosen={id}
            platform={platform}
            now={now}
            onPick={pick}
            onClose={close}
            change={change}
          />
        )}
      </div>
      <Body
        shown={shown}
        platform={platform}
        protocols={protocols}
        counts={counts}
        working={working}
        onRetry={onRetry}
        again={again}
      />
    </div>
  );
}

/** What the card holds under its head. */
function Body({
  shown,
  platform,
  protocols,
  counts,
  working,
  onRetry,
  again,
}: Pick<ConfigCardProps, "platform" | "protocols" | "counts" | "working" | "onRetry" | "again"> & {
  shown: Shown;
}) {
  switch (shown.kind) {
    case "ready":
      return (
        <Settings saved={shown.saved} protocols={protocols} counts={counts} working={working} />
      );
    case "loading":
      return (
        <Reading>
          {/* One flex item, so the name sits in the sentence. */}
          <span>
            Reading <span className="mono">{shown.name}</span> on {inSentence(platform)}…
          </span>
        </Reading>
      );
    case "failed":
      return (
        <FailureBox
          error={shown.error}
          task={shown.task}
          platform={platform}
          onRetry={onRetry}
          again={again}
        />
      );
    case "unreadable":
      return shown.error.data.problem === "newer" ? (
        <p className="hint sub-newer">
          Saved by a newer ICMM, so this version can’t read its settings.
        </p>
      ) : (
        <UnreadableBox
          name={shown.name}
          error={shown.error}
          next={
            shown.error.data.problem === "damaged" ? (
              <>
                Choose another with Change…, or delete it on{" "}
                <Link to="/configs" className="link" {...besideProps(working)}>
                  Configs
                </Link>{" "}
                and make it again.
              </>
            ) : undefined
          }
        />
      );
    default:
      return null;
  }
}

/** None on the platform: what a config is, and the way to make one. */
function Empty({ platform, offline }: { platform: Platform; offline: boolean }) {
  const blocker = useBlocker(offline ? OFFLINE : undefined);
  return (
    <div className="sub-empty">
      <p>
        None on {platform.name} yet. A config holds what a run fits: a dataset, how many states to
        try and how hard to search. Make one, then submit it here.
      </p>
      <Link to="/configs/new" className="btn" {...blocker.props}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        New config
      </Link>
      {blocker.bubble}
    </div>
  );
}

/** Data, Topology and Optimization, as Configs words them (LaptopSubmitRun's 9fr | 11fr). */
function Settings({
  saved,
  protocols,
  counts,
  working,
}: {
  saved: SavedConfig;
  protocols: number | undefined;
  counts: ConfigCheck | undefined;
  working: Working;
}) {
  const { config, dataset } = saved;
  const { search, bounds, topology } = config;
  return (
    <>
      <div className="sub-settings">
        <div className="sub-col">
          <Group title="Data" short>
            <Kv k="Dataset">
              {dataset.deleted ? (
                <>
                  <span className="mono sub-v">{dataset.name ?? dataset.id}</span>
                  <span className="sub-dim"> deleted</span>
                </>
              ) : (
                <>
                  <Link
                    to="/datasets/$id"
                    params={{ id: dataset.id }}
                    className="link mono sub-v"
                    {...besideProps(working)}
                  >
                    {dataset.name ?? dataset.id}
                  </Link>
                  {protocols !== undefined && (
                    <span className="sub-dim"> · {plural(protocols, "protocol", "protocols")}</span>
                  )}
                </>
              )}
            </Kv>
          </Group>
          <Group title="Topology" short>
            <Kv k="States">
              <span className="mono sub-v">{topology.num_states ?? "—"}</span>
            </Kv>
            <Kv k="Which">
              <Which saved={saved} kept={counts} />
            </Kv>
          </Group>
        </div>
        <Group title="Optimization">
          <Kv k="Starts per topology">
            <span className="mono sub-v">{whole(search.starts_per_topology)}</span>
          </Kv>
          <Kv k="Population size">
            <span className="mono sub-v">{whole(search.population)}</span>
          </Kv>
          <Kv k="Evaluations">
            <span className="mono sub-v">{whole(search.evaluation_budget)}</span>{" "}
            <span className="sub-dim">per start</span>
          </Kv>
          <Kv k="Log every">
            <span className="mono sub-v">{whole(search.log_every_generations)}</span>{" "}
            {search.log_every_generations === 1 ? "generation" : "generations"}
          </Kv>
          <Kv k="Search seed">
            {search.search_seed === null ? (
              <span className="sub-quiet">drawn at submit</span>
            ) : (
              <span className="mono sub-v">{search.search_seed}</span>
            )}
          </Kv>
          <Kv k="Start points">{search.sobol_start_points ? "Sobol" : "at random"}</Kv>
          {/* The ranges alone: Max chose to keep #41's "ln units" and its Midpoints line out of
              these two rows (2026-10-24). */}
          <Kv k="Parameter bounds">
            <span className="mono sub-v">{bound(bounds.rate_min)}</span> to{" "}
            <span className="mono sub-v">{bound(bounds.rate_max)}</span>
          </Kv>
          <Kv k="Voltage dependence bounds">
            <span className="mono sub-v">{bound(bounds.sigmoid_min_mV)}</span> to{" "}
            <span className="mono sub-v">{bound(bounds.sigmoid_max_mV)}</span>
            {"\u00a0"}mV
          </Kv>
        </Group>
      </div>
      <p className="hint sub-foot">
        To change any of these, edit the config, then choose Save and submit…
      </p>
    </>
  );
}

function Group({
  title,
  short,
  children,
}: {
  title: string;
  /** A narrow label column. */
  short?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`sub-group${short ? " short" : ""}`}>
      <h3 className="label">{title}</h3>
      <dl>{children}</dl>
    </div>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="sub-kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
