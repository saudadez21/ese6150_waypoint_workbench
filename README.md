# Waypoint Workbench

A browser-based toolkit for waypoint visualization, trajectory inspection, and ROS occupancy map editing, developed for F1TENTH (UPenn ESE6150).

## Features

- **Waypoint Editor**: Import, visualize, compare, and manually adjust CSV trajectories. Supports multiple tracks, speed visualization, and CSV export.
- **Map Editor**: Edit ROS occupancy maps using drawing tools and export YAML/image pairs as ZIP files.
- **Python File API**: Optional local server for loading, uploading, and backing up maps and waypoints.
- **ROS 2 Recorder**: Record waypoints from vehicle localization data.

## Run

The local server provides the frontend and File API at `http://127.0.0.1:6150`.

### With uv

```powershell
uv run python -m waypoint_workbench --port 6150
```

### Without uv

Requires Python and pip. Create a virtual environment and install the project:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m waypoint_workbench --port 6150
```

### Frontend Only

The frontend can also run without installing project dependencies. The File API is unavailable in this mode.

```powershell
python -m http.server 8000 -d web
```

Open [`http://127.0.0.1:8000`](http://127.0.0.1:8000) in a browser.

## Development

```powershell
uv sync --extra dev
uv run --extra dev python -m pre_commit install
uv run --extra dev python -m pre_commit run --all-files
uv run --extra dev pytest -q
node --test tests/*.mjs
```

## Documentation

API endpoints, file operations, and server permissions are documented in [docs/api.md](docs/api.md).
