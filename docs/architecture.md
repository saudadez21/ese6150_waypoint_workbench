# Architecture

Waypoint Workbench consists of a browser frontend and an optional local Python File API.

## Frontend

The pages in `web/` are built with HTML, CSS, and JavaScript:

- `index.html` — Waypoint Editor
- `map-editor.html` — Map Editor
- `config.html` — Browser preferences and API connection

Each page uses a corresponding module in `web/js/` for UI events and editor state.

## Maps

`map_io.js` loads ROS YAML and map images from local files, ZIP archives, or the File API. Maps are represented by metadata and an array of occupancy values (`-1` for unknown, `0–100` for occupancy).

- `map_codec.js` converts between image pixels and occupancy values.
- `map_paint.js` handles map edits and Undo/Redo.
- `map_canvas.js` renders the map and handles drawing tools.
- `geometry.js` converts between image and world coordinates.
- `map_import.js` manages local file selection.

`map_io.js` also serializes edited maps for ZIP downloads or API uploads.

## Tracks

- `csv.js` parses and writes waypoint CSV files.
- `tracks.js` manages tracks, edits, and Undo/Redo.
- `waypoint_canvas.js` renders tracks and handles canvas interactions.
- `waypoints_page.js` connects track operations to the interface.

## Local File API

The optional Python service lives in `src/waypoint_workbench/`:

- `server.py` provides HTTP endpoints.
- `storage.py` reads and writes map and waypoint files, including backups.
- `config.py` loads server settings from `config/server.toml`.

The frontend communicates with the service through `web/js/api.js`.
