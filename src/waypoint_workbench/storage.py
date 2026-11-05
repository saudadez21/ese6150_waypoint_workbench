"""Validated file operations shared by map and waypoint API endpoints."""

from __future__ import annotations

import hashlib
import io
import os
import re
import tempfile
import threading
import zipfile
from datetime import datetime
from pathlib import Path

import yaml
from PIL import Image

_LOCK = threading.RLock()
_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}")
_IMAGE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(?:png|pgm)", re.I)


class AlreadyExists(Exception):
    """A create request names an existing file."""


class VersionConflict(Exception):
    """The file was modified after the client's last read."""


def safe_filename(name: str, extension: str) -> str:
    if not isinstance(name, str) or not name.lower().endswith(extension):
        raise ValueError(f"Expected {extension} filename")
    stem = name[: -len(extension)]
    if not _NAME.fullmatch(stem):
        raise ValueError("Filenames require letters, digits, _ or -")
    return stem + extension


def etag_for(*blobs: bytes) -> str:
    digest = hashlib.sha256()
    for blob in blobs:
        digest.update(len(blob).to_bytes(8, "big"))
        digest.update(blob)
    return f'"{digest.hexdigest()}"'


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _backup_path(root: Path, stem: str, extension: str) -> Path:
    folder = root / ".backups"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = _stamp()
    for index in range(1000):
        suffix = f"_{index:02d}" if index else ""
        path = folder / f"{stem}_backup_{stamp}{suffix}{extension}"
        if not path.exists():
            return path
    raise ValueError("Too many backups")


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def list_waypoints(root: Path) -> list[str]:
    return sorted(file.name for file in root.glob("*.csv") if file.is_file())


def read_waypoint(root: Path, name: str) -> tuple[bytes, str]:
    path = root / safe_filename(name, ".csv")
    if not path.is_file():
        raise FileNotFoundError(name)
    data = path.read_bytes()
    return data, etag_for(data)


def save_waypoint(
    root: Path, name: str, data: bytes, expected: str | None = None
) -> str:
    path = root / safe_filename(name, ".csv")
    if not data or len(data) > 5_000_000:
        raise ValueError("CSV must be nonempty and at most 5 MB")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("CSV must be UTF-8") from exc
    if not text.strip():
        raise ValueError("Empty CSV")
    with _LOCK:
        if expected is None:
            try:
                with path.open("xb") as stream:
                    stream.write(data)
            except FileExistsError as exc:
                raise AlreadyExists(name) from exc
        else:
            old, tag = read_waypoint(root, name)
            if tag != expected:
                raise VersionConflict("Waypoint changed on the server")
            _backup_path(root, path.stem, ".csv").write_bytes(old)
            _atomic_write(path, data)
    return etag_for(data)


def _parse_yaml(data: bytes) -> dict:
    try:
        info = yaml.safe_load(data)
    except yaml.YAMLError as exc:
        raise ValueError("Invalid map YAML") from exc
    if not isinstance(info, dict):
        raise ValueError("Invalid map YAML")
    return info


def validate_map(
    yaml_name: str, yaml_blob: bytes, image_name: str, image_blob: bytes
) -> tuple[str, str]:
    yaml_name = safe_filename(yaml_name, ".yaml")
    if not _IMAGE.fullmatch(image_name):
        raise ValueError("Image filename must end in .pgm or .png")
    if len(yaml_blob) > 128_000 or len(image_blob) > 32_000_000:
        raise ValueError("Map too large")
    info = _parse_yaml(yaml_blob)
    if info.get("image") != image_name:
        raise ValueError("YAML image field must match the image filename")
    try:
        if float(info["resolution"]) <= 0 or len(info["origin"]) != 3:
            raise ValueError("Invalid map resolution/origin")
    except (KeyError, TypeError) as exc:
        raise ValueError("Invalid map resolution/origin") from exc
    try:
        with Image.open(io.BytesIO(image_blob)) as image:
            image.load()
            expected_format = "PNG" if image_name.lower().endswith(".png") else "PPM"
            if (
                image.format != expected_format
                or image.width * image.height > 25_000_000
            ):
                raise ValueError("Invalid map image")
    except (OSError, SyntaxError) as exc:
        raise ValueError("Invalid map image") from exc
    return yaml_name, image_name


def read_map(root: Path, name: str) -> tuple[str, bytes, str, bytes]:
    yaml_name = safe_filename(name, ".yaml")
    yaml_path = root / yaml_name
    if not yaml_path.is_file():
        raise FileNotFoundError(name)
    yaml_blob = yaml_path.read_bytes()
    image_name = _parse_yaml(yaml_blob).get("image")
    if not isinstance(image_name, str) or not _IMAGE.fullmatch(image_name):
        raise ValueError("Invalid map image reference")
    image_path = root / image_name
    if not image_path.is_file():
        raise FileNotFoundError(image_name)
    return yaml_name, yaml_blob, image_name, image_path.read_bytes()


def list_maps(root: Path) -> list[str]:
    result = []
    for path in sorted(root.glob("*.yaml")):
        try:
            read_map(root, path.name)
        except (FileNotFoundError, ValueError):
            continue
        result.append(path.name)
    return result


def _map_backup(
    root: Path, yaml_name: str, yaml_blob: bytes, image_name: str, image_blob: bytes
) -> None:
    path = _backup_path(root, Path(yaml_name).stem, ".zip")
    folder = path.stem
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(f"{folder}/{yaml_name}", yaml_blob)
        bundle.writestr(f"{folder}/{image_name}", image_blob)


def save_map(
    root: Path,
    yaml_name: str,
    yaml_blob: bytes,
    image_name: str,
    image_blob: bytes,
    expected: str | None = None,
) -> str:
    yaml_name, image_name = validate_map(yaml_name, yaml_blob, image_name, image_blob)
    yaml_path = root / yaml_name
    image_path = root / image_name
    with _LOCK:
        if expected is None:
            if yaml_path.exists() or image_path.exists():
                raise AlreadyExists("Map or image already exists")
            try:
                with image_path.open("xb") as stream:
                    stream.write(image_blob)
                with yaml_path.open("xb") as stream:
                    stream.write(yaml_blob)
            except Exception:
                if not yaml_path.exists():
                    image_path.unlink(missing_ok=True)
                raise
        else:
            _, old_yaml, old_image_name, old_image = read_map(root, yaml_name)
            if old_image_name != image_name:
                raise ValueError("Image filename differs; upload as a new map")
            if etag_for(old_yaml, old_image) != expected:
                raise VersionConflict("Map changed on the server")
            _map_backup(root, yaml_name, old_yaml, image_name, old_image)
            try:
                _atomic_write(image_path, image_blob)
                _atomic_write(yaml_path, yaml_blob)
            except Exception:
                _atomic_write(image_path, old_image)
                _atomic_write(yaml_path, old_yaml)
                raise
    return etag_for(yaml_blob, image_blob)
