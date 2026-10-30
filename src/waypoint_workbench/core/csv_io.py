"""CSV parsing: headered, '#'-comment header, numeric XY; selected numeric presets."""

import csv

import numpy as np

ALIASES = {
    "x": {"x", "x_m", "pos_x", "position_x"},
    "y": {"y", "y_m", "pos_y", "position_y"},
    "yaw": {"yaw", "psi", "theta", "heading"},
    "v": {
        "v",
        "vx",
        "velocity",
        "speed",
        "velocity_mps",
        "speed_mps",
        "vx_mps",
        "speed_scale",
    },
}

PRESETS = {
    "xy": ["x", "y"],
    "xy_yaw_v": ["x", "y", "yaw", "v"],
    "s_x_y_psi_kappa_v_a": ["s", "x", "y", "psi", "kappa", "v", "a"],
}


def canonical(name):
    name = name.strip().lstrip("\ufeff").strip().lower()
    for key, possible in ALIASES.items():
        if name in possible:
            return key
    return name


def parse_csv(text, preset="auto", max_points=20000):
    if not isinstance(text, str) or len(text) > 5000000:
        raise ValueError("Invalid CSV or size >5 MB")
    rows = [line.strip() for line in text.splitlines() if line.strip()]
    data_lines = [row for row in rows if not row.startswith("#")]
    if not data_lines:
        raise ValueError("CSV contains no data")
    first = data_lines[0]
    delimiter = ";" if first.count(";") > first.count(",") else ","

    def fields(line):
        return [v.strip() for v in next(csv.reader([line], delimiter=delimiter))]

    def is_numbers(cells):
        try:
            return len(cells) > 0 and all(np.isfinite(float(v)) for v in cells)
        except (ValueError, TypeError):
            return False

    first_cells = fields(first)
    has_header = not is_numbers(first_cells)
    header = first_cells if has_header else None
    if not header:
        for line in reversed(rows):
            if not line.startswith("#"):
                continue
            col = fields(line[1:].strip())
            if len(col) == len(first_cells) and "x" in [canonical(v) for v in col]:
                header = col
                break
    if preset != "auto":
        if preset not in PRESETS:
            raise ValueError("Unknown CSV preset")
        header = PRESETS[preset]
    if not header:
        if len(first_cells) == 2:
            header = ["x", "y"]
        else:
            raise ValueError(
                f"{len(first_cells)} columns without a recognized header; choose a CSV layout preset"
            )
    names = [canonical(v) for v in header]
    if len(set(names)) != len(names) or "x" not in names or "y" not in names:
        raise ValueError("Need unique x and y columns")
    values = []
    for line in data_lines[1:] if has_header else data_lines:
        cols = fields(line)
        if len(cols) != len(names):
            raise ValueError("CSV row column-count mismatch")
        try:
            row = [float(v) for v in cols]
        except ValueError as exc:
            raise ValueError("Invalid numeric CSV row") from exc
        if not np.isfinite(row).all():
            raise ValueError("CSV has NaN/Inf")
        values.append(row)
    if not 3 <= len(values) <= max_points:
        raise ValueError(f"CSV needs 3..{max_points} points")
    array = np.array(values, dtype=float)
    p = array[:, [names.index("x"), names.index("y")]]
    duplicate = bool(len(p) > 3 and np.linalg.norm(p[-1] - p[0]) < 1e-06)
    if duplicate:
        p = p[:-1]
        array = array[:-1]
    speed = array[:, names.index("v")].tolist() if "v" in names else None
    return {
        "points": p.tolist(),
        "speed": speed,
        "columns": names,
        "closure_removed": duplicate,
        "count": len(p),
    }
