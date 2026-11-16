"""SLURM: the one `SlurmCli` that runs its commands, and the lookup Platform setup fills from.

Every command runs with a timeout, as one cheap client call within the login node's budget
(ADR-0013). A read answers `None`, and an action `False`, when SLURM didn't answer: the command
failed, hung or isn't installed, so a cluster that won't say something leaves that part of the
lookup empty. `submit` raises `RefusedError` only for sbatch's own refusal, and
`SchedulerUnavailableError` otherwise. The scheduler's commands (the queue, accounting, a
launch's jobs) share one `SlurmCli` with no budget across them, since a coordinator calls them
for as long as it runs.
"""

from __future__ import annotations

import math
import re
import subprocess
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from icmm.scheduler import RefusedError, SchedulerUnavailableError
from icmm.wire.platform import Partition, SlurmJobDefaults, SlurmLookup

TIMEOUT_S = 10.0
ACCOUNTING_TIMEOUT_S = 30.0
"""`sacct` reads slurmdbd, which answers more slowly than the controller."""
SUBMIT_TIMEOUT_S = 30.0
"""`sbatch` waits for the controller to take the job."""
LOOKUP_BUDGET_S = 20.0
"""All of one lookup's commands together, well inside the desktop's 30 s wait for the reply."""

type Runner = Callable[..., subprocess.CompletedProcess[str]]

_REFUSED = "Batch job submission failed:"
"""What `sbatch` prints before the controller's own reason for turning a job away."""
_TRANSIENT = (
    "Socket timed out",
    "Unable to contact slurm controller",
    "temporarily unable to accept job",
    "Resource temporarily unavailable",
    "Zero Bytes were transmitted or received",
    "Communication connection failure",
    "standby mode",
    "Protocol authentication error",
    "Slurm controller not responding",
)
"""Failures of the controller or the link to it, which print after `_REFUSED` too: a retry may
get through, so none of them is a refusal."""
_JOB_ID_LINE = re.compile(r"(\d+)(?:;.*)?")
"""`sbatch --parsable`'s line: the job id, then `;cluster` on a federation."""
_ALREADY_GONE = ("Invalid job id specified", "already completing or completed")
"""What `scontrol` and `scancel` say of a job that is no longer there to change: nothing to do."""


DEFAULT_MAX_ARRAY_SIZE = 1001
"""The coordinator’s array-size fallback when SLURM’s config cannot be read."""


@dataclass(frozen=True)
class LiveTask:
    """A task the controller still holds, waiting or on a node: one row of `squeue -r`."""

    job_id: str
    """Its array's job id, or its own for a job that isn't an array."""
    task: int
    """Its index in the array; 0 for a job that isn't an array."""
    state: str
    """`squeue`'s own, such as PENDING or RUNNING."""
    reason: str
    """Why it waits; empty where `squeue` prints None."""
    node: str | None
    """None while it has none."""


@dataclass(frozen=True)
class AccountedTask:
    """A task as accounting records it: its allocation's row of `sacct`, its steps folded in."""

    job_id: str
    task: int
    state: str
    """The base state, without who ended it: `<state> by <uid>` is `<state>`."""
    exit_code: int | None
    """`ExitCode`'s `a:s` as a shell reports it: `a`, or 128 + `s` where `a` is 0 and `s` isn't."""
    node: str | None
    """None where it never started (`None assigned`)."""
    peak_memory_mb: int | None
    """The largest MaxRSS among its steps, rounded up."""
    step_out_of_memory: bool
    """One of its steps ended OUT_OF_MEMORY, whatever state the task itself took."""


class SlurmCli:
    """Runs SLURM's commands. Tests pass a `runner` that answers like `subprocess.run`."""

    def __init__(
        self,
        *,
        runner: Runner = subprocess.run,
        timeout_s: float = TIMEOUT_S,
        budget_s: float | None = LOOKUP_BUDGET_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Each command waits `timeout_s` at most, and all of them `budget_s` together, from
        now: one `SlurmCli` serves one request. `budget_s` None: no budget across commands,
        for a scheduler, whose coordinator calls them for as long as it runs."""
        self._runner = runner
        self._timeout_s = timeout_s
        self._clock = clock
        self._deadline = None if budget_s is None else clock() + budget_s

    def budgeted(self, budget_s: float) -> SlurmCli:
        """An independent request deadline over the same runner, timeout and clock."""
        return SlurmCli(
            runner=self._runner,
            timeout_s=self._timeout_s,
            budget_s=budget_s,
            clock=self._clock,
        )

    def associations(self, user: str) -> list[tuple[str, str]] | None:
        """`(account, qos)` per association of `user`."""
        rows = self._rows(
            ["sacctmgr", "-nP", "show", "assoc", "where", f"user={user}", "format=account,qos"]
        )
        return None if rows is None else [(r[0], r[1]) for r in rows if len(r) >= 2 and r[0]]

    def default_account(self, user: str) -> str | None:
        rows = self._rows(["sacctmgr", "-nP", "show", "user", user, "format=defaultaccount"])
        return rows[0][0] or None if rows else None

    def account_parents(self) -> dict[str, str] | None:
        """Each account's parent account, across the cluster."""
        rows = self._rows(
            ["sacctmgr", "-nP", "show", "assoc", "where", "user=", "format=account,parentname"]
        )
        return None if rows is None else {r[0]: r[1] for r in rows if len(r) >= 2 and r[1]}

    def qos_limits(self) -> dict[str, tuple[int | None, int | None]] | None:
        """Each QOS's `(MaxJobsPerUser, MaxTRESPerUser's cpu)`."""
        rows = self._rows(["sacctmgr", "-nP", "show", "qos", "format=name,maxjobspu,maxtrespu"])
        if rows is None:
            return None
        return {r[0]: (_int(r[1]), _tres_cpu(r[2])) for r in rows if len(r) >= 3}

    def partitions(self) -> list[dict[str, str]] | None:
        """Each partition's `key=value` fields, as `scontrol show partition -o` prints them."""
        out = self._out(["scontrol", "show", "partition", "-o"])
        if out is None:
            return None
        return [dict(_FIELD.findall(line)) for line in out.splitlines() if "PartitionName=" in line]

    def user_jobs(self, user: str) -> tuple[int, int]:
        """`(running, pending)`: the jobs of `user` the scheduler holds, each array task counted
        as the per-user limits count it; a job not waiting holds a place, so counts as running.
        `SchedulerUnavailableError` in squeue's own words, on one line, when it can't say."""
        done = self._run(["squeue", "-r", "-h", "-u", user, "-o", "%T"])
        if done is None:
            raise SchedulerUnavailableError("squeue didn't answer")
        if done.returncode != 0:
            said = " ".join(
                line.strip() for line in (done.stderr or "").splitlines() if line.strip()
            )
            raise SchedulerUnavailableError(said or f"squeue exited {done.returncode}")
        states = [line.strip() for line in done.stdout.splitlines() if line.strip()]
        pending = sum(state == "PENDING" for state in states)
        return len(states) - pending, pending

    def queue(self, job_ids: Sequence[str]) -> list[LiveTask] | None:
        """Each task of `job_ids` the controller still holds, with its state, reason and node.
        A job it no longer holds is off the queue, so `[]`; `None` where it didn't answer."""
        if not job_ids:
            return []
        done = self._run(
            ["squeue", "-h", "-a", "-r", f"--jobs={','.join(job_ids)}", "-o", "%i|%T|%r|%N"]
        )
        if done is None:
            return None
        if done.returncode != 0:
            return [] if "Invalid job id specified" in (done.stderr or "") else None
        return [
            LiveTask(
                row.job_id,
                task,
                row.fields[1],
                "" if row.fields[2] == "None" else row.fields[2],
                row.fields[3] or None,
            )
            for row in _job_rows(done.stdout, 4)
            for task in row.tasks
        ]

    def accounting(self, job_ids: Sequence[str]) -> list[AccountedTask] | None:
        """Accounting's record of each task of `job_ids`, ended or not; `None` where `sacct`
        didn't answer."""
        if not job_ids:
            return []
        done = self._run(
            [
                "sacct",
                "-n",
                "-P",
                "--array",  # Grouped task expressions can be truncated at 64 bytes.
                "--units=M",
                f"--jobs={','.join(job_ids)}",
                "--format=JobID,State,ExitCode,NodeList,MaxRSS",
            ],
            timeout_s=ACCOUNTING_TIMEOUT_S,
        )
        if done is None or done.returncode != 0:
            return None
        return _accounted(_job_rows(done.stdout, 5))

    def named(self, name: str) -> list[str] | None:
        """The job ids the queue or accounting (the last 30 days) knows by `name`, ascending;
        `None` where either didn't answer."""
        # %F is an array's job id, which sbatch printed; %A is each running task's own.
        queued = self._out(["squeue", "-h", "-a", f"--name={name}", "-o", "%F"])
        if queued is None:
            return None
        accounted = self._out(
            [
                "sacct",
                "-n",
                "-P",
                "--array",
                "-X",
                f"--name={name}",
                "-S",
                "now-30days",
                "--format=JobID",
            ],
            timeout_s=ACCOUNTING_TIMEOUT_S,
        )
        if accounted is None:
            return None
        ids = {int(line) for line in map(str.strip, queued.splitlines()) if line.isdecimal()}
        ids.update(int(row.job_id) for row in _job_rows(accounted, 1))
        return [str(job_id) for job_id in sorted(ids)]

    def max_array_size(self) -> int | None:
        """The cluster's `MaxArraySize`: the most tasks one array may have."""
        out = self._out(["scontrol", "show", "config"])
        match = None if out is None else re.search(r"^MaxArraySize\s*=\s*(\d+)", out, re.MULTILINE)
        return int(match.group(1)) if match else None

    def submit(self, options: Sequence[str], script: str) -> str:
        """Sends a batch job, its script on stdin; answers its job id. `RefusedError` in sbatch's
        words when SLURM won't take it as asked; `SchedulerUnavailableError` when it didn't
        answer, or answered so that it can't be told (a launch identity finds such a job later,
        ADR-0009)."""
        done = self._run(
            ["sbatch", "--parsable", *options], input=script, timeout_s=SUBMIT_TIMEOUT_S
        )
        if done is None:
            raise SchedulerUnavailableError("sbatch didn't answer")
        stderr = (done.stderr or "").strip()
        if done.returncode == 0:
            match = _JOB_ID_LINE.fullmatch((done.stdout or "").partition("\n")[0].strip())
            if match is None:
                raise SchedulerUnavailableError(f"sbatch printed no job id: {done.stdout!r}")
            return match.group(1)
        why = stderr.partition(_REFUSED)[2].strip()
        if any(marker in stderr for marker in _TRANSIENT) or not why:
            raise SchedulerUnavailableError(f"sbatch failed: {stderr or done.returncode}")
        raise RefusedError(why)

    def set_throttle(self, job_id: str, throttle: int) -> bool:
        """`scontrol update JobId=… ArrayTaskThrottle=…`; whether it answered. An array the
        controller no longer holds has nothing left to throttle, so that answers True."""
        if throttle < 1:
            raise ValueError(
                f"an array's throttle is at least 1, not {throttle}: SLURM reads 0 as unlimited"
            )
        done = self._run(["scontrol", "update", f"JobId={job_id}", f"ArrayTaskThrottle={throttle}"])
        return _answered(done)

    def cancel(self, job_ids: Sequence[str], *, waiting_only: bool) -> bool:
        """`scancel`, with `--state=PENDING` for `waiting_only`; whether it answered. Jobs
        already ended count as canceled."""
        if not job_ids:
            return True
        done = self._run(["scancel", *(["--state=PENDING"] if waiting_only else []), *job_ids])
        return _answered(done)

    def _rows(self, argv: list[str]) -> list[list[str]] | None:
        out = self._out(argv)
        return None if out is None else [line.split("|") for line in out.splitlines() if line]

    def _out(self, argv: list[str], *, timeout_s: float | None = None) -> str | None:
        done = self._run(argv, timeout_s=timeout_s)
        return done.stdout if done is not None and done.returncode == 0 else None

    def _run(
        self, argv: list[str], *, input: str | None = None, timeout_s: float | None = None
    ) -> subprocess.CompletedProcess[str] | None:
        """The finished command, whatever it answered; `None` where it couldn't run or wait
        (not installed, hung, or the budget spent). `timeout_s` replaces the usual timeout."""
        timeout = self._timeout_s if timeout_s is None else timeout_s
        if self._deadline is not None:
            timeout = min(timeout, self._deadline - self._clock())
        if timeout <= 0:
            return None
        options: dict[str, Any] = {"capture_output": True, "text": True, "check": False}
        if input is not None:
            options["input"] = input
        try:
            return self._runner(argv, timeout=timeout, **options)
        except (OSError, subprocess.SubprocessError):
            return None


_FIELD = re.compile(r"(\w+)=(\S*)")


def _answered(done: subprocess.CompletedProcess[str] | None) -> bool:
    """Whether the controller took the change: it exited 0, or said only that the job is no
    longer there to change."""
    if done is None:
        return False
    if done.returncode == 0:
        return True
    said = [line for line in (done.stderr or "").splitlines() if line.strip()]
    return bool(said) and all(any(gone in line for gone in _ALREADY_GONE) for line in said)


@dataclass(frozen=True)
class _Row:
    """One line of `squeue` or `sacct`, for the tasks its JobID names."""

    job_id: str
    tasks: tuple[int, ...]
    array: bool
    """Its JobID carries task indexes."""
    step: str | None
    """`batch`, `extern` or `0` for a step's row; `None` for a job's or task's own."""
    fields: tuple[str, ...]


_JOB_ID = re.compile(r"(\d+)(?:_(\d+|\[[^\]]+\]))?(?:\.(\w+))?")
_RANGE = re.compile(r"(\d+)(?:-(\d+)(?::(\d+))?)?")


def _job_rows(text: str, width: int) -> list[_Row]:
    """The `|`-separated rows of `text` with `width` fields whose first is a JobID: `123`
    (task 0), `123_4`, or `123_[0-3,7,9-11:2%4]`, each perhaps followed by `.batch` or another
    step. Others are skipped. A bare `123` row is dropped where other rows give tasks of `123`:
    it is the array they belong to."""
    rows: list[_Row] = []
    for line in text.splitlines():
        fields = tuple(field.strip() for field in line.split("|"))
        match = _JOB_ID.fullmatch(fields[0])
        if match is None or len(fields) < width:
            continue
        spec = match.group(2)
        tasks = (0,) if spec is None else _task_indexes(spec)
        if tasks is not None:
            rows.append(_Row(match.group(1), tasks, spec is not None, match.group(3), fields))
    arrays = {row.job_id for row in rows if row.array}
    return [row for row in rows if row.array or row.job_id not in arrays]


def _task_indexes(spec: str) -> tuple[int, ...] | None:
    """The indexes `4` or `[0-3,7,9-11:2%4]` name: ranges with their steps, the throttle
    dropped. `None` where it is neither."""
    if not spec.startswith("["):
        return (int(spec),)
    indexes: list[int] = []
    for part in re.sub(r"%\d+$", "", spec[1:-1]).split(","):
        match = _RANGE.fullmatch(part)
        if match is None:
            return None
        first = int(match.group(1))
        last = int(match.group(2) or first)
        step = int(match.group(3) or 1)
        if step < 1:
            return None
        indexes.extend(range(first, last + 1, step))
    return tuple(indexes)


def _accounted(rows: list[_Row]) -> list[AccountedTask]:
    """Each task's own row, with the largest MaxRSS of its steps and whether one of them ran
    out of memory."""
    peaks: dict[tuple[str, int], int] = {}
    ran_out: set[tuple[str, int]] = set()
    for row in rows:
        if row.step is None:
            continue
        memory = _megabytes(row.fields[4])
        for task in row.tasks:
            if memory is not None:
                peaks[row.job_id, task] = max(peaks.get((row.job_id, task), 0), memory)
            if _base_state(row.fields[1]) == "OUT_OF_MEMORY":
                ran_out.add((row.job_id, task))
    return [
        AccountedTask(
            row.job_id,
            task,
            _base_state(row.fields[1]),
            _exit_code(row.fields[2]),
            None if row.fields[3] in ("", "None assigned") else row.fields[3],
            peaks.get((row.job_id, task)),
            (row.job_id, task) in ran_out,
        )
        for row in rows
        if row.step is None
        for task in row.tasks
    ]


def _base_state(text: str) -> str:
    """The state without who ended it: `<state> by <uid>` is `<state>`."""
    words = text.partition(" by ")[0].split()
    return words[0] if words else ""


def _exit_code(text: str) -> int | None:
    """`ExitCode`'s `a:s`: the exit status `a`, or 128 + the signal `s` where a signal ended
    the task, as a shell reports it."""
    match = re.fullmatch(r"(\d+):(\d+)", text)
    if match is None:
        return None
    status, signal = int(match.group(1)), int(match.group(2))
    return 128 + signal if status == 0 and signal else status


_MEMORY = re.compile(r"(\d+(?:\.\d+)?)([KMGTP])")
_MEGABYTES_PER = {unit: Decimal(1024) ** power for power, unit in enumerate("KMGTP", start=-1)}


def _megabytes(text: str) -> int | None:
    """`sacct --units=M`'s MaxRSS, such as `512.25M`, in whole megabytes rounded up. Empty,
    zero and anything else have no value."""
    match = _MEMORY.fullmatch(text)
    if match is None:
        return None
    return math.ceil(Decimal(match.group(1)) * _MEGABYTES_PER[match.group(2)]) or None


def lookup(cli: SlurmCli, user: str) -> SlurmLookup:
    """The user's accounts, and the partitions they may use with their limits."""
    associations = cli.associations(user) or []
    accounts = list(dict.fromkeys(account for account, _ in associations))
    if not accounts:
        return SlurmLookup(
            max_array_size=cli.max_array_size() or DEFAULT_MAX_ARRAY_SIZE,
            accounts=[],
            default_account=None,
            partitions=[],
            default_partition=None,
        )
    default = cli.default_account(user)
    # Partitions first: without them the rest has nothing to add.
    listed = cli.partitions() or []
    parents = cli.account_parents() or {} if listed else {}
    limits = cli.qos_limits() or {} if listed else {}
    partitions: list[Partition] = []
    default_partition = None
    for fields in listed:
        if fields.get("State") != "UP" or fields.get("Hidden") == "YES":
            continue
        allowed = [a for a in accounts if _may_use(a, fields, parents)]
        if not allowed:
            continue
        jobs, cpus = limits.get(fields.get("QoS", ""), (None, None))
        partition = Partition(
            name=fields["PartitionName"],
            accounts=allowed,
            max_jobs_per_user=jobs,
            max_cpus_per_user=cpus,
            max_time_min=_minutes(fields.get("MaxTime", "")),
        )
        partitions.append(partition)
        if fields.get("Default") == "YES":
            default_partition = partition.name
    return SlurmLookup(
        max_array_size=cli.max_array_size() or DEFAULT_MAX_ARRAY_SIZE,
        accounts=accounts,
        default_account=default if default in accounts else None,
        partitions=partitions,
        default_partition=default_partition,
    )


def proposed_job_defaults(found: SlurmLookup) -> SlurmJobDefaults:
    """Platform setup's prefill: the lab's old job settings, with the account and partition
    SLURM would pick, the running-starts cap under the partition's per-user limits, and a day
    per start and 12 h for the coordinating job, each capped at the partition's longest."""
    if len(found.accounts) == 1:
        account = found.accounts[0]
    else:
        account = found.default_account
    partition = next(
        (
            p
            for p in found.partitions
            if p.name == found.default_partition and account in p.accounts
        ),
        None,
    )
    cpus = 2
    running = 16
    time_limit = 24 * 60
    coordinator_limit = 12 * 60
    if partition is not None:
        running = min(
            running,
            partition.max_jobs_per_user or running,
            (partition.max_cpus_per_user or cpus * running) // cpus,
        )
        longest = partition.max_time_min
        if longest:
            time_limit = min(time_limit, longest)
            coordinator_limit = min(coordinator_limit, longest)
    return SlurmJobDefaults(
        type="slurm",
        account=account,
        partition=partition.name if partition else None,
        cpus_per_start=cpus,
        memory_per_start_mb=4096,
        time_limit_per_start_min=time_limit,
        max_running_starts=max(1, running),
        excluded_nodes=[],
        run_coordinator_time_limit_min=coordinator_limit,
        check_for_results_every_s=5,
        container=None,
    )


def _may_use(account: str, fields: dict[str, Any], parents: dict[str, str]) -> bool:
    """Whether `account`, or an account above it, is allowed in and not denied."""
    lineage = [account]
    while (parent := parents.get(lineage[-1])) and parent not in lineage:
        lineage.append(parent)
    allow = fields.get("AllowAccounts", "ALL")
    deny = fields.get("DenyAccounts", "")
    if allow != "ALL" and not set(lineage) & set(allow.split(",")):
        return False
    return not set(lineage) & set(deny.split(",") if deny else [])


def _int(text: str) -> int | None:
    return int(text) if text.isdigit() else None


def _tres_cpu(text: str) -> int | None:
    match = re.search(r"(?:^|,)cpu=(\d+)", text)
    return int(match.group(1)) if match else None


_DURATION = re.compile(r"(?:(\d+)-)?(\d+):(\d+):(\d+)")


def _minutes(text: str) -> int | None:
    """`7-00:00:00` or `04:00:00` in minutes; `UNLIMITED` and anything else is `None`."""
    match = _DURATION.fullmatch(text)
    if match is None:
        return None
    days, hours, minutes, _ = (int(g or 0) for g in match.groups())
    return (days * 24 + hours) * 60 + minutes
