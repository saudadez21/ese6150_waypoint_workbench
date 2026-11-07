import { initHelp } from "./help.js";
import { initFileDrop } from "./file_drop.js";
import { initSidebar } from "./sidebar.js";
import { Api } from "./api.js";
import { MapEditCanvas } from "./map_canvas.js";
import { blankMapFiles, downloadMapZip, loadMapPair } from "./map_io.js";
import { MapImportSession } from "./map_import.js";
import { download } from "./preferences.js";

const $ = (id) => document.getElementById(id);
initSidebar();
initHelp("maps");
const api = new Api();
const mapImporter = new MapImportSession();
let activeMap = null;
let busy = false;
let toastTimeout;

function notice(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove("visible"), 3500);
}

async function run(action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (error) {
    notice(error.message || String(error), true);
  } finally {
    busy = false;
    render();
  }
}

const canvas = new MapEditCanvas($("canvas"), {
  onZoom: (zoom) => {
    $("zoomValue").textContent = `${Math.round(zoom * 100)}%`;
  },
  onCursor: ([x, y]) => {
    $("cursor").textContent = `Pixel X ${x.toFixed(0)} · Y ${y.toFixed(0)}`;
  },
  onHistory: render,
  onSample: (value) => {
    $("paintValue").value = value;
    options();
  },
  onError: (error) => notice(error.message, true),
});

function showMapProperties(map) {
  const details = $("mapProperties");
  details.open = false;
  $("mapPropertiesSection").classList.toggle("hidden", !map);
  if (!map) return;
  const fields = {
    propertyImage: map.imageName,
    propertySize: `${map.width} × ${map.height} px`,
    propertyResolution: `${map.resolution} m/px`,
    propertyOrigin: `[${map.origin.join(", ")}]`,
    propertyNegate: String(map.negate),
    propertyOccupied: String(map.occupiedThresh),
    propertyFree: String(map.freeThresh),
    propertyMode: map.mode,
  };
  for (const [id, value] of Object.entries(fields)) $(id).textContent = value;
}

function render() {
  document
    .querySelectorAll("[data-api-only]")
    .forEach((element) => element.classList.toggle("hidden", !api.online));
  $("emptyState").classList.toggle("hidden", Boolean(activeMap));
  $("undo").disabled = !canvas.canUndo;
  $("redo").disabled = !canvas.canRedo;
  $("refreshMaps").disabled = !api.online;
  $("loadApiMap").disabled = !api.online || !$("mapFiles").value;
  $("mapFiles").disabled = !api.online || $("mapFiles").options.length <= 1;
  $("reset").disabled = !activeMap;
  $("downloadMap").disabled = !activeMap;
  $("downloadAside").disabled = !activeMap;
  $("status").textContent = !activeMap
    ? "No map loaded"
    : `${activeMap.width} × ${activeMap.height} px · ${
        canvas.changed ? "Modified" : "Original"
      }`;
}

function options() {
  $("brushLabel").textContent = $("brushSize").value;
  const shape = ["rectangle", "ellipse"].includes($("paintShape").value);
  $("constructionSettings").classList.toggle("hidden", !shape);
  $("fillShape").disabled = !shape;
  $("brushSize").disabled = ["fill", "eyedropper", "pan"].includes(
    $("paintShape").value,
  );
  canvas.setOptions({
    mode: $("paintShape").value,
    value: $("paintValue").value,
    size: Number($("brushSize").value),
    filled: $("fillShape").checked,
    construction: $("constructionMode").value,
  });
}

async function refresh() {
  const previous = $("mapFiles").value;
  await api.connect();
  const names = api.online ? await api.list("maps") : null;
  const select = $("mapFiles");
  select.replaceChildren(new Option(names ? "Choose map" : "API unavailable", ""));
  for (const name of names || []) select.add(new Option(name, name));
  if (names?.includes(previous)) select.value = previous;
  select.disabled = !names?.length;
  $("loadApiMap").disabled = !select.value;
  render();
}

async function openMap(map) {
  if (canvas.changed && !confirm("Discard edits to the current map?")) return;
  activeMap = map;
  showMapProperties(map);
  mapImporter.clear();
  await canvas.setMap(map, map.image);
  showMapInfo();
  $("mapName").value = map.id;
  $("mapTitle").textContent = map.yamlName;
  options();
  render();
  return true;
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
  if (result.map) await openMap(result.map);
  else {
    showMapInfo(result.message);
    if (result.error) notice(result.message, true);
  }
}

async function exportMap() {
  if (!activeMap) return;
  const name = $("mapName").value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) {
    throw Error("Enter a valid map name");
  }
  const { archive, filename } = await downloadMapZip(
    activeMap,
    activeMap.cells,
    name,
    canvas.changed,
  );
  download(archive, filename);
  notice(`Downloaded ${filename}`);
}

function bind(id, action) {
  $(id).addEventListener("click", () => run(action));
}

async function main() {
  await refresh();
  showMapProperties(null);
  options();
  render();
  $("mapFiles").addEventListener("change", () => {
    $("loadApiMap").disabled = !$("mapFiles").value;
  });
  bind("refreshMaps", refresh);
  bind("loadApiMap", async () => {
    const item = await api.map($("mapFiles").value);
    await openMap(
      await loadMapPair(item.yaml_name, item.yaml_text, item.image_name, item.blob),
    );
  });
  bind("importMap", () => $("mapInput").click());
  bind("clearPendingMap", () => {
    mapImporter.clear();
    showMapInfo();
  });
  $("mapInput").addEventListener("change", () =>
    run(async () => {
      const files = [...$("mapInput").files];
      $("mapInput").value = "";
      if (files.length) await importMapFiles(files);
    }),
  );
  bind("newMap", () => {
    $("newMapDialog").showModal();
    $("newMapName").focus();
  });
  $("cancelNewMap").onclick = () => $("newMapDialog").close();
  let originEdited = false;
  const defaultOrigin = () => {
    if (originEdited) return;
    const width = Number($("newMapWidth").value);
    const height = Number($("newMapHeight").value);
    const resolution = Number($("newMapResolution").value);
    if ([width, height, resolution].every(Number.isFinite)) {
      $("newMapOriginX").value = String((-width * resolution) / 2);
      $("newMapOriginY").value = String((-height * resolution) / 2);
    }
  };
  for (const id of ["newMapWidth", "newMapHeight", "newMapResolution"]) {
    $(id).addEventListener("input", defaultOrigin);
  }
  for (const id of ["newMapOriginX", "newMapOriginY"]) {
    $(id).addEventListener("input", () => {
      originEdited = true;
    });
  }
  $("newMapDialog").addEventListener("close", () => {
    originEdited = false;
  });
  $("newMapForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const values = blankMapFiles({
        name: $("newMapName").value.trim(),
        width: Number($("newMapWidth").value),
        height: Number($("newMapHeight").value),
        resolution: Number($("newMapResolution").value),
        originX: Number($("newMapOriginX").value),
        originY: Number($("newMapOriginY").value),
      });
      const map = await loadMapPair(
        values.yamlName,
        values.yamlText,
        values.imageName,
        values.imageBlob,
      );
      if (await openMap(map)) $("newMapDialog").close();
    });
  });
  for (const id of [
    "paintValue",
    "paintShape",
    "constructionMode",
    "brushSize",
    "fillShape",
  ]) {
    $(id).addEventListener(id === "brushSize" ? "input" : "change", options);
  }
  bind("undo", () => {
    canvas.undo();
    render();
  });
  bind("redo", () => {
    canvas.redo();
    render();
  });
  bind("reset", () => {
    canvas.reset();
    render();
  });
  bind("downloadMap", exportMap);
  bind("downloadAside", exportMap);
  bind("zoomIn", () => canvas.zoomAt(canvas.width() / 2, canvas.height() / 2, 1.25));
  bind("zoomOut", () => canvas.zoomAt(canvas.width() / 2, canvas.height() / 2, 0.8));
  bind("fit", () => canvas.fit());
  document.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName))
      return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) canvas.redo();
      else canvas.undo();
      render();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      canvas.redo();
      render();
    } else if (event.key === "Escape" && canvas.hasPending) {
      event.preventDefault();
      canvas.cancelStroke();
      render();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (canvas.changed) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  initFileDrop($("dropZone"), (files) => run(() => importMapFiles(files)));
}
main().catch((error) => notice(error.message, true));
