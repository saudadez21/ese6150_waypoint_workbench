"""Start the local web and file server."""

from __future__ import annotations

import argparse

from .config import load_config
from .server import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Waypoint Workbench")
    parser.add_argument("--config", help="Server TOML file")
    parser.add_argument("--host", help="Bind address")
    parser.add_argument("--port", type=int, help="Port")
    args = parser.parse_args()
    settings = load_config(args.config)
    host = args.host or settings["server"]["host"]
    port = args.port or settings["server"]["port"]
    print(f"http://{host}:{port}")
    create_app(settings).run(host=host, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
