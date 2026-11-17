"""The protocol version. The desktop refuses an agent whose `major.minor` differs.

Any change to the wire schema bumps it: `wire/wire.lock.json` records the protocol with its schema
hash, and `icmm-wire gen` (which the gate's `wire` step runs) refuses a schema that changed
since `main` at the protocol `main` has.
"""

PROTOCOL_VERSION = "1.63"
