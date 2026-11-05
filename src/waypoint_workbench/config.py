"""Server configuration and repository paths."""

from __future__ import annotations

import sys
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_config(path: str | Path | None = None) -> dict:
    root = project_root()
    config_path = Path(path).resolve() if path else root / "config/server.toml"
    with config_path.open("rb") as stream:
        data = tomllib.load(stream)
    for kind in ("maps", "waypoints"):
        directory = Path(data["paths"][kind]).expanduser()
        data["paths"][kind] = (
            directory if directory.is_absolute() else root / directory
        ).resolve()
    data["web_dir"] = root / "web"
    port = data["server"]["port"]
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("Invalid port")
    return data
