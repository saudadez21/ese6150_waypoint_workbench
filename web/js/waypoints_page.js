import { initSidebar } from "./sidebar.js";
import { initHelp } from "./help.js";
import { Api, sameBytes } from "./api.js";
import { CsvColumnsError, parseCSV, writeCSV } from "./csv.js";
import { Tracks, selectedIndices } from "./tracks.js";
import { MapCanvas } from "./waypoint_canvas.js";
import { loadMapPair } from "./map_io.js";
import { MapImportSession } from "./map_import.js";
import { download, readPreferences } from "./preferences.js";

const $ = (id) => document.getElementById(id);
initSidebar();
initHelp("waypoints");
const config = readPreferences();
const api = new Api();
const tracks = new Tracks(config);
const mapImporter = new MapImportSession();
let activeMap = null;
let display = "normal";
let busy = false;
let toastTimeout;
let lastSelectionKey = "";

function notice(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove("visible"), 3500);
}

function csvError(error) {
  $("csvErrorText").textContent =
    error.message +
    (error.missing?.length
      ? `. Required fields: ${error.missing.join(
          ", ",
        )}. Check the CSV header or add aliases in Config.`
      : "");
  $("csvError").classList.remove("hidden");
}

async function run(action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (error) {
    if (error instanceof CsvColumnsError) csvError(error);
    else notice(error.message || String(error), true);
    render();
  } finally {
    busy = false;
    render();
  }
}

const canvas = new MapCanvas($("canvas"), {
  tooltip: $("pointTooltip"),
  onZoom: (value) => {
    $("zoomValue").textContent = `${Math.round(value * 100)}%`;
  },
  onCursor: ([x, y]) => {
    $("cursor").textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)}`;
  },
  onSelection: renderSelection,
  onSelect: (indices, primary) => {
    tracks.setSelection(indices, primary);
    renderSelection();
  },
  onToggleSelection: (index) => {
    tracks.toggleSelection(index);
    renderSelection();
  },
  onRangeSelection: (index) => {
    tracks.rangeSelection(index);
    renderSelection();
  },
  onBoxSelection: (indices, extend) => {
    tracks.boxSelection(indices, extend);
    renderSelection();
  },
  onAdd: ({ index, point }) => {
    tracks.insert(index, point);
    render();
  },
  onDragEnd: (dx, dy) => {
    tracks.translateSelection(dx, dy);
    render();
  },
});
canvas.closureLimit = config.closureGap;
canvas.setWorkspace(tracks);

function renderSelection() {
  const track = tracks.active;
  const indices = selectedIndices(track);
  const count = indices.length;
  let description = "No selection";
  if (count === 1) {
    const point = track.points[indices[0]];
    description = `Point #${indices[0]} · X ${point[0].toFixed(
      3,
    )} · Y ${point[1].toFixed(3)}`;
  } else if (count > 1) {
    const consecutive = indices.at(-1) - indices[0] + 1 === count;
    description = consecutive
      ? `Points #${indices[0]}–#${indices.at(-1)} · ${count} selected`
      : `${count} points selected · #${indices[0]}–#${indices.at(-1)}`;
  }
  $("selectionInfo").textContent = description;
  for (const id of [
    "deltaX",
    "deltaY",
    "moveSelection",
    "deletePoint",
    "clearSelection",
  ]) {
    $(id).disabled = !count;
  }
  $("setStart").disabled = count !== 1;
  const key = `${track?.id ?? ""}:${indices.join(",")}`;
  if (key !== lastSelectionKey) {
    $("deltaX").value = "0";
    $("deltaY").value = "0";
    lastSelectionKey = key;
  }
}

function renderTracks() {
  const target = $("tracks");
  target.replaceChildren();
  if (!tracks.items.length) {
    const label = document.createElement("p");
    label.className = "empty";
    label.textContent = "No tracks loaded";
    target.append(label);
  }
  for (const track of tracks.items) {
    const card = document.createElement("div");
    card.className = `track-card${track.id === tracks.activeId ? " active" : ""}`;
    card.onclick = () => {
      tracks.select(track.id);
      render();
    };
    const color = document.createElement("input");
    color.type = "color";
    color.className = "track-color";
    color.value = track.color;
    color.title = "Track color";
    color.onclick = (e) => e.stopPropagation();
    color.oninput = (e) => {
      e.stopPropagation();
      track.color = color.value;
      canvas.draw();
    };
    const content = document.createElement("span");
    content.className = "track-name";
    content.textContent = track.filename;
    const small = document.createElement("small");
    small.className = "track-meta";
    small.textContent = `${track.points.length} points${
      track.dirty ? " · modified" : ""
    }`;
    content.append(small);
    const eye = document.createElement("button");
    eye.textContent = track.visible ? "◉" : "○";
    eye.title = track.visible ? "Hide track" : "Show track";
    eye.setAttribute("aria-label", eye.title);
    eye.onclick = (e) => {
      e.stopPropagation();
      track.visible = !track.visible;
      render();
    };
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Remove track";
    remove.onclick = (e) => {
      e.stopPropagation();
      if (track.dirty && !confirm(`Discard edits to ${track.filename}?`)) return;
      tracks.remove(track.id);
      render();
    };
    card.append(color, content, eye, remove);
    target.append(card);
  }
  $("trackCount").textContent =
    `${tracks.items.length} / ${config.colors.length} tracks`;
}

function render() {
  canvas.hideTooltip();
  const track = tracks.active;
  renderTracks();
  renderSelection();
  $("download").disabled = !track || track.points.length < 2;
  $("reverse").disabled = !track || track.points.length < 2;
  $("reset").disabled = !track;
  $("refreshMaps").disabled = !api.online;
  $("refreshWaypoints").disabled = !api.online;
  $("mapFiles").disabled = !api.online || $("mapFiles").options.length <= 1;
  $("waypointFiles").disabled = !api.online || $("waypointFiles").options.length <= 1;
  updateFileButtons();
  $("undo").disabled = !track?.undo.length;
  $("redo").disabled = !track?.redo.length;
  $("uploadWaypoint").disabled =
    !track ||
    track.points.length < 2 ||
    !api.online ||
    !(api.capabilities.waypoint_create || api.capabilities.waypoint_replace);
  $("uploadMap").disabled =
    !activeMap ||
    !api.online ||
    !(api.capabilities.map_create || api.capabilities.map_replace);
  const speed = tracks.items.length === 1 && Array.isArray(track?.speed);
  const speedInput = document.querySelector('[name="display"][value="speed"]');
  speedInput.disabled = !speed;
  if (!speed && display === "speed") {
    display = "normal";
    document.querySelector('[name="display"][value="normal"]').checked = true;
  }
  canvas.display = display;
  $("legend").classList.toggle("hidden", display !== "speed");
  if (speed && display === "speed") {
    $("lowSpeed").textContent = `${Math.min(...track.speed).toFixed(2)} m/s`;
    $("highSpeed").textContent = `${Math.max(...track.speed).toFixed(2)} m/s`;
  }
  const { length, gap, closed } = tracks.measurements();
  $("measurements").textContent = track
    ? `${length.toFixed(2)} m · Gap ${gap.toFixed(3)} m · ${closed ? "Closed" : "Open"}`
    : "";
  $("status").textContent = track
    ? `${track.filename} · ${track.points.length} points`
    : "No track loaded";
  canvas.draw();
}

function setOptions(selectId, filenames) {
  const selection = $(selectId);
  const previous = selection.value;
  selection.replaceChildren(
    new Option(filenames ? "Choose file" : "API unavailable", ""),
  );
  for (const filename of filenames || []) selection.add(new Option(filename, filename));
  selection.disabled = !filenames?.length;
  if (filenames?.includes(previous)) selection.value = previous;
  selection.onchange?.();
}

async function refresh(kind) {
  await api.connect();
  if (api.online) {
    const names = await api.list(kind);
    setOptions(kind === "maps" ? "mapFiles" : "waypointFiles", names);
  } else {
    setOptions("mapFiles", null);
    setOptions("waypointFiles", null);
  }
  updateFileButtons();
  render();
}

function updateFileButtons() {
  $("loadApiMap").disabled = !api.online || !$("mapFiles").value;
  $("loadApiWaypoint").disabled =
    !api.online ||
    !$("waypointFiles").value ||
    tracks.items.length >= config.colors.length;
}

async function openMap(map, source) {
  mapImporter.clear();
  activeMap = { ...map, source };
  canvas.setMap(activeMap, activeMap.image);
  showMapInfo();
  render();
}

function showMapInfo(message = "") {
  $("mapInfo").textContent =
    message ||
    (activeMap
      ? `${activeMap.yamlName} · ${activeMap.width} × ${activeMap.height} px · ${activeMap.resolution} m/px`
      : "No map loaded");
  $("clearPendingMap").classList.toggle("hidden", !mapImporter.pending);
}

async function importMapFiles(files) {
  const result = await mapImporter.add(files);
  if (result.map) await openMap(result.map, { type: "local" });
  else showMapInfo(result.message);
}

async function openCSV(text, filename, source) {
  const parsed = parseCSV(text, config.aliases);
  tracks.add(parsed, filename, source);
  if (!activeMap && tracks.items.length === 1) canvas.fit();
  render();
}

async function importFiles(files) {
  const mapItems = files.filter((file) => /\.(ya?ml|pgm|png|zip)$/i.test(file.name));
  if (mapItems.length) await importMapFiles(mapItems);
  for (const file of files.filter((item) => /\.csv$/i.test(item.name))) {
    await openCSV(await file.text(), file.name, { type: "local" });
  }
}

async function uploadWaypoint() {
  const track = tracks.active;
  if (!track || !api.online) return;
  const name = track.filename;
  const text = writeCSV(track, config.csvDecimalPlaces);
  const names = await api.list("waypoints");
  if (!names.includes(name)) {
    if (!api.capabilities.waypoint_create) throw Error("Waypoint creation is disabled");
    const result = await api.uploadWaypoint(name, text);
    track.source = { type: "api", name, etag: result.etag };
    track.dirty = false;
    notice(`Uploaded ${name}`);
  } else {
    const remote = await api.waypoint(name);
    if (remote.text === text) {
      notice("Waypoint is up to date");
      return;
    }
    if (!api.capabilities.waypoint_replace)
      throw Error("Waypoint replacement is disabled by server settings");
    if (track.source?.type === "api" && track.source.etag !== remote.etag) {
      throw Error("Server file changed since it was loaded. Reload before replacing.");
    }
    if (!confirm(`Replace ${name} on the API? The previous CSV will be backed up.`))
      return;
    const result = await api.uploadWaypoint(name, text, remote.etag);
    track.source = { type: "api", name, etag: result.etag };
    track.dirty = false;
    notice(`Replaced ${name} · backup created`);
  }
  await refresh("waypoints");
}

async function uploadMap() {
  if (!activeMap || !api.online) return;
  const map = activeMap;
  const names = await api.list("maps");
  if (!names.includes(map.yamlName)) {
    if (!api.capabilities.map_create) throw Error("Map creation is disabled");
    const result = await api.uploadMap(map);
    map.source = { type: "api", name: map.yamlName, etag: result.etag };
    notice(`Uploaded ${map.yamlName}`);
  } else {
    const remote = await api.map(map.yamlName);
    const a = new Uint8Array(await map.imageBlob.arrayBuffer());
    const b = new Uint8Array(await remote.blob.arrayBuffer());
    if (
      map.yamlText === remote.yaml_text &&
      map.imageName === remote.image_name &&
      sameBytes(a, b)
    ) {
      notice("Map is up to date");
      return;
    }
    if (!api.capabilities.map_replace)
      throw Error("Map replacement is disabled by server settings");
    if (map.source?.type === "api" && map.source.etag !== remote.etag) {
      throw Error("Server map changed since it was loaded. Reload before replacing.");
    }
    if (
      !confirm(
        `Replace ${map.yamlName} on the API? The old map will be backed up as ZIP.`,
      )
    )
      return;
    const result = await api.uploadMap(map, remote.etag);
    map.source = { type: "api", name: map.yamlName, etag: result.etag };
    notice(`Replaced ${map.yamlName} · ZIP backup created`);
  }
  await refresh("maps");
}

function setTool(mode) {
  document
    .querySelectorAll("[data-mode]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.mode === mode),
    );
  $("addModeWrap").classList.toggle("hidden", mode !== "add");
  canvas.setMode(mode);
}

function setAddMode(mode) {
  canvas.addMode = mode;
  document
    .querySelectorAll("[data-add-mode]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.addMode === mode),
    );
}

function bind(id, action) {
  $(id).addEventListener("click", () => run(action));
}

async function main() {
  await Promise.all([refresh("maps"), refresh("waypoints")]);
  $("mapFiles").addEventListener("change", updateFileButtons);
  $("waypointFiles").addEventListener("change", updateFileButtons);
  bind("refreshMaps", () => refresh("maps"));
  bind("refreshWaypoints", () => refresh("waypoints"));
  bind("loadApiMap", async () => {
    const item = await api.map($("mapFiles").value);
    await openMap(
      await loadMapPair(item.yaml_name, item.yaml_text, item.image_name, item.blob),
      { type: "api", name: item.yaml_name, etag: item.etag },
    );
  });
  bind("loadApiWaypoint", async () => {
    const filename = $("waypointFiles").value;
    const item = await api.waypoint(filename);
    await openCSV(item.text, filename, {
      type: "api",
      name: filename,
      etag: item.etag,
    });
  });
  bind("importMap", () => $("mapInput").click());
  bind("clearPendingMap", () => {
    mapImporter.clear();
    showMapInfo();
  });
  bind("importCsv", () => $("csvInput").click());
  bind("newWaypoint", () => {
    let name = "new_track";
    let index = 2;
    while (tracks.items.some((track) => track.filename === `${name}.csv`)) {
      name = `new_track_${index++}`;
    }
    $("newTrackName").value = name;
    $("newTrackDialog").showModal();
  });
  $("cancelNewTrack").onclick = () => $("newTrackDialog").close();
  $("newTrackForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(() => {
      const name = $("newTrackName").value.trim();
      tracks.create(name);
      $("newTrackDialog").close();
      setAddMode("append");
      setTool("add");
      if (!activeMap && tracks.items.length === 1) canvas.fit();
      render();
    });
  });
  $("mapInput").addEventListener("change", () =>
    run(async () => {
      await importFiles([...$("mapInput").files]);
      $("mapInput").value = "";
    }),
  );
  $("csvInput").addEventListener("change", () =>
    run(async () => {
      await importFiles([...$("csvInput").files]);
      $("csvInput").value = "";
    }),
  );
  bind("uploadMap", uploadMap);
  bind("uploadWaypoint", uploadWaypoint);
  bind("download", () => {
    const t = tracks.active;
    download(
      new Blob([writeCSV(t, config.csvDecimalPlaces)], {
        type: "text/csv;charset=utf-8",
      }),
      t.filename,
    );
  });
  bind("undo", () => {
    tracks.undo();
    render();
  });
  bind("redo", () => {
    tracks.redo();
    render();
  });
  bind("reset", () => {
    tracks.reset();
    render();
  });
  bind("reverse", () => {
    tracks.reverse();
    render();
  });
  bind("deletePoint", () => {
    tracks.deleteSelection();
    render();
  });
  bind("clearSelection", () => {
    tracks.clearSelection();
    render();
  });
  bind("setStart", () => {
    tracks.setStart(tracks.active?.selected);
    render();
  });
  bind("moveSelection", () => {
    const dx = Number($("deltaX").value);
    const dy = Number($("deltaY").value);
    if (
      !$("deltaX").value.trim() ||
      !$("deltaY").value.trim() ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy)
    ) {
      throw Error("Enter valid ΔX and ΔY values");
    }
    tracks.translateSelection(dx, dy);
    $("deltaX").value = "0";
    $("deltaY").value = "0";
    render();
  });
  for (const id of ["deltaX", "deltaY"]) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $("moveSelection").click();
      }
    });
  }
  document
    .querySelectorAll("[data-mode]")
    .forEach((button) =>
      button.addEventListener("click", () => setTool(button.dataset.mode)),
    );
  document
    .querySelectorAll("[data-add-mode]")
    .forEach((button) =>
      button.addEventListener("click", () => setAddMode(button.dataset.addMode)),
    );
  document.querySelectorAll('[name="display"]').forEach((input) =>
    input.addEventListener("change", () => {
      display = input.value;
      render();
    }),
  );
  bind("zoomIn", () => canvas.zoomAt(canvas.width() / 2, canvas.height() / 2, 1.25));
  bind("zoomOut", () => canvas.zoomAt(canvas.width() / 2, canvas.height() / 2, 0.8));
  bind("fit", () => canvas.fit());
  $("dismissCsvError").onclick = () => $("csvError").classList.add("hidden");
  document.addEventListener("keydown", (event) => {
    const focused = document.activeElement;
    if (
      ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(focused?.tagName) ||
      focused?.isContentEditable ||
      document.querySelector("dialog[open]")
    )
      return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) tracks.redo();
      else tracks.undo();
      render();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      tracks.redo();
      render();
    } else if (
      mod &&
      event.key.toLowerCase() === "a" &&
      focused === $("canvas") &&
      canvas.mode === "select" &&
      display === "normal"
    ) {
      event.preventDefault();
      const track = tracks.active;
      if (track) tracks.setSelection(track.points.map((_, index) => index));
      render();
    } else if (
      ["Delete", "Backspace"].includes(event.key) &&
      selectedIndices(tracks.active).length
    ) {
      event.preventDefault();
      run(() => {
        tracks.deleteSelection();
        render();
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (canvas.drag) {
        canvas.cancel({ pointerId: canvas.drag.pointerId });
      } else tracks.clearSelection();
      render();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (tracks.items.some((track) => track.dirty)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    $("dropZone").classList.remove("hidden");
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) $("dropZone").classList.add("hidden");
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    $("dropZone").classList.add("hidden");
    run(() => importFiles([...event.dataTransfer.files]));
  });
  render();
}
main().catch((error) => notice(error.message, true));
