"""Run with `uv run python -m waypoint_workbench` or `python -m waypoint_workbench`."""

import argparse

from .config import load_config
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Local F1TENTH waypoint editor")
    parser.add_argument("--config", help="Path to TOML configuration")
    parser.add_argument("--host", help="Bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    config, _ = load_config(args.config)
    app = create_app(config)
    host = args.host or config["server"]["host"]
    port = args.port or config["server"]["port"]
    app.run(host=host, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
