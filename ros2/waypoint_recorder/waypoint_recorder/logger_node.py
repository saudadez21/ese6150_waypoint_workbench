"""Record raw PF /map XY."""

import csv
import math
from datetime import datetime
from pathlib import Path

import rclpy
from nav_msgs.msg import Odometry
from rclpy.node import Node


class WaypointLogger(Node):
    def __init__(self):
        super().__init__("waypoint_logger")
        self.declare_parameter("pose_topic", "/pf/pose/odom")
        self.declare_parameter("minimum_distance", 0.15)
        self.declare_parameter("max_jump_m", 2.0)
        self.declare_parameter("output_dir", str(Path.cwd() / "waypoints"))
        self.declare_parameter("expected_frame", "map")
        topic = str(self.get_parameter("pose_topic").value)
        self.minimum_distance = float(self.get_parameter("minimum_distance").value)
        self.max_jump_m = float(self.get_parameter("max_jump_m").value)
        self.expected_frame = str(self.get_parameter("expected_frame").value).lstrip(
            "/"
        )

        if self.minimum_distance <= 0 or self.max_jump_m <= self.minimum_distance:
            raise ValueError("max_jump_m must be greater than minimum_distance > 0")

        output_dir = Path(str(self.get_parameter("output_dir").value)).expanduser()
        output_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Exclusive file creation prevents overwriting on quick restarts.
        for n in range(1000):
            filename = f"recorded_{stamp}" + (f"_{n:02d}" if n else "") + ".csv"
            try:
                self.file = (output_dir / filename).open(
                    "x", newline="", encoding="utf-8"
                )
                break
            except FileExistsError:
                continue
        else:
            raise RuntimeError("Unable to create unique waypoint CSV")

        self.writer = csv.writer(self.file)
        self.writer.writerow(["x", "y"])
        self.file.flush()
        self.previous = None
        self.count = 0
        self.messages = 0
        self.jump_count = 0
        self.subscription = self.create_subscription(Odometry, topic, self.callback, 10)
        self.timer = self.create_timer(5.0, self.report)
        self.get_logger().info(
            f"Recording {topic} [nav_msgs/Odometry] to {self.file.name}"
        )
        self.get_logger().info(
            f"Saving raw PF x,y without implicit laser/base_link correction; expected frame={self.expected_frame}"
        )

    def callback(self, msg):
        self.messages += 1
        frame = msg.header.frame_id.lstrip("/")
        if self.expected_frame and frame != self.expected_frame:
            self.get_logger().warn(
                f"Skipped pose with frame {frame!r}; expected {self.expected_frame!r}",
                throttle_duration_sec=3.0,
            )
            return
        x = float(msg.pose.pose.position.x)
        y = float(msg.pose.pose.position.y)
        if not (math.isfinite(x) and math.isfinite(y)):
            return
        if self.previous is not None:
            delta = math.hypot(x - self.previous[0], y - self.previous[1])
            if delta < self.minimum_distance:
                return
            if delta > self.max_jump_m:
                self.jump_count += 1
                self.get_logger().warn(
                    f"Skipped PF jump {delta:.2f} m; use manual restart after localization reset",
                    throttle_duration_sec=3.0,
                )
                return
        self.writer.writerow([f"{x:.8f}", f"{y:.8f}"])
        self.file.flush()
        self.previous = (x, y)
        self.count += 1

    def report(self):
        self.get_logger().info(
            f"Waypoints {self.count} | pose messages {self.messages} | skipped jumps {self.jump_count} | {self.file.name}"
        )

    def destroy_node(self):
        if not self.file.closed:
            self.file.close()
        return super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = None
    try:
        node = WaypointLogger()
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node is not None:
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
