"""The **Coordinator** (ADR-0019): the one process that carries a **Run**, on either scheduler.

`sweep` is the coordinator itself, `window` its rolling window, and `files` where a run's files go
in its Output folder. This package imports nothing itself, so the agent can name a run's files
without loading what a coordinator runs.
"""
