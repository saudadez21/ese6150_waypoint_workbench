# Waypoint CSV formats

## Import (Web and scripts)

The shared CSV parser recognizes raw numeric `x,y` files, ordinary `x,y`
headers, and `#` comment headers such as `# x,y,yaw,v`. Commas and semicolons
are supported, along with common aliases including `x_m`, `y_m`, `theta/psi/yaw`
and `v/velocity/speed`.

An exactly duplicated last XY row is removed on import. The stored working
representation never duplicates the first sample at the end. Geometry edits
invalidate speeds and widths.

## Save As (Web)

Outputs regular `x,y` CSV, or `x,y,v` when the working track has a valid speed
column. All files are written to `waypoints/`, with a timestamp added for
name collisions; no existing file is overwritten.

## Scripts

`scripts/smooth.py` and `scripts/resample.py` output `x,y` because geometry
changes invalidate old speed data. `scripts/speed_profile.py` outputs `x,y,v`.
Scripts reject existing output paths.

`scripts/export.py` outputs a **`#` comment header** followed by numeric CSV rows:

| `OUTPUT_FORMAT` | Columns | Requirements |
|---|---|---|
| `xy` | `x,y` | XY only; open path supported |
| `xy_heading` | `x,y,yaw` | Closed, nondegenerate geometry |
| `mpc` | `x,y,yaw,v` | Closed geometry + speed |
| `mpc_extended` | `s,x,y,psi,kappa,v,a` | Closed geometry + speed |

`yaw/psi` is derived from periodic spline tangents, `kappa` is signed
curvature in 1/m, and `s` is cumulative arc length before the stored point.
The acceleration `a` is approximated by `(v_next**2 - v**2) / (2 * ds)`;
it is not measured longitudinal acceleration.
