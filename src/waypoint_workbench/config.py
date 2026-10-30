"""TOML configuration and repository-relative path resolution."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

# Editable source is <repo>/src/waypoint_workbench/
# For regular installed packages, also try the current working directory
ROOT = Path(__file__).resolve().parents[2]


def default_config_path() -> Path:
    """Find the default TOML configuration in the checkout or working directory."""
    for root in (ROOT, Path.cwd()):
        path = root / "config" / "default.toml"
        if path.is_file():
            return path

    raise FileNotFoundError(
        "Cannot find config/default.toml; run from the repository root or use --config"
    )


def load_config(path: str | Path | None = None) -> tuple[dict[str, Any], Path]:
    """Load paths and validate editor track colors before starting the server."""
    given = path or os.environ.get("WAYPOINT_WORKBENCH_CONFIG")
    file = Path(given).expanduser().resolve() if given else default_config_path()

    with file.open("rb") as handle:
        config = tomllib.load(handle)

    editor = config["editor"]
    limit = editor["max_tracks"]
    colors = editor["track_colors"]

    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError("editor.max_tracks must be a positive integer")
    if not isinstance(colors, list) or len(colors) < limit:
        raise ValueError("editor.track_colors needs at least max_tracks colors")
    if any(
        not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color)
        for color in colors
    ):
        raise ValueError("editor.track_colors must contain #RRGGBB hex colors")
    if len({color.lower() for color in colors}) != len(colors):
        raise ValueError("editor.track_colors must contain distinct colors")

    root = file.parent.parent
    for key in ("maps", "waypoints"):
        location = Path(config["paths"][key]).expanduser()
        config["paths"][key] = str((root / location).resolve())

    return config, root
