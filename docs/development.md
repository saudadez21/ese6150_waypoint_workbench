# Development guide

## 1. Run the application (no development tools)

From the repository root, with Python 3.10+:

```bash
uv run python -m waypoint_workbench
```

Or, without uv, in a virtual environment:

```bash
python -m pip install -e .
python -m waypoint_workbench
```

Open `http://127.0.0.1:5050`. See the root [README](../README.md) for usage,
ROS 2 build steps and waypoint recorder commands.

## 2. Set up a developer environment

Use one of the following options **from the repository root**.

### With uv (recommended)

```bash
uv sync --extra dev
uv run --extra dev pre-commit install
```

`uv sync --extra dev` installs the Python runtime dependencies **plus** pytest,
Ruff and pre-commit.

If you only want to run the formatter and lint checks manually:

```bash
uv run --extra dev ruff check --fix .
uv run --extra dev ruff format .
uv run --extra dev pre-commit run --all-files
```

### With pip

```bash
python -m pip install -e ".[dev]"
pre-commit install
```

Manual checks:

```bash
ruff check --fix .
ruff format .
pre-commit run --all-files
```

**First run needs internet access** to fetch the pinned hook environments,
including the web formatter (Prettier).

## 3. What runs before a commit

- **Ruff**: fixes safe lint problems and sorts Python imports, then formats
  Python files (including the standalone ROS 2 recorder). Settings are in
  `pyproject.toml`: Python 3.10 target, 88-character lines, 4-space indentation,
  double quotes, and a focused set of lint rules.
- **Prettier**: formats `src/waypoint_workbench/web/` JS, HTML and CSS with
  two-space indentation; settings are in `.prettierrc.json`.
- **pre-commit-hooks**: trim trailing spaces, ensure a newline at end of file,
  normalize line endings to LF, validate JSON/YAML/TOML, check merge-conflict
  markers and reject accidentally committed files above 4 MiB. Existing map
  samples are deliberately allowed.

If any hook modifies your staged files, pre-commit **stops the commit**. This is
expected: inspect the diff, stage the updated files, and commit again:

```bash
git diff
git add path/to/changed-file.py
git commit -m "your message"
```

To run everything before staging/committing:

```bash
uv run --extra dev pre-commit run --all-files
```

**Note:** pre-commit checks *staged* files by default. It is not a continuous
background formatter. Run the commands above when you want a full-repo cleanup.
