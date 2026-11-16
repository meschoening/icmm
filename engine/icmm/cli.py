"""The engine's command line. `icmm agent --serve --data-folder <path>` is the agent (ADR-0009);
`icmm host --serve` is the host engine, the desktop's own (ADR-0013); `icmm run-start` runs one
start in a job, or an array's task (ADR-0008); `icmm coordinate` carries a run as its
coordinator (ADR-0019); `icmm recover` relaunches This computer's runs whose coordinator is gone,
at every launch of ICMM (ADR-0019); `icmm cleanup` removes deleted runs and ends canceling runs
no coordinator carries (ADR-0020); `icmm selfcheck` proves an installed engine runs.

The agent's start path imports only stdlib, pydantic and `icmm.wire`, so each command imports
what it needs when it runs.
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="icmm")
    commands = parser.add_subparsers(dest="command", required=True)
    agent = commands.add_parser("agent", help="serve the desktop on stdin and stdout")
    agent.add_argument("--serve", action="store_true", required=True)
    agent.add_argument("--data-folder", required=True, help="the platform's data folder")
    host = commands.add_parser("host", help="serve the desktop's own computation")
    host.add_argument("--serve", action="store_true", required=True)
    host.add_argument(
        "--idle-timeout-s", type=float, help="exit after this long with no request (600 s)"
    )
    start = commands.add_parser("run-start", help="run one start and write its log and result")
    which = start.add_mutually_exclusive_group(required=True)
    which.add_argument("--job", help="the start's job, as JSON")
    which.add_argument("--array", help="an array's job, as JSON, whose task --task names")
    start.add_argument("--task", type=_task, help="the array task to run, from 0")
    start.add_argument(
        "--threads",
        type=_threads,
        help="threads to score with (SLURM_CPUS_PER_TASK, else every CPU)",
    )
    start.add_argument("--libicmm", help="the core to load (this engine's own)")
    start.add_argument("--lists", help="the topology lists' folder (this engine's own)")
    start.add_argument(
        "--stop-file", help="end as canceled once this file appears (This computer's cancel)"
    )
    coordinate = commands.add_parser("coordinate", help="carry a run as its coordinator")
    coordinate.add_argument("--data-folder", required=True, help="the platform's data folder")
    coordinate.add_argument("--run", type=int, required=True, help="the run's number")
    coordinate.add_argument(
        "--generation", type=int, required=True, help="this coordinator's generation, from 1"
    )
    coordinate.add_argument(
        "--time-limit-min",
        type=int,
        help="its job's time limit, before which it hands on to its successor",
    )
    recover = commands.add_parser(
        "recover", help="relaunch This computer's runs whose coordinator is gone"
    )
    recover.add_argument("--data-folder", required=True, help="the platform's data folder")
    cleanup = commands.add_parser(
        "cleanup", help="remove deleted runs, and end canceling runs no coordinator carries"
    )
    cleanup.add_argument("--data-folder", required=True, help="the platform's data folder")
    commands.add_parser("selfcheck", help="load every module and the core; print one JSON line")
    args = parser.parse_args(argv)
    if args.command == "run-start" and (args.array is None) != (args.task is None):
        parser.error("--array and --task go together")

    if args.command == "agent":
        from icmm.agent import run

        run(args.data_folder)
    if args.command == "host":
        from icmm.host import run as host

        host(args.idle_timeout_s)
    if args.command == "run-start":
        from icmm.start import main as run_start

        return run_start(
            args.job,
            array=args.array,
            task=args.task,
            threads=args.threads,
            libicmm=args.libicmm,
            lists=args.lists,
            stop_file=args.stop_file,
        )
    if args.command == "coordinate":
        from icmm.coordinator.sweep import main as coordinate

        return coordinate(args.data_folder, args.run, args.generation, args.time_limit_min)
    if args.command == "recover":
        from icmm.coordinator.recover import main as recover

        return recover(args.data_folder)
    if args.command == "cleanup":
        from icmm.cleanup import main as cleanup

        return cleanup(args.data_folder)
    if args.command == "selfcheck":
        from icmm.selfcheck import main as selfcheck

        return selfcheck()
    parser.error(f"unknown command {args.command}")
    return 2


def _task(text: str) -> int:
    task = int(text)
    if task < 0:
        raise argparse.ArgumentTypeError("counts from 0")
    return task


def _threads(text: str) -> int:
    threads = int(text)
    if threads < 1:
        raise argparse.ArgumentTypeError("needs at least 1")
    return threads


if __name__ == "__main__":
    sys.exit(main())
