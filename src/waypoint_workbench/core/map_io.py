"""ROS map YAML, pixel/world transforms, and non-blocking clearance diagnostics."""

import io
import threading
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

import numpy as np
import yaml
from PIL import Image
from scipy.ndimage import distance_transform_edt, map_coordinates

from .geometry import as_points, closure_gap

_CacheValue = TypeVar("_CacheValue")


def _cache_get(
    cache: OrderedDict[object, _CacheValue],
    key: object,
    calculate: Callable[[], _CacheValue],
) -> _CacheValue:
    """Keep up to eight recently used values in an instance-owned cache."""
    if key in cache:
        cache.move_to_end(key)
        return cache[key]

    result = calculate()
    cache[key] = result
    if len(cache) > 8:
        cache.popitem(last=False)
    return result


class MapRepository:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self._import_lock = threading.Lock()
        # Instance-owned caches avoid retaining discarded repositories (Ruff B019).
        self._map_cache = OrderedDict()
        self._png_cache = OrderedDict()
        self._distance_cache = OrderedDict()

    def list_maps(self):
        names = []
        for file in sorted(
            p
            for p in self.directory.rglob("*")
            if p.is_file() and p.suffix.lower() in (".yaml", ".yml")
        ):
            try:
                self._load_file(file, self.directory)
                names.append(
                    {
                        "id": str(file.relative_to(self.directory).with_suffix("")),
                        "name": file.stem,
                    }
                )
            except (ValueError, OSError, yaml.YAMLError, KeyError, TypeError):
                pass
        # Map listing accepts both .yaml and .yml extensions.
        return names

    def resolve(self, id):
        if not isinstance(id, str) or not id or id.startswith("/") or ("\\" in id):
            raise ValueError("Unknown map")
        path = (self.directory / (id + ".yaml")).resolve()
        if not path.is_file():
            path = path.with_suffix(".yml")
        if self.directory not in path.parents or not path.is_file():
            raise ValueError("Unknown map")
        return path

    def import_pair(self, yaml_name, yaml_data, image_name, image_data):
        """Validate and persist a ROS YAML+image pair directly under maps/.

        Imports intentionally have no overwrite/auto-renaming behavior. Both
        files are created exclusively; if validation fails, both are rolled back.
        """

        def filename(value):
            if (
                not isinstance(value, str)
                or not value
                or value in (".", "..")
                or ("/" in value)
                or ("\\" in value)
                or any(ord(c) < 32 for c in value)
            ):
                raise ValueError(
                    "Use simple filenames without directories for map imports"
                )
            return value

        yn = filename(yaml_name)
        imn = filename(image_name)
        if Path(yn).suffix.lower() not in (".yaml", ".yml") or Path(
            imn
        ).suffix.lower() not in (".png", ".pgm", ".jpg", ".jpeg"):
            raise ValueError("Upload a map YAML and the matching PGM/PNG image")
        if (
            not yaml_data
            or not image_data
            or len(yaml_data) > 50000
            or (len(image_data) > 25000000)
        ):
            raise ValueError("Invalid or oversized map upload")
        try:
            metadata = yaml.safe_load(yaml_data)
        except (yaml.YAMLError, UnicodeDecodeError) as exc:
            raise ValueError("Invalid map YAML") from exc
        if not isinstance(metadata, dict) or metadata.get("image") != imn:
            raise ValueError(
                "YAML image must name exactly the uploaded image file in the same folder"
            )
        yf = self.directory / yn
        img = self.directory / imn
        with self._import_lock:
            # Prevent collisions in both names and map IDs (foo.yaml vs foo.yml).
            existing = {p.name.casefold() for p in self.directory.iterdir()}
            yaml_stems = {
                p.stem.casefold()
                for p in self.directory.rglob("*")
                if p.is_file() and p.suffix.lower() in (".yaml", ".yml")
            }
            if yn.casefold() in existing or yf.stem.casefold() in yaml_stems:
                raise ValueError(
                    f'Map "{yf.stem}" already exists in maps/. Rename the map before importing; existing maps are never overwritten.'
                )
            if imn.casefold() in existing:
                raise ValueError(
                    f'Map image "{imn}" already exists in maps/. Rename the image and update YAML; existing maps are never overwritten.'
                )
            created = []
            try:
                for path, data in ((yf, yaml_data), (img, image_data)):
                    with path.open("xb") as f:
                        created.append(path)
                        f.write(data)
                self._load_file(yf, self.directory)
            except Exception as exc:
                for path in created:
                    path.unlink(missing_ok=True)
                if isinstance(exc, ValueError):
                    raise
                raise ValueError(f"Invalid map pair: {exc}") from exc
        return yf.stem

    @staticmethod
    def _load_file(yaml_file, root):
        doc = yaml.safe_load(yaml_file.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            raise ValueError("Invalid map YAML")
        image = (yaml_file.parent / str(doc["image"])).resolve()
        if root.resolve() not in image.parents or not image.is_file():
            raise ValueError("Map image is missing or outside maps/")
        resolution = float(doc["resolution"])
        origin = [float(v) for v in doc["origin"]]
        if (
            not 0 < resolution <= 2
            or len(origin) != 3
            or (not np.isfinite(origin).all())
        ):
            raise ValueError("Invalid map resolution/origin")
        free = float(doc.get("free_thresh", 0.196))
        occupied = float(doc.get("occupied_thresh", 0.65))
        if not 0 <= free < occupied <= 1:
            raise ValueError("Invalid occupancy thresholds")
        with Image.open(image) as im:
            im.load()
            if im.width * im.height > 25000000:
                raise ValueError("Map too large")
            gray = np.asarray(im.convert("L")).copy()
            alpha = (
                np.asarray(im.getchannel("A")).copy() if "A" in im.getbands() else None
            )
            w, h = im.size
        return {
            "path": image,
            "resolution": resolution,
            "origin": origin,
            "free_thresh": free,
            "occupied_thresh": occupied,
            "negate": int(doc.get("negate", 0)),
            "gray": gray,
            "alpha": alpha,
            "width": w,
            "height": h,
        }

    def load(self, id):
        return _cache_get(
            self._map_cache,
            id,
            lambda: self._load_file(self.resolve(id), self.directory),
        )

    def meta(self, id):
        m = self.load(id)
        return {
            "id": id,
            "width": m["width"],
            "height": m["height"],
            "resolution": m["resolution"],
            "origin": m["origin"],
            "imageUrl": "/api/maps/image/" + id,
        }

    def image_png(self, id):
        def render():
            m = self.load(id)
            out = io.BytesIO()
            Image.fromarray(m["gray"]).save(out, format="PNG")
            return out.getvalue()

        return _cache_get(self._png_cache, id, render)

    def world_to_pixel(self, id, points):
        m = self.load(id)
        p = np.asarray(points, dtype=float)
        origin = np.array(m["origin"][:2])
        yaw = m["origin"][2]
        d = p - origin
        x = (np.cos(yaw) * d[..., 0] + np.sin(yaw) * d[..., 1]) / m["resolution"]
        y = (
            m["height"]
            - 1
            - (-np.sin(yaw) * d[..., 0] + np.cos(yaw) * d[..., 1]) / m["resolution"]
        )
        return np.stack([x, y], axis=-1)

    def pixel_to_world(self, id, pixels):
        m = self.load(id)
        p = np.asarray(pixels, dtype=float)
        qx = p[..., 0] * m["resolution"]
        qy = (m["height"] - 1 - p[..., 1]) * m["resolution"]
        yaw = m["origin"][2]
        return np.stack(
            [
                m["origin"][0] + np.cos(yaw) * qx - np.sin(yaw) * qy,
                m["origin"][1] + np.sin(yaw) * qx + np.cos(yaw) * qy,
            ],
            axis=-1,
        )

    def distance_field(self, id, unknown_is_obstacle=True):
        def calculate():
            m = self.load(id)
            occupation = m["gray"] / 255 if m["negate"] else 1 - m["gray"] / 255
            passable = occupation < m["free_thresh"]
            if not unknown_is_obstacle:
                passable = occupation < m["occupied_thresh"]
            if m["alpha"] is not None:
                passable &= m["alpha"] > 0
            # Treat pixels outside the map as occupied.
            padded = np.pad(passable, 1, constant_values=False)
            return distance_transform_edt(padded)[1:-1, 1:-1] * m["resolution"]

        return _cache_get(self._distance_cache, (id, unknown_is_obstacle), calculate)

    def validate(
        self, id, points, *, threshold_m, closure_limit_m, unknown_is_obstacle=True
    ):
        p = as_points(points)
        m = self.load(id)
        field = self.distance_field(id, unknown_is_obstacle)
        gap = closure_gap(p)
        closed = gap <= closure_limit_m
        starts = p if closed else p[:-1]
        ends = np.roll(p, -1, axis=0) if closed else p[1:]
        distances = np.linalg.norm(ends - starts, axis=1)
        sample_step = max(0.02, m["resolution"] / 2)
        counts = np.maximum(2, np.ceil(distances / sample_step).astype(int) + 1)
        if sum(counts) > 250000:
            raise ValueError("Path too long for clearance preview")
        indices = np.repeat(np.arange(len(starts)), counts)
        fraction = np.concatenate([np.linspace(0, 1, count) for count in counts])
        world = (
            starts[indices] * (1 - fraction[:, None])
            + ends[indices] * fraction[:, None]
        )
        pixel = self.world_to_pixel(id, world)
        clearances = map_coordinates(
            field, [pixel[:, 1], pixel[:, 0]], order=1, mode="constant", cval=0
        )
        per_edge = np.full(len(starts), np.inf)
        np.minimum.at(per_edge, indices, clearances)
        return {
            "minimum_clearance_m": float(clearances.min()),
            "threshold_m": float(threshold_m),
            "collision_segments": int(np.sum(per_edge < 1e-06)),
            "near_segments": int(np.sum(per_edge < threshold_m)),
            "segment_clearances_m": per_edge.tolist(),
            "closed": closed,
            "closure_gap_m": gap,
            "note": "Distance from waypoint reference point to map obstacles; not a full rectangular vehicle footprint.",
        }
