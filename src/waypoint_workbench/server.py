"""Static frontend and optional local file API."""

from __future__ import annotations

import base64
import os
from pathlib import Path

from flask import Flask, Response, jsonify, request

from .config import load_config
from .storage import (
    AlreadyExists,
    VersionConflict,
    etag_for,
    list_maps,
    list_waypoints,
    read_map,
    read_waypoint,
    save_map,
    save_waypoint,
)


def create_app(settings: dict | None = None) -> Flask:
    settings = settings or load_config()
    web = Path(settings["web_dir"])
    maps = Path(settings["paths"]["maps"])
    waypoints = Path(settings["paths"]["waypoints"])
    maps.mkdir(parents=True, exist_ok=True)
    waypoints.mkdir(parents=True, exist_ok=True)
    permissions = settings["permissions"]
    allowed = set(settings["security"].get("allowed_origins", []))
    token = os.environ.get(
        settings["security"].get("token_env", "WAYPOINT_WORKBENCH_TOKEN"), ""
    )

    # Flask serves every web asset, including /map-editor.html and /config.html.
    app = Flask(__name__, static_folder=str(web), static_url_path="")
    app.config["MAX_CONTENT_LENGTH"] = settings["limits"]["max_upload_mb"] * 1024**2

    @app.get("/")
    def home():
        return app.send_static_file("index.html")

    @app.errorhandler(ValueError)
    def bad_request(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(AlreadyExists)
    def already_exists(error):
        return jsonify(error=str(error)), 409

    @app.errorhandler(VersionConflict)
    def stale(error):
        return jsonify(error=str(error)), 412

    @app.errorhandler(FileNotFoundError)
    def not_found(_error):
        return jsonify(error="File not found"), 404

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify(error="File too large"), 413

    @app.after_request
    def headers(response):
        origin = request.headers.get("Origin")
        if origin in allowed:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = (
                "Authorization, Content-Type, If-Match"
            )
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
            response.headers["Access-Control-Allow-Private-Network"] = "true"
            response.headers["Vary"] = "Origin"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.before_request
    def guard():
        if not request.path.startswith("/api/"):
            return None
        origin = request.headers.get("Origin")
        own_origin = f"{request.scheme}://{request.host}"
        if origin and origin != own_origin and origin not in allowed:
            return jsonify(error="Origin not allowed"), 403
        if request.method == "OPTIONS":
            return Response(status=204)
        if request.method in ("POST", "PUT"):
            if not request.is_json and request.mimetype != "multipart/form-data":
                return jsonify(error="Unsupported content type"), 415
            remote = request.remote_addr not in ("127.0.0.1", "::1")
            cross_origin = bool(origin and origin != own_origin)
            if (remote or cross_origin) and (
                not token or request.headers.get("Authorization") != f"Bearer {token}"
            ):
                return jsonify(error="API write token required"), 403
        return None

    @app.get("/api/health")
    def health():
        return jsonify(
            status="ok", service="waypoint_workbench", capabilities=permissions
        )

    @app.get("/api/waypoints")
    def waypoint_list():
        return jsonify(files=list_waypoints(waypoints))

    @app.get("/api/waypoints/<name>")
    def waypoint_get(name):
        blob, etag = read_waypoint(waypoints, name)
        return Response(blob, mimetype="text/csv", headers={"ETag": etag})

    def save_csv(name: str, expected: str | None):
        permission = "waypoint_replace" if expected is not None else "waypoint_create"
        if not permissions[permission]:
            return jsonify(error="Operation disabled"), 403
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
            raise ValueError("Expected JSON text field")
        new_etag = save_waypoint(
            waypoints, name, payload["text"].encode("utf-8"), expected
        )
        return jsonify(filename=name, etag=new_etag), 200 if expected else 201

    @app.post("/api/waypoints/<name>")
    def waypoint_post(name):
        return save_csv(name, None)

    @app.put("/api/waypoints/<name>")
    def waypoint_put(name):
        expected = request.headers.get("If-Match")
        if not expected:
            return jsonify(error="If-Match required"), 428
        return save_csv(name, expected)

    @app.get("/api/maps")
    def map_list():
        return jsonify(files=list_maps(maps))

    @app.get("/api/maps/<name>/bundle")
    def map_get(name):
        yaml_name, yaml_blob, image_name, image_blob = read_map(maps, name)
        return jsonify(
            yaml_name=yaml_name,
            yaml_text=yaml_blob.decode("utf-8-sig"),
            image_name=image_name,
            image_base64=base64.b64encode(image_blob).decode("ascii"),
            etag=etag_for(yaml_blob, image_blob),
        )

    def save_pair(name: str, expected: str | None):
        permission = "map_replace" if expected is not None else "map_create"
        if not permissions[permission]:
            return jsonify(error="Operation disabled"), 403
        yaml_file = request.files.get("yaml")
        image_file = request.files.get("image")
        if not yaml_file or not image_file or yaml_file.filename != name:
            raise ValueError("Provide matching YAML and image files")
        new_etag = save_map(
            maps,
            name,
            yaml_file.read(),
            image_file.filename,
            image_file.read(),
            expected,
        )
        return jsonify(filename=name, etag=new_etag), 200 if expected else 201

    @app.post("/api/maps/<name>")
    def map_post(name):
        return save_pair(name, None)

    @app.put("/api/maps/<name>")
    def map_put(name):
        expected = request.headers.get("If-Match")
        if not expected:
            return jsonify(error="If-Match required"), 428
        return save_pair(name, expected)

    return app
