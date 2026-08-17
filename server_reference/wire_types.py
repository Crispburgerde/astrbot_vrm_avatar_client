"""Shared wire-protocol types shared across the plugin."""

from pydantic import BaseModel


class FilePayload(BaseModel):
    """A file embedded as a base64 data payload."""

    filename: str
    data: str
