"""File API storage and archive behavior."""

from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image

from waypoint_workbench.storage import (
    AlreadyExists,
    VersionConflict,
    etag_for,
    list_maps,
    list_waypoints,
    read_map,
    read_waypoint,
    save_map,
    save_waypoint,
    validate_map,
)


def sample_map() -> tuple[bytes, bytes]:
    yaml_blob = b"image: track.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n"
    output = io.BytesIO()
    image = Image.new("L", (4, 3), 255)
    image.save(output, format="PPM")
    return yaml_blob, output.getvalue()


def test_waypoint_create_and_backup(tmp_path):
    initial = b"x,y,other\n1,2,a\n3,4,b\n"
    etag = save_waypoint(tmp_path, "test.csv", initial)
    assert list_waypoints(tmp_path) == ["test.csv"]
    assert read_waypoint(tmp_path, "test.csv") == (initial, etag)
    with pytest.raises(AlreadyExists):
        save_waypoint(tmp_path, "test.csv", initial)
    with pytest.raises(VersionConflict):
        save_waypoint(tmp_path, "test.csv", b"x,y\n2,2\n", '"old"')
    replacement = b"x,y\n3,4\n5,6\n"
    assert save_waypoint(tmp_path, "test.csv", replacement, etag) == etag_for(
        replacement
    )
    backup = list((tmp_path / ".backups").glob("test_backup_*.csv"))
    assert len(backup) == 1
    assert backup[0].read_bytes() == initial
    assert read_waypoint(tmp_path, "test.csv")[0] == replacement


def test_map_pair_replacement_creates_timestamped_zip_with_original_names(tmp_path):
    yaml_blob, pgm_blob = sample_map()
    tag = save_map(tmp_path, "track.yaml", yaml_blob, "track.pgm", pgm_blob)
    assert list_maps(tmp_path) == ["track.yaml"]
    assert read_map(tmp_path, "track.yaml")[1:] == (yaml_blob, "track.pgm", pgm_blob)
    with pytest.raises(AlreadyExists):
        save_map(tmp_path, "track.yaml", yaml_blob, "track.pgm", pgm_blob)
    new_yaml = yaml_blob + b"negate: 0\n"
    with pytest.raises(VersionConflict):
        save_map(tmp_path, "track.yaml", new_yaml, "track.pgm", pgm_blob, '"old"')
    save_map(tmp_path, "track.yaml", new_yaml, "track.pgm", pgm_blob, tag)
    backups = list((tmp_path / ".backups").glob("track_backup_*.zip"))
    assert len(backups) == 1
    with zipfile.ZipFile(backups[0]) as archive:
        members = archive.namelist()
        assert len(members) == 2
        assert members[0].endswith("/track.yaml")
        assert members[1].endswith("/track.pgm")
        assert archive.read(members[0]) == yaml_blob
        assert archive.read(members[1]) == pgm_blob
    assert read_map(tmp_path, "track.yaml")[1] == new_yaml


def test_invalid_map_and_paths_are_rejected(tmp_path):
    yaml_blob, pgm_blob = sample_map()
    for filename in ("../track.yaml", "track.txt", "bad.name.yaml"):
        with pytest.raises(ValueError):
            save_map(tmp_path, filename, yaml_blob, "track.pgm", pgm_blob)
    with pytest.raises(ValueError):
        validate_map("track.yaml", yaml_blob, "other.pgm", pgm_blob)
    with pytest.raises(ValueError):
        save_waypoint(tmp_path, "../escape.csv", b"x,y\n1,2\n")


def test_static_routes_and_api(tmp_path):
    pytest.importorskip("flask")
    from waypoint_workbench.config import project_root
    from waypoint_workbench.server import create_app

    settings = {
        "web_dir": project_root() / "web",
        "paths": {"maps": tmp_path / "maps", "waypoints": tmp_path / "waypoints"},
        "permissions": {
            "waypoint_create": True,
            "waypoint_replace": True,
            "map_create": True,
            "map_replace": True,
        },
        "security": {"allowed_origins": [], "token_env": "WAYPOINT_WORKBENCH_TOKEN"},
        "limits": {"max_upload_mb": 32},
    }
    client = create_app(settings).test_client()
    for path in ("/", "/index.html", "/map-editor.html", "/config.html", "/js/csv.js"):
        assert client.get(path).status_code == 200, path
    assert client.get("/api/health").json["status"] == "ok"
    assert client.get("/api/maps").json["files"] == []
    response = client.post("/api/waypoints/test.csv", json={"text": "x,y\n1,2\n2,3\n"})
    assert response.status_code == 201
    initial_etag = response.json["etag"]
    assert (
        client.post("/api/waypoints/test.csv", json={"text": "x,y\n1,2\n"}).status_code
        == 409
    )
    assert (
        client.put("/api/waypoints/test.csv", json={"text": "x,y\n3,4\n"}).status_code
        == 428
    )
    assert (
        client.put(
            "/api/waypoints/test.csv",
            json={"text": "x,y\n3,4\n"},
            headers={"If-Match": '"stale"'},
        ).status_code
        == 412
    )
    assert (
        client.put(
            "/api/waypoints/test.csv",
            json={"text": "x,y\n3,4\n"},
            headers={"If-Match": initial_etag},
        ).status_code
        == 200
    )
    assert client.get("/api/waypoints/test.csv").headers.get("ETag")
    yaml_blob, pgm_blob = sample_map()
    response = client.post(
        "/api/maps/track.yaml",
        data={
            "yaml": (io.BytesIO(yaml_blob), "track.yaml"),
            "image": (io.BytesIO(pgm_blob), "track.pgm"),
        },
    )
    assert response.status_code == 201
    assert client.get("/api/maps").json["files"] == ["track.yaml"]
    assert client.get("/api/maps/track.yaml/bundle").json["image_name"] == "track.pgm"
