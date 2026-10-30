"""Shared XY validation and closure primitives (no processing algorithms)."""

import numpy as np


def as_points(data, min_points=3, max_points=20_000):
    points = np.asarray(data, dtype=float)
    if (
        points.ndim != 2
        or points.shape[1] != 2
        or not min_points <= len(points) <= max_points
    ):
        raise ValueError(f"Expected {min_points}..{max_points} x,y points")
    if not np.isfinite(points).all():
        raise ValueError("Waypoint coordinates must be finite")
    return points


def closure_gap(points):
    points = as_points(points)
    return float(np.linalg.norm(points[-1] - points[0]))


def segment_lengths(points):
    points = as_points(points)
    return np.linalg.norm(np.roll(points, -1, axis=0) - points, axis=1)


def ensure_closed(points, limit_m):
    points = as_points(points)
    gap = closure_gap(points)
    if gap > limit_m:
        raise ValueError(
            f"Open loop: end-to-start gap {gap:.3f} m exceeds "
            f"{limit_m:.3f} m; edit endpoints first"
        )
    return points
