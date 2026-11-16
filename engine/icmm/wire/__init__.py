"""The wire: every type the agent and the desktop exchange, and the registry of methods.

These pydantic models are the one source. `icmm.wire.codegen` exports them as a JSON Schema
bundle (`wire/`) and generates the Rust and TS types, the Tauri commands and their ACL from it.
The agent's start path imports this package, so it imports only stdlib and pydantic.
"""

from icmm.wire.errors import ErrorCode, WireError
from icmm.wire.methods import METHODS, Method
from icmm.wire.version import PROTOCOL_VERSION

__all__ = ["METHODS", "PROTOCOL_VERSION", "ErrorCode", "Method", "WireError"]
