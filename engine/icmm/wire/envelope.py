"""The envelope every line travels in (ADR-0009), and the line cap.

Requests are `{id, method, params}`, replies `{id, result}` or `{id, error}`, and events
`{subscription, event}`, one JSON object per line. The envelope is generic over the method, so
each language writes it by hand; only the types inside it come from the schema.
"""

MAX_LINE_BYTES = 16 * 1024 * 1024
"""The longest line either side sends or accepts, its newline included."""
