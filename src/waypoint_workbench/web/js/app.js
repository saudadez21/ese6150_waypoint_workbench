import { Workspace, stats } from "./editor.js";
import { MapCanvas } from "./canvas.js";
const $ = (id) => document.getElementById(id);
const ws = new Workspace();
let config = null,
  currentMap = null,
  pendingImport = null,
  validationToken = 0,
  toastTimer = null;
let currentView = "normal",
  workingBusy = false;
const canvas = new MapCanvas($("mapCanvas"), {
  onZoom: () => {
    $("zoomText").textContent = (canvas.zoom * 100).toFixed(0) + "%";
  },
  onCursor: ([x, y]) => {
    $("cursor").textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)}`;
  },
  onSelection: () => updateSelection(),
  onAdd: ({ index, point }) => {
    try {
      ws.insertAt(index, point);
      changed("Point inserted");
    } catch (e) {
      notify(e.message, true);
    }
  },
  onDragEnd: (index, point) => {
    try {
      ws.changePoint(index, ...point);
      changed("Point moved");
    } catch (e) {
      notify(e.message, true);
    }
  },
});
canvas.setWorkspace(ws);
function notify(message, error = false) {
  const node = $("toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3600);
}
async function api(path, payload = null) {
  const options =
    payload == null
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        };
  const response = await fetch(path, options);
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error(`HTTP ${response.status}`);
  }
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  return result;
}
const task = async (fn) => {
  if (workingBusy) return;
  workingBusy = true;
  try {
    await fn();
  } catch (e) {
    notify(e.message || String(e), true);
  } finally {
    workingBusy = false;
  }
};
function values() {
  const t = ws.active;
  if (!t) throw Error("Load a waypoint track first");
  return { points: t.points, speed: t.speed };
}
function setOptions(select, list, emptyText, selected) {
  select.replaceChildren();
  if (!list.length) {
    select.add(new Option(emptyText, ""));
    return;
  }
  for (const item of list) select.add(new Option(item.label, item.value));
  if (selected && list.some((o) => o.value === selected)) select.value = selected;
}
async function refreshFiles() {
  // Script-generated CSVs and newly imported maps are only scanned on demand.
  const [waypoints, maps] = await Promise.all([
    api("/api/waypoints"),
    api("/api/maps"),
  ]);
  setOptions(
    $("files"),
    waypoints.files.map((x) => ({ label: x, value: x })),
    "No CSV in waypoints/",
    $("files").value,
  );
  setOptions(
    $("maps"),
    maps.maps.map((m) => ({ label: m.name, value: m.id })),
    "No maps found",
    currentMap?.id || $("maps").value,
  );
}
function trackName(t) {
  return t.name.length > 29 ? t.name.slice(0, 26) + "…" : t.name;
}
function renderTracks() {
  const host = $("tracks");
  host.replaceChildren();
  if (!ws.tracks.length) {
    host.innerHTML =
      '<div class="empty-text">No tracks loaded yet.<br>Import a CSV to begin.</div>';
    return;
  }
  for (const t of ws.tracks) {
    const node = document.createElement("div");
    node.className = "track" + (t === ws.active ? " active" : "");
    node.title = t.name;
    const line = document.createElement("div");
    line.className = "line";
    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.background = t.color;
    line.append(dot);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = trackName(t) + (t.changed ? " ●" : "");
    line.append(name);
    if (t === ws.active) {
      const flag = document.createElement("span");
      flag.className = "active-tag";
      flag.textContent = "EDIT";
      line.append(flag);
    }
    const eye = document.createElement("button");
    eye.textContent = t.visible ? "◉" : "◌";
    eye.title = t.visible ? "Hide" : "Show";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      t.visible = !t.visible;
      render();
    });
    line.append(eye);
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Remove from editor (not disk)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      ws.remove(t.id);
      changed("Track closed");
    });
    line.append(close);
    node.append(line);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${t.points.length} points  ·  ${
      t.speed ? "with speed" : "XY geometry"
    }`;
    node.append(meta);
    node.addEventListener("click", () => {
      ws.select(t.id);
      changed(null);
    });
    host.append(node);
  }
}
function updateSelection() {
  const t = ws.active,
    index = t?.selected,
    selected = index != null && index >= 0 && index < t.points.length;
  $("selectedIndex").textContent = selected ? "#" + index : "—";
  for (const el of [$("pointX"), $("pointY"), $("setStart"), $("delete")])
    el.disabled = !selected;
  $("pointX").value = selected ? t.points[index][0].toFixed(4) : "";
  $("pointY").value = selected ? t.points[index][1].toFixed(4) : "";
}
function updateMetrics() {
  const t = ws.active;
  $("metricPoints").innerHTML = t
    ? `<b>${t.points.length}</b> points`
    : "<b>—</b> points";
  if (!t) {
    $("metricLength").innerHTML = "<b>—</b> path length";
    $("metricGap").innerHTML = "<b>—</b> closure gap";
    $("loopChip").textContent = "NO TRACK";
    return;
  }
  const st = stats(t.points),
    closed = st.gap <= config.editor.closure_max_gap_m;
  $("metricLength").innerHTML = `<b>${st.length.toFixed(2)} m</b> loop length`;
  $("metricGap").innerHTML = `<b>${st.gap.toFixed(3)} m</b> closure gap`;
  $("loopChip").textContent = closed ? "CLOSED LOOP" : "OPEN · FIX ENDPOINTS";
  $("loopChip").style.color = closed ? "#a4ebcd" : "#ffb6aa";
}
function enabledState() {
  const t = ws.active,
    has = !!t;
  for (const id of ["undo", "redo", "reset", "save", "reverse"])
    $(id).disabled =
      !has || (id === "undo" && !t.undo.length) || (id === "redo" && !t.redo.length);
  $("trackCap").textContent = `${ws.tracks.length} / ${ws.limit}`;
  $("load").disabled = ws.tracks.length >= ws.limit;
  $("csvUpload").disabled = ws.tracks.length >= ws.limit;
  const speedRadio = document.querySelector('[name="display"][value="speed"]');
  speedRadio.disabled = !(ws.tracks.length === 1 && t?.speed);
  if (speedRadio.disabled && currentView === "speed") {
    currentView = "normal";
    document.querySelector('[name="display"][value="normal"]').checked = true;
    $("colorLegend").classList.add("hidden");
  }
}
async function validate() {
  const token = ++validationToken;
  if (currentView !== "clearance" || !ws.active || !currentMap) {
    canvas.clearance = null;
    canvas.draw();
    return;
  }
  $("clearanceInfo").textContent = "Calculating map distance field…";
  try {
    const result = await api("/api/validate", {
      points: ws.active.points,
      map_id: currentMap.id,
    });
    if (token !== validationToken) return;
    canvas.clearance = result;
    $("clearanceInfo").textContent =
      `Min clearance ${result.minimum_clearance_m.toFixed(2)} m · ${
        result.near_segments
      } near segments · ${
        result.collision_segments
      } collision segments. Informational only.`;
    canvas.draw();
  } catch (e) {
    if (token === validationToken) {
      canvas.clearance = null;
      $("clearanceInfo").textContent = e.message;
      canvas.draw();
    }
  }
}
function render() {
  renderTracks();
  updateSelection();
  updateMetrics();
  enabledState();
  updateLegend();
  canvas.display = currentView;
  canvas.closureLimit = config.editor.closure_max_gap_m;
  canvas.draw();
}
function changed(message) {
  ++validationToken;
  canvas.clearance = null;
  render();
  validate();
  if (message) notify(message);
}
function addTrack(parsed, name, source = null) {
  const t = ws.add(parsed, name, source);
  changed(`${name}: ${t.points.length} points loaded`);
  return t;
}
async function loadRemote(name, preset = "auto") {
  if (!name) return;
  try {
    const result = await api("/api/waypoints/load", { filename: name, preset });
    addTrack(result, name, name);
  } catch (e) {
    if (/layout preset|without a recognized header/i.test(e.message))
      openImportModal({ type: "remote", name });
    else throw e;
  }
}
async function persistCSV(name, text, preset = "auto") {
  if (ws.tracks.length >= ws.limit)
    throw Error(`Maximum ${ws.limit} tracks loaded; close a track before importing`);
  const parsed = await api("/api/waypoints/import", { filename: name, text, preset });
  addTrack(parsed, parsed.filename, parsed.filename);
  await refreshFiles();
  $("files").value = parsed.filename;
  notify(`Imported to waypoints/${parsed.filename}`);
}
async function importCSV(file, preset = "auto") {
  if (ws.tracks.length >= ws.limit)
    throw Error(`Maximum ${ws.limit} tracks loaded; close a track before importing`);
  const text = await file.text();
  if (new Blob([text]).size > 5_000_000) throw Error("CSV file is too large");
  try {
    await persistCSV(file.name, text, preset);
  } catch (e) {
    if (/layout preset|without a recognized header/i.test(e.message))
      openImportModal({ type: "csv", name: file.name, text });
    else throw e;
  }
}
function openImportModal(info) {
  pendingImport = info;
  $("importDescription").textContent =
    `${info.name}: choose the column order for a numeric CSV without a recognized header.`;
  $("importPreset").value = "xy_yaw_v";
  $("importModal").classList.remove("hidden");
}
async function loadMap(id) {
  if (!id) return;
  const meta = await api("/api/maps/" + encodeURIComponent(id));
  const img = new Image();
  img.src = meta.imageUrl;
  await img.decode();
  currentMap = meta;
  canvas.setMap(meta, img);
  $("mapInfo").textContent = `${meta.width} × ${meta.height} px · ${
    meta.resolution
  } m/px · origin (${meta.origin
    .slice(0, 2)
    .map((n) => n.toFixed(2))
    .join(", ")})`;
  $("mapChip").textContent = meta.id.toUpperCase();
  canvas.clearance = null;
  validate();
}
async function uploadMap(files) {
  const yaml = files.find((f) => /\.ya?ml$/i.test(f.name));
  const image = files.find((f) => /\.(pgm|png|jpe?g)$/i.test(f.name));
  if (!yaml || !image)
    throw Error("Select YAML and corresponding PGM/PNG image together");
  const data = new FormData();
  data.append("yaml", yaml);
  data.append("image", image);
  const r = await fetch("/api/maps/upload", { method: "POST", body: data });
  const meta = await r.json();
  if (!r.ok) throw Error(meta.error || "Map import failed");
  $("maps").add(new Option(meta.id, meta.id));
  $("maps").value = meta.id;
  await loadMap(meta.id);
  notify("Saved maps/" + yaml.name + " and " + image.name);
}
function numeric(id) {
  const n = Number($(id).value);
  if (!Number.isFinite(n)) throw Error("Invalid number: " + id);
  return n;
}
function event(id, fn) {
  $(id).addEventListener("click", () => task(fn));
}
function updateLegend() {
  if (currentView === "speed" && ws.active?.speed) {
    const v = ws.active.speed;
    $("legendMin").textContent = Math.min(...v).toFixed(2) + " m/s";
    $("legendMax").textContent = Math.max(...v).toFixed(2) + " m/s";
  } else if (currentView === "clearance" && config) {
    $("legendMin").textContent = "0 m (collision)";
    const threshold = config.vehicle.width_m / 2 + config.clearance.safety_margin_m;
    $("legendMax").textContent = "≥ " + threshold.toFixed(2) + " m";
  }
}
function setView(view) {
  currentView = view;
  canvas.display = view;
  canvas.clearance = null;
  const legend = $("colorLegend");
  legend.classList.toggle("hidden", view === "normal");
  updateLegend();
  canvas.draw();
  validate();
}
async function main() {
  const response = await api("/api/bootstrap");
  config = response.config;
  ws.limit = config.editor.max_tracks;
  ws.colors = config.editor.track_colors;
  setOptions(
    $("maps"),
    response.maps.map((m) => ({ label: m.name, value: m.id })),
    "No maps found",
    response.default_map,
  );
  setOptions(
    $("files"),
    response.waypoints.map((m) => ({ label: m, value: m })),
    "No CSV in waypoints/",
    response.default_waypoint,
  );
  if ($("maps").value) await loadMap($("maps").value);
  if (response.default_waypoint) await loadRemote(response.default_waypoint);
  render();
  $("maps").addEventListener("change", () => task(() => loadMap($("maps").value)));
  event("load", () => loadRemote($("files").value));
  event("refreshFiles", async () => {
    await refreshFiles();
    notify("Refreshed maps/ and waypoints/");
  });
  event("csvUpload", () => {
    $("csvInput").click();
  });
  $("csvInput").addEventListener("change", () =>
    task(async () => {
      for (const file of $("csvInput").files) {
        await importCSV(file);
      }
      $("csvInput").value = "";
    }),
  );
  event("mapUpload", () => {
    $("mapInput").click();
  });
  $("mapInput").addEventListener("change", () =>
    task(async () => {
      await uploadMap([...$("mapInput").files]);
      $("mapInput").value = "";
    }),
  );
  document.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      document
        .querySelectorAll("[data-mode]")
        .forEach((el) => el.classList.remove("active"));
      b.classList.add("active");
      canvas.setMode(b.dataset.mode);
    }),
  );
  event("zoomIn", () => canvas.zoomAt(canvas.width() / 2, canvas.height() / 2, 1.25));
  event("zoomOut", () => canvas.zoomAt(canvas.width() / 2, canvas.height() / 2, 0.8));
  event("fit", () => canvas.fit());
  event("reverse", () => {
    ws.reverse();
    changed("Reversed direction; existing speeds invalidated");
  });
  event("undo", () => {
    if (ws.undo()) changed("Undo");
  });
  event("redo", () => {
    if (ws.redo()) changed("Redo");
  });
  event("reset", () => {
    if (ws.reset()) changed("Restored original loaded state");
  });
  event("delete", () => {
    ws.deletePoint(ws.active?.selected);
    changed("Point deleted");
  });
  event("setStart", () => {
    ws.startAt(ws.active?.selected);
    changed("Set new index 0");
  });
  for (const [i, id] of ["pointX", "pointY"].entries())
    $(id).addEventListener("change", () =>
      task(async () => {
        const t = ws.active;
        if (t?.selected == null) return;
        const p = [...t.points[t.selected]];
        p[i] = numeric(id);
        ws.changePoint(t.selected, ...p);
        changed("Updated coordinate");
      }),
    );
  event("save", async () => {
    const t = ws.active;
    if (!t) return;
    const defaultName = t.name.replace(/\.csv$/i, "") + "_edited";
    const name = prompt(
      "Save As filename inside waypoints/ (non-overwriting)",
      defaultName,
    );
    if (name === null) return;
    const result = await api("/api/waypoints/save", { ...values(), filename: name });
    await refreshFiles();
    notify("Saved waypoints/" + result.filename);
  });
  document
    .querySelectorAll('[name="display"]')
    .forEach((el) => el.addEventListener("change", () => setView(el.value)));
  $("cancelImport").addEventListener("click", () => {
    $("importModal").classList.add("hidden");
    pendingImport = null;
  });
  $("confirmImport").addEventListener("click", () =>
    task(async () => {
      if (!pendingImport) return;
      const info = pendingImport,
        preset = $("importPreset").value;
      if (info.type === "remote") await loadRemote(info.name, preset);
      else await persistCSV(info.name, info.text, preset);
      pendingImport = null;
      $("importModal").classList.add("hidden");
    }),
  );
  document.addEventListener("keydown", (e) => {
    if (
      pendingImport ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
    )
      return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey ? ws.redo() : ws.undo()) changed("History updated");
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      if (ws.redo()) changed("Redo");
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (ws.active?.selected != null) {
        e.preventDefault();
        try {
          ws.deletePoint(ws.active.selected);
          changed("Point deleted");
        } catch (err) {
          notify(err.message, true);
        }
      }
    }
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    $("dropZone").classList.remove("hidden");
  });
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget == null) $("dropZone").classList.add("hidden");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropZone").classList.add("hidden");
    task(async () => {
      const files = [...e.dataTransfer.files];
      if (files.some((f) => /\.ya?ml$/i.test(f.name))) await uploadMap(files);
      for (const file of files.filter((f) => /\.csv$/i.test(f.name)))
        await importCSV(file);
    });
  });
}
main().catch((e) => notify("Initialization failed: " + e.message, true));
