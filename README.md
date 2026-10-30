# Waypoint Workbench | F1TENTH

Small **offline waypoint editor** + **independent ROS 2 PF recorder** for UPenn ESE 6150 group labs and race.

## Quick start: web editor

Python **3.10+**, NumPy, SciPy, Flask, Pillow, PyYAML. Run from the repository root:

```bash
# If you use uv (installs/syncs dependencies automatically)
uv run python -m waypoint_workbench

# Or, for a regular Python environment
python -m pip install -e .
python -m waypoint_workbench
```

Open **http://127.0.0.1:5050**.

Default config: `config/default.toml`, default map: `Spielberg`, default waypoint: `Spielberg_centerline.csv` sample. Set `default_waypoint = ""` to start with no track. To use an alternate config:

```bash
python -m waypoint_workbench --config /path/to/your.toml
```

For LAN access only when you intentionally want it, pass `--host 0.0.0.0`.

## ROS 2 recorder (vehicle / simulator)

Pure-Python `ament_python` package: `ros2/waypoint_recorder`.

Place this repo in the ROS workspace's `src/`, build and source your normal setup script:

```bash
cd ~/f1tenth_ws
colcon build --packages-select waypoint_recorder
source install/setup.bash
cd ~/f1tenth_ws/src/waypoint_workbench
ros2 run waypoint_recorder waypoint_logger
```

The **default output directory is `./waypoints/` relative to your current working directory**.

Output is a newly created `recorded_YYYYMMDD_HHMMSS.csv` with `x,y` header, no repeated closure point.

Default inputs are **`/pf/pose/odom`** (`nav_msgs/msg/Odometry`, true-car PF map pose). Simulation option:

```bash
ros2 run waypoint_recorder waypoint_logger --ros-args -p pose_topic:=/ego_racecar/odom -p expected_frame:=map
```

ROS parameters: `pose_topic` (default `/pf/pose/odom`), `minimum_distance` (0.15 m), `max_jump_m` (2.0 m, jumps are skipped and logged), `expected_frame` (`map`, accepts `/map`), `output_dir` (default `./waypoints/`).
