"""Local Flask backend for file I/O, maps, and clearance visualization."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory

from .config import load_config
from .core.csv_io import PRESETS, parse_csv
from .core.file_store import available_csvs, basic_csv, source_path, write_unique
from .core.geometry import as_points
from .core.map_io import MapRepository

WEB = Path(__file__).resolve().parent / "web"


def create_app(config=None):
    if config is None:
        config, _ = load_config()

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 27 * 1024 * 1024

    max_points = int(config["editor"]["max_points"])
    waypoint_dir = Path(config["paths"]["waypoints"])
    waypoint_dir.mkdir(parents=True, exist_ok=True)
    maps = MapRepository(config["paths"]["maps"])
    closure_limit = float(config["editor"]["closure_max_gap_m"])

    def payload():
        obj = request.get_json(silent=True)
        if not isinstance(obj, dict):
            raise ValueError("Expected a JSON object")
        return obj

    def points_of(obj):
        return as_points(obj.get("points"), max_points=max_points)

    def optional_data(obj, points):
        speed = obj.get("speed")

        if speed is not None:
            speed = np.asarray(speed, dtype=float)
            if (
                speed.shape != (len(points),)
                or not np.isfinite(speed).all()
                or np.any(speed < 0)
            ):
                raise ValueError("Invalid speed array")

        return speed

    @app.errorhandler(ValueError)
    def invalid(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(413)
    def too_large(_exc):
        return jsonify(error="Upload too large"), 413

    @app.get("/")
    def home():
        response = send_from_directory(WEB, "index.html")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/web/<path:name>")
    def static_web(name):
        response = send_from_directory(WEB, name)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/bootstrap")
    def bootstrap():
        return jsonify(
            config={key: value for key, value in config.items() if key != "paths"},
            default_map=config["paths"]["default_map"],
            default_waypoint=config["paths"]["default_waypoint"],
            maps=maps.list_maps(),
            waypoints=available_csvs(waypoint_dir),
            presets=PRESETS,
        )

    @app.get("/api/maps")
    def map_list():
        return jsonify(maps=maps.list_maps())

    @app.get("/api/waypoints")
    def waypoint_list():
        return jsonify(files=available_csvs(waypoint_dir))

    @app.post("/api/waypoints/load")
    def waypoint_load():
        obj = payload()
        file = source_path(waypoint_dir, str(obj["filename"]))
        parsed = parse_csv(
            file.read_text(encoding="utf-8-sig"),
            preset=obj.get("preset", "auto"),
            max_points=max_points,
        )
        return jsonify(**parsed, filename=str(file.relative_to(waypoint_dir)))

    @app.post("/api/waypoints/import")
    def waypoint_import():
        """Validate first, then persist browser-imported CSV in waypoints/."""
        obj = payload()
        name = obj.get("filename")
        content = obj.get("text")
        if not isinstance(name, str) or not name.lower().endswith((".csv", ".txt")):
            raise ValueError("Please import a CSV or text waypoint file")
        if not isinstance(content, str) or len(content.encode("utf-8")) > 5_000_000:
            raise ValueError("CSV file is invalid or exceeds 5 MB")

        parsed = parse_csv(
            content,
            preset=obj.get("preset", "auto"),
            max_points=max_points,
        )
        stored = write_unique(waypoint_dir, name, content)
        return jsonify(**parsed, filename=stored)

    @app.get("/api/maps/<path:id>")
    def map_meta(id):
        return jsonify(maps.meta(id))

    @app.get("/api/maps/image/<path:id>")
    def map_image(id):
        return send_file(io.BytesIO(maps.image_png(id)), mimetype="image/png")

    @app.post("/api/maps/upload")
    def map_upload():
        yaml = request.files.get("yaml")
        image = request.files.get("image")
        if yaml is None or image is None:
            raise ValueError("Provide YAML and image together")
        map_id = maps.import_pair(
            yaml.filename,
            yaml.read(),
            image.filename,
            image.read(),
        )
        return jsonify(maps.meta(map_id))

    @app.post("/api/validate")
    def validate_route():
        obj = payload()
        points = points_of(obj)
        threshold = float(config["vehicle"]["width_m"]) / 2 + float(
            config["clearance"]["safety_margin_m"]
        )
        return jsonify(
            maps.validate(
                obj["map_id"],
                points,
                threshold_m=threshold,
                closure_limit_m=closure_limit,
                unknown_is_obstacle=config["clearance"]["unknown_is_obstacle"],
            )
        )

    @app.post("/api/waypoints/save")
    def waypoint_save():
        """Save current working geometry/data to a NEW CSV; never overwrite."""
        obj = payload()
        points = points_of(obj)
        speed = optional_data(obj, points)
        text = basic_csv(points, speed)
        filename = write_unique(waypoint_dir, obj.get("filename", "waypoints"), text)
        return jsonify(filename=filename)

    return app
