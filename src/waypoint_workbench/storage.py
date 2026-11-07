"""Validated file operations shared by map and waypoint API endpoints."""

from __future__ import annotations

import hashlib
import io
import math
import os
import re
import tempfile
import threading
import zipfile
from contextlib import suppress
from datetime import datetime
from pathlib import Path

import yaml
from PIL import Image

_LOCK = threading.RLock()
_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}")
_MAP_YAML = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.ya?ml", re.I)
_IMAGE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(?:png|pgm|bmp)", re.I)


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


def safe_map_filename(name: str) -> str:
    if not isinstance(name, str) or not _MAP_YAML.fullmatch(name):
        raise ValueError("Map filenames must end in .yaml or .yml")
    return name


def _map_yaml_paths(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.iterdir()
        if path.is_file() and _MAP_YAML.fullmatch(path.name)
    )


def _other_map_references_image(root: Path, current: Path, image_name: str) -> bool:
    """Treat unreadable YAML conservatively: never overwrite an uncertain shared image."""
    for other in _map_yaml_paths(root):
        if other == current:
            continue
        try:
            if _parse_yaml(other.read_bytes()).get("image") == image_name:
                return True
        except (ValueError, OSError):
            return True
    return False


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


# PyYAML does not recognize unquoted exponent-only floats (e.g. 5e-2),
# while the browser js-yaml parser does. Extend just the map loader, so
# quoted strings remain strings and other YAML use is unaffected.
class _MapLoader(yaml.SafeLoader):
    pass


_MAP_EXPONENT = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[eE][+-]?[0-9]+$")
_MapLoader.add_implicit_resolver(
    "tag:yaml.org,2002:float", _MAP_EXPONENT, list("+-0123456789.")
)


def _parse_yaml(data: bytes) -> dict:
    try:
        info = yaml.load(data, Loader=_MapLoader)
    except yaml.YAMLError as exc:
        raise ValueError("Invalid map YAML") from exc
    if not isinstance(info, dict):
        raise ValueError("Invalid map YAML")
    return info


def _validate_map_metadata(info: dict, image_name: str) -> None:
    if info.get("image") != image_name:
        raise ValueError("YAML image field must match the image filename")

    def finite_number(value: object) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Expected finite map number")
        try:
            result = float(value)
        except (ValueError, OverflowError) as exc:
            raise ValueError("Expected finite map number") from exc
        if not math.isfinite(result):
            raise ValueError("Expected finite map number")
        return result

    resolution = finite_number(info.get("resolution"))
    origin = info.get("origin")
    if resolution <= 0 or not isinstance(origin, list) or len(origin) != 3:
        raise ValueError("Invalid map resolution/origin")
    for coordinate in origin:
        finite_number(coordinate)

    if any(key not in info for key in ("negate", "free_thresh", "occupied_thresh")):
        raise ValueError("Map YAML is missing required occupancy metadata")
    negate = info["negate"]
    if negate not in (0, 1, False, True):
        raise ValueError("Invalid map negate")
    mode = info.get("mode", "trinary")
    if not isinstance(mode, str) or mode.lower() not in ("trinary", "scale", "raw"):
        raise ValueError("Invalid map mode")
    free = finite_number(info["free_thresh"])
    occupied = finite_number(info["occupied_thresh"])
    if not 0 <= free < occupied <= 1:
        raise ValueError("Invalid map thresholds")


def validate_map(
    yaml_name: str, yaml_blob: bytes, image_name: str, image_blob: bytes
) -> tuple[str, str]:
    yaml_name = safe_map_filename(yaml_name)
    if not _IMAGE.fullmatch(image_name):
        raise ValueError("Image filename must end in .pgm, .png or .bmp")
    if len(yaml_blob) > 128_000 or len(image_blob) > 32_000_000:
        raise ValueError("Map too large")
    _validate_map_metadata(_parse_yaml(yaml_blob), image_name)
    try:
        with Image.open(io.BytesIO(image_blob)) as image:
            extension = image_name.lower().rsplit(".", 1)[-1]
            expected_format = {"png": "PNG", "pgm": "PPM", "bmp": "BMP"}[extension]
            if (
                image.format != expected_format
                or image.width <= 0
                or image.height <= 0
                or image.width * image.height > 25_000_000
            ):
                raise ValueError("Invalid map image")
            # Do not decode a decompression bomb before checking its dimensions.
            image.load()
    except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("Invalid map image") from exc
    return yaml_name, image_name


def _map_reference(root: Path, name: str) -> tuple[str, bytes, str, Path]:
    """Read and validate map metadata without loading the image bytes."""
    yaml_name = safe_map_filename(name)
    yaml_path = root / yaml_name
    if not yaml_path.is_file():
        raise FileNotFoundError(name)
    yaml_blob = yaml_path.read_bytes()
    metadata = _parse_yaml(yaml_blob)
    image_name = metadata.get("image")
    if not isinstance(image_name, str) or not _IMAGE.fullmatch(image_name):
        raise ValueError("Invalid map image reference")
    _validate_map_metadata(metadata, image_name)
    image_path = root / image_name
    if not image_path.is_file():
        raise FileNotFoundError(image_name)
    return yaml_name, yaml_blob, image_name, image_path


def read_map(root: Path, name: str) -> tuple[str, bytes, str, bytes]:
    with _LOCK:
        yaml_name, yaml_blob, image_name, image_path = _map_reference(root, name)
        return yaml_name, yaml_blob, image_name, image_path.read_bytes()


def list_maps(root: Path) -> list[str]:
    with _LOCK:
        result = []
        for path in _map_yaml_paths(root):
            try:
                _map_reference(root, path.name)
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
            if etag_for(old_yaml, old_image) != expected:
                raise VersionConflict("Map changed on the server")
            old_image_path = root / old_image_name
            different_image = old_image_name != image_name
            if different_image and image_path.exists():
                raise AlreadyExists("Replacement image filename already exists")
            if (
                not different_image
                and image_blob != old_image
                and _other_map_references_image(root, yaml_path, old_image_name)
            ):
                raise AlreadyExists(
                    "Image is shared by another map; use a new image filename "
                    "instead of overwriting it"
                )
            _map_backup(root, yaml_name, old_yaml, old_image_name, old_image)
            try:
                _atomic_write(image_path, image_blob)
                _atomic_write(yaml_path, yaml_blob)
            except Exception:
                _atomic_write(yaml_path, old_yaml)
                if different_image:
                    image_path.unlink(missing_ok=True)
                else:
                    _atomic_write(image_path, old_image)
                raise
            # Preserve an old image if any other map still references it.
            if different_image and not _other_map_references_image(
                root, yaml_path, old_image_name
            ):
                with suppress(OSError):
                    # Cleanup is optional; the new pair is already committed.
                    old_image_path.unlink(missing_ok=True)

    return etag_for(yaml_blob, image_blob)
