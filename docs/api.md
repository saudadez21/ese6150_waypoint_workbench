# Python File API

The Python host serves `web/` and `/api/` on port `6150` by default. Configuration is stored in `config/server.toml`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Connection status and permissions |
| GET | `/api/maps` | List maps |
| GET | `/api/maps/{name}/bundle` | Read YAML, image, and ETag |
| POST | `/api/maps/{name}` | Create map (multipart YAML + image) |
| PUT | `/api/maps/{name}` | Replace map with `If-Match` |
| GET | `/api/waypoints` | List CSV files |
| GET | `/api/waypoints/{name}` | Read CSV and ETag |
| POST | `/api/waypoints/{name}` | Create CSV (JSON `text`) |
| PUT | `/api/waypoints/{name}` | Replace CSV with `If-Match` |

Uploads occur only after an explicit browser action. Existing files are compared before replacement; matching content is not uploaded again.

Responses use `403` for disabled operations, `409` for existing names, `412` for changed files, and `428` for missing `If-Match`. Replacements preserve the active filename and create timestamped backups: CSV in `waypoints/.backups/`, map ZIP in `maps/.backups/`. Delete is not supported.

The server binds to `127.0.0.1` by default. Replacement permissions are disabled by default. The development server is not intended for public Internet exposure.

Map replacement writes two files separately and uses rollback on failure.
