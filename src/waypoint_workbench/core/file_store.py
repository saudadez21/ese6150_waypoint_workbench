"""Safe repository-local CSV files: no overwrites, path traversal, or chained timestamps."""

import csv
import io
import re
from datetime import datetime
from pathlib import Path

from .geometry import as_points

STAMP = re.compile("(?:_\\d{8}_\\d{6})(?:_\\d{2})?$")
SAFE = re.compile("[^a-zA-Z0-9_\\-]")


def safe_stem(name):
    stem = Path(str(name).replace("\\", "/")).name
    if stem.lower().endswith(".csv"):
        stem = stem[:-4]
    stem = SAFE.sub("_", stem).strip("_-")
    return stem[:90] or "waypoints"


def source_path(directory, name):
    root = Path(directory).resolve()
    relative = Path(name)
    target = (root / relative).resolve()
    if (
        root not in target.parents
        or target.suffix.lower() != ".csv"
        or (not target.is_file())
    ):
        raise ValueError("Source must be an existing CSV inside waypoints/")
    return target


def available_csvs(directory):
    return [
        str(p.relative_to(directory))
        for p in sorted(Path(directory).rglob("*.csv"))
        if p.is_file()
    ]


def write_unique(directory, name, contents, suffix=None):
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(name)
    if suffix:
        stem += f"_{safe_stem(suffix)}"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Strip an existing timestamp to avoid name_date_date chains.
    dated_stem = STAMP.sub("", stem) or stem
    candidates = [f"{stem}.csv", f"{dated_stem}_{timestamp}.csv"]
    candidates.extend(
        f"{dated_stem}_{timestamp}_{index:02d}.csv" for index in range(2, 1000)
    )
    for candidate in candidates:
        try:
            with (root / candidate).open("x", encoding="utf-8", newline="") as f:
                f.write(contents)
            return candidate
        except FileExistsError:
            continue
    raise ValueError("Could not allocate a unique output filename")


def basic_csv(points, speed=None):
    """Working-copy CSV preserves optional valid speed data."""
    import numpy as np

    p = as_points(points)
    if speed is not None and (len(speed) != len(p) or not np.isfinite(speed).all()):
        raise ValueError("Speed array differs from XY geometry")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    header = ["x", "y"]
    if speed is not None:
        header += ["v"]
    writer.writerow(header)
    for i, (x, y) in enumerate(p):
        row = [f"{x:.8f}", f"{y:.8f}"]
        if speed is not None:
            row.append(f"{float(speed[i]):.8f}")
        writer.writerow(row)
    return stream.getvalue()
