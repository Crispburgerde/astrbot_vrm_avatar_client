"""Performance model and LLM output parsing.

The LLM emits a single free-form response in which tags may appear anywhere:

- ``[expression]`` is **sticky**: it sets the current expression, which stays
  in effect until the next ``[expression]`` tag appears.
- ``<action>`` triggers a registered animation by name. The action is
  momentary: it plays once and then the avatar returns to idle.
- Any other text is dialogue spoken by the avatar.

Rather than pre-flattening these into per-segment records (which hides the
state machine inside the parser), the parsed result is kept as an ordered
**event stream**: a flat list of ``TextChunk`` / ``ExpressionTag`` /
``ActionTag`` events. Consumers walk the stream and track any state they
need (e.g., the sticky expression) themselves.
"""

import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from astrbot.api import logger

from .wire_types import FilePayload

# --- Event types ----------------------------------------------------------


class TextChunk(BaseModel):
    """A stretch of plain dialogue text.

    ``audio`` is filled by the TTS step after parsing; it is ``None`` until
    then. Each text chunk maps to at most one TTS clip.
    """

    kind: Literal["text"] = "text"
    content: str
    audio: FilePayload | None = None


class ExpressionTag(BaseModel):
    """A sticky ``[expression]`` marker — sets the current expression until
    the next expression tag appears."""

    kind: Literal["expression"] = "expression"
    name: str


class ActionTag(BaseModel):
    """An ``<action>`` marker that triggers a registered animation by name."""

    kind: Literal["action"] = "action"
    name: str


# Discriminated union so pydantic can (de)serialize the event stream while
# preserving each event's concrete type.
PerformanceEvent = Annotated[
    TextChunk | ExpressionTag | ActionTag,
    Field(discriminator="kind"),
]


# --- Performance container ------------------------------------------------


class Performance(BaseModel):
    """One parsed LLM response, represented as an ordered event stream.

    Tags may appear anywhere in the source text; here they are emitted as
    events in the same order they were encountered. Walk the stream to
    reconstruct any higher-level segmentation (e.g., sticky expression
    state) the consumer needs.
    """

    events: list[PerformanceEvent]


# --- Parser ---------------------------------------------------------------


# Matches either an ``[expression]`` tag or an ``<action>`` tag.
_TAG_PATTERN = re.compile(r"\[(?P<expr>[^\[\]]+)\]|<(?P<action>[^<>]+)>")


def parse_performance(text: str) -> Performance | None:
    """Parse free-form text with inline ``[expression]`` and ``<action>`` tags
    into an ordered event stream.

    Plain text between/around tags is emitted as :class:`TextChunk` events
    (whitespace-only stretches are dropped). A surrounding Markdown code
    fence (```` ``` ````) is tolerated and stripped before parsing.

    Args:
        text: The raw LLM output text.

    Returns:
        A :class:`Performance` containing the parsed event stream, or
        ``None`` when nothing could be parsed.
    """
    # Tolerate a wrapped code fence (``` ... ``` or ```text ... ```).
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = re.sub(r"\n?```\s*$", "", stripped)

    events: list[PerformanceEvent] = []
    pos = 0
    for match in _TAG_PATTERN.finditer(stripped):
        if match.start() > pos:
            chunk = stripped[pos : match.start()]
            if chunk.strip():
                events.append(TextChunk(content=chunk.strip()))
        if match.group("expr") is not None:
            events.append(ExpressionTag(name=match.group("expr").strip()))
        else:
            events.append(ActionTag(name=match.group("action").strip()))
        pos = match.end()

    tail = stripped[pos:]
    if tail.strip():
        events.append(TextChunk(content=tail.strip()))

    if not events:
        logger.warning("[Performance] 未能从输出中解析出任何事件")
        return None
    return Performance(events=events)
