"""ROS 2 ament_python package metadata for the standalone waypoint recorder."""

from setuptools import setup

package_name = "waypoint_recorder"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        (
            "share/ament_index/resource_index/packages",
            ["resource/" + package_name],
        ),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="F1TENTH group",
    maintainer_email="team@example.invalid",
    description="PF Odometry XY waypoint recorder for F1TENTH",
    license="UNLICENSED",
    entry_points={
        "console_scripts": [
            "waypoint_logger = waypoint_recorder.logger_node:main",
        ],
    },
)
