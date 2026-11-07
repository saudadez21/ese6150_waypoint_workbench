"""File API storage and archive behavior."""

from __future__ import annotations

import io
import struct
import zipfile
import zlib
from pathlib import Path
from unittest.mock import patch

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
    yaml_blob = (
        b"image: track.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n"
        b"negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n"
    )
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


def test_map_listing_checks_references_without_reading_image_bytes(tmp_path):
    yaml_blob, image_blob = sample_map()
    (tmp_path / "track.yaml").write_bytes(yaml_blob)
    (tmp_path / "track.pgm").write_bytes(image_blob)

    original_read = Path.read_bytes

    def record_read(path):
        if path.suffix.lower() == ".pgm":
            raise AssertionError("Map listing must not load image bytes")
        return original_read(path)

    with patch.object(Path, "read_bytes", record_read):
        assert list_maps(tmp_path) == ["track.yaml"]
    assert read_map(tmp_path, "track.yaml")[3] == image_blob


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


@pytest.mark.parametrize("mode", ["trinary", "scale", "raw"])
def test_validate_map_modes_and_bmp(mode):
    output = io.BytesIO()
    Image.new("RGB", (3, 2), (255, 255, 255)).save(output, format="BMP")
    image = output.getvalue()
    yaml_blob = (
        f"image: track.bmp\nresolution: 0.05\norigin: [0,0,0]\n"
        f"mode: {mode}\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n"
    ).encode()
    assert validate_map("track.yaml", yaml_blob, "track.bmp", image) == (
        "track.yaml",
        "track.bmp",
    )


@pytest.mark.parametrize(
    "field",
    [
        "resolution: .nan",
        "resolution: .inf",
        "resolution: -1",
        "origin: [.nan, 0, 0]",
        "origin: [0, xyz, 0]",
        "mode: other",
        "negate: 2",
        "free_thresh: .nan",
        "free_thresh: 0.8",
        "occupied_thresh: 1.5",
    ],
)
def test_invalid_yaml_metadata_is_rejected(field):
    _, image = sample_map()
    key = field.split(":")[0]
    data = {
        "image": "track.pgm",
        "resolution": 0.05,
        "origin": [0, 0, 0],
        "free_thresh": 0.196,
        "occupied_thresh": 0.65,
        "mode": "trinary",
        "negate": 0,
    }
    data.pop(key, None)
    yaml_blob = (
        "\n".join(f"{k}: {v}" for k, v in data.items()) + f"\n{field}\n"
    ).encode()
    with pytest.raises(ValueError):
        validate_map("track.yaml", yaml_blob, "track.pgm", image)


@pytest.mark.parametrize("missing", ["negate", "free_thresh", "occupied_thresh"])
def test_missing_required_ros_map_metadata_is_rejected(missing):
    yaml_blob, image = sample_map()
    lines = yaml_blob.decode().splitlines()
    yaml_missing = "\n".join(
        line for line in lines if not line.startswith(f"{missing}:")
    ).encode()
    with pytest.raises(ValueError, match="missing required"):
        validate_map("track.yaml", yaml_missing, "track.pgm", image)


def test_yaml_mode_optional_and_quoted_numeric_metadata_rejected():
    yaml_blob, image = sample_map()
    assert validate_map("track.yaml", yaml_blob, "track.pgm", image)
    invalid = yaml_blob.replace(b"resolution: 0.05", b'resolution: "0.05"')
    with pytest.raises(ValueError, match="finite"):
        validate_map("track.yaml", invalid, "track.pgm", image)


def test_map_image_extension_changes_only_after_backup(tmp_path):
    old_yaml, pgm = sample_map()
    tag = save_map(tmp_path, "track.yaml", old_yaml, "track.pgm", pgm)
    png_buffer = io.BytesIO()
    Image.new("RGBA", (4, 3), (10, 10, 10, 0)).save(png_buffer, "PNG")
    png = png_buffer.getvalue()
    new_yaml = old_yaml.replace(b"track.pgm", b"track.png") + b"mode: scale\n"
    save_map(tmp_path, "track.yaml", new_yaml, "track.png", png, tag)
    assert not (tmp_path / "track.pgm").exists()
    assert read_map(tmp_path, "track.yaml")[1:] == (new_yaml, "track.png", png)
    backups = list((tmp_path / ".backups").glob("track_backup_*.zip"))
    assert len(backups) == 1
    with zipfile.ZipFile(backups[0]) as archive:
        assert any(name.endswith("/track.pgm") for name in archive.namelist())
        assert any(name.endswith("/track.yaml") for name in archive.namelist())


def test_shared_image_cannot_be_overwritten_by_single_map(tmp_path):
    yaml_blob, pgm = sample_map()
    tag = save_map(tmp_path, "track.yaml", yaml_blob, "track.pgm", pgm)
    # A second map is a valid alternative YAML referencing the same image.
    second_yaml = yaml_blob.replace(b"resolution: 0.05", b"resolution: 0.1")
    (tmp_path / "second.yml").write_bytes(second_yaml)
    new_image_buffer = io.BytesIO()
    Image.new("L", (4, 3), 0).save(new_image_buffer, format="PPM")
    changed_image = new_image_buffer.getvalue()

    with pytest.raises(AlreadyExists, match="shared"):
        save_map(tmp_path, "track.yaml", yaml_blob, "track.pgm", changed_image, tag)
    assert (tmp_path / "track.pgm").read_bytes() == pgm
    assert read_map(tmp_path, "second.yml")[3] == pgm
    assert list((tmp_path / ".backups").glob("*.zip")) == []

    # Replacing only metadata without modifying the shared image is safe.
    updated_yaml = yaml_blob + b"extra_metadata: reviewed\n"
    new_tag = save_map(tmp_path, "track.yaml", updated_yaml, "track.pgm", pgm, tag)
    assert read_map(tmp_path, "second.yml")[3] == pgm

    # Moving one YAML to an independent image keeps the other map usable.
    moved_yaml = updated_yaml.replace(b"track.pgm", b"track2.pgm")
    save_map(tmp_path, "track.yaml", moved_yaml, "track2.pgm", changed_image, new_tag)
    assert read_map(tmp_path, "second.yml")[3] == pgm
    assert (tmp_path / "track.pgm").read_bytes() == pgm
    assert read_map(tmp_path, "track.yaml")[2:] == ("track2.pgm", changed_image)


@pytest.mark.parametrize("number", ["5e-2", "5.0e-2", "5E-2", "5e-02", "+5e-2"])
def test_unquoted_scientific_notation_matches_browser_yaml(number):
    yaml_blob, pgm = sample_map()
    converted = yaml_blob.replace(b"resolution: 0.05", f"resolution: {number}".encode())
    assert validate_map("track.yaml", converted, "track.pgm", pgm)
    # Quoted exponent values still are strings, not valid numeric metadata.
    quoted = yaml_blob.replace(b"resolution: 0.05", f'resolution: "{number}"'.encode())
    with pytest.raises(ValueError, match="finite"):
        validate_map("track.yaml", quoted, "track.pgm", pgm)


def test_yml_api_map_names_match_browser(tmp_path):
    yaml_blob, pgm = sample_map()
    tag = save_map(tmp_path, "track.yml", yaml_blob, "track.pgm", pgm)
    assert list_maps(tmp_path) == ["track.yml"]
    assert read_map(tmp_path, "track.yml")[1:] == (yaml_blob, "track.pgm", pgm)
    assert etag_for(yaml_blob, pgm) == tag


def test_oversized_png_is_rejected_before_pillow_pixel_decode():
    yaml_blob, _ = sample_map()
    output = io.BytesIO()
    Image.new("L", (1, 1), 255).save(output, format="PNG")
    image = bytearray(output.getvalue())
    struct.pack_into(">II", image, 16, 6000, 5000)
    struct.pack_into(">I", image, 29, zlib.crc32(image[12:29]))
    changed_yaml = yaml_blob.replace(b"track.pgm", b"track.png")
    with (
        patch.object(Image.Image, "load", side_effect=AssertionError("Decoded pixels")),
        pytest.raises(ValueError, match="Invalid map image"),
    ):
        validate_map("track.yaml", changed_yaml, "track.png", bytes(image))


def test_enormous_map_yaml_integer_is_rejected_as_invalid_number():
    yaml_blob, pgm = sample_map()
    oversized_number = b"9" * 350
    data = yaml_blob.replace(b"resolution: 0.05", b"resolution: " + oversized_number)
    with pytest.raises(ValueError, match="finite"):
        validate_map("track.yaml", data, "track.pgm", pgm)
