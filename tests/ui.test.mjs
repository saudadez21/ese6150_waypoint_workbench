import assert from "node:assert/strict";
import { test } from "node:test";

test("shared sidebar can resize, collapse and persist its state", async () => {
  const { initSidebar } = await import("../web/js/sidebar.js");
  const previous = {
    document: globalThis.document, window: globalThis.window,
    localStorage: globalThis.localStorage,
  };
  const handlers = {};
  const classes = new Set();
  const properties = {};
  const layout = {
    style: { setProperty(name, value) { properties[name] = value; } },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
  };
  const attributes = {};
  const divider = {
    addEventListener(name, callback) { handlers[`divider-${name}`] = callback; },
    setPointerCapture() {},
    setAttribute(key, value) { attributes[key] = value; },
  };
  const toggleIcon = { href: "", setAttribute(key, value) { if (key === "href") this.href = value; } };
  const toggle = {
    addEventListener(name, callback) { handlers[`toggle-${name}`] = callback; },
    setAttribute(key, value) { attributes[key] = value; },
    querySelector(selector) { assert.equal(selector, "use"); return toggleIcon; },
  };
  const data = new Map();
  globalThis.localStorage = {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
  };
  globalThis.document = {
    querySelector() { return layout; },
    getElementById(id) { return id === "sidebarDivider" ? divider : toggle; },
  };
  globalThis.window = {
    innerWidth: 1440, matchMedia() { return { matches: false }; },
    addEventListener() {},
  };
  try {
    initSidebar();
    assert.equal(properties["--sidebar-width"], "280px");
    assert.equal(toggleIcon.href, "./assets/icons.svg#panel-left-close");
    const drag = (clientX) => ({ button: 0, pointerId: 1, clientX, preventDefault() {} });
    handlers["divider-pointerdown"](drag(280));
    handlers["divider-pointermove"](drag(360));
    handlers["divider-pointerup"](drag(360));
    assert.equal(properties["--sidebar-width"], "360px");
    handlers["toggle-click"]();
    assert.ok(classes.has("sidebar-collapsed"));
    assert.equal(attributes["aria-expanded"], "false");
    assert.equal(toggleIcon.href, "./assets/icons.svg#panel-left-open");
    handlers["toggle-click"]();
    assert.ok(!classes.has("sidebar-collapsed"));
    assert.equal(toggleIcon.href, "./assets/icons.svg#panel-left-close");
    assert.equal(data.get("waypoint_workbench_sidebar_width"), "360");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("help lists shared canvas shortcuts", async () => {
  const { HELP_SHORTCUTS } = await import("../web/js/help.js");
  assert.ok(HELP_SHORTCUTS.waypoints.some(([name]) => name === "Ctrl/Cmd + click"));
  assert.ok(HELP_SHORTCUTS.waypoints.some(([name]) => name === "Shift + click"));
  assert.ok(HELP_SHORTCUTS.waypoints.some(([name]) => name === "Drag empty area"));
  assert.ok(HELP_SHORTCUTS.maps.some(([name]) => name === "Shift + ellipse"));
});

test("file drop only handles external files and clears overlay after drop", async () => {
  const { hasFileTransfer, initFileDrop } = await import("../web/js/file_drop.js");
  assert.equal(hasFileTransfer(null), false);
  assert.equal(hasFileTransfer({ types: ["text/plain"] }), false);
  assert.equal(hasFileTransfer({ types: ["Files"] }), true);

  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const documentHandlers = new Map();
  const windowHandlers = new Map();
  const classes = new Set(["hidden"]);
  const imported = [];
  try {
    globalThis.document = {
      addEventListener: (name, handler) => documentHandlers.set(name, handler),
    };
    globalThis.window = {
      addEventListener: (name, handler) => windowHandlers.set(name, handler),
    };
    const overlay = {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    };
    initFileDrop(overlay, (files) => imported.push(files));

    let prevented = false;
    const textDrag = {
      dataTransfer: { types: ["text/plain"] },
      preventDefault: () => { prevented = true; },
    };
    documentHandlers.get("dragenter")(textDrag);
    assert.equal(prevented, false);
    assert.equal(classes.has("hidden"), true);

    const item = { name: "track.csv" };
    const fileDrag = {
      dataTransfer: { types: ["Files"], files: [item], dropEffect: "none" },
      preventDefault: () => { prevented = true; },
    };
    documentHandlers.get("dragenter")(fileDrag);
    assert.equal(classes.has("hidden"), false);
    documentHandlers.get("dragover")(fileDrag);
    assert.equal(fileDrag.dataTransfer.dropEffect, "copy");
    documentHandlers.get("drop")(fileDrag);
    assert.deepEqual(imported, [[item]]);
    assert.equal(classes.has("hidden"), true);
    windowHandlers.get("blur")();
    assert.equal(classes.has("hidden"), true);
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

test("both editor HTML pages include empty states and initially hidden API controls", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["index.html", "map-editor.html"]) {
    const html = await readFile(new URL(`../web/${file}`, import.meta.url), "utf8");
    assert.match(html, /id="emptyState"/);
    assert.match(html, /Drop files to import/);
    assert.match(html, /class="api-controls hidden" data-api-only/);
    assert.match(html, /id="dropZone" class="drop-zone hidden"/);
  }
});

test("sidebar API refresh buttons use titled SVG icons and full-width actions", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const page of ["index.html", "map-editor.html"]) {
    const html = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    const heading = /<div class="section-title-row">\s*<h2>MAP<\/h2>\s*<button[^>]+id="refreshMaps"[^>]+data-api-only[^>]*>/.test(html);
    assert.equal(heading, true, `${page}: map refresh must follow MAP heading`);
    assert.match(html, /id="refreshMaps"[^>]+aria-label="Refresh maps"/);
    assert.match(html, /id="loadApiMap"[^>]*>[\s\S]*?<use href="\.\/assets\/icons\.svg#folder-down"/);
    assert.match(html, /class="button wide" id="loadApiMap"/);
    assert.match(html, /class="button wide" id="new(?:Map|Waypoint)"/);
    assert.match(html, /class="button wide primary" id="import(?:Map|Csv)"/);
    assert.doesNotMatch(html, /class="button-row api-actions"/);
    assert.match(html, /<use href="\.\/assets\/icons\.svg#refresh-cw"/);
  }
  const waypoints = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(waypoints, /<h2>WAYPOINTS<\/h2>\s*<button[^>]+id="refreshWaypoints"[^>]+data-api-only/);
  assert.match(waypoints, /aria-label="Refresh waypoints"/);
  assert.match(waypoints, /class="button wide" id="loadApiWaypoint"/);
  const icon = await readFile(new URL("../web/assets/icons.svg", import.meta.url), "utf8");
  assert.match(icon, /<symbol id="refresh-cw" viewBox="0 0 24 24">/);
  assert.match(icon, /Lucide Icons/);
});

test("editor action buttons have consistent local SVG icons", async () => {
  const { readFile } = await import("node:fs/promises");
  const cases = {
    "index.html": {
      newWaypoint: "plus", importCsv: "folder-open", importMap: "folder-open",
      loadApiMap: "folder-down", loadApiWaypoint: "folder-down",
      uploadMap: "upload", uploadWaypoint: "upload", download: "download",
      undo: "undo-2", redo: "redo-2",
    },
    "map-editor.html": {
      newMap: "plus", importMap: "folder-open", loadApiMap: "folder-down",
      downloadMap: "download", downloadAside: "download",
      undo: "undo-2", redo: "redo-2",
    },
  };
  for (const [page, buttons] of Object.entries(cases)) {
    const html = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    for (const [id, icon] of Object.entries(buttons)) {
      const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?<\/button>`));
      assert.ok(button, `${page}: missing ${id}`);
      assert.ok(button[0].includes(`icons.svg#${icon}`), `${page}: ${id} icon`);
    }
    for (const id of ["undo", "redo"]) {
      const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
      assert.ok(button[0].includes(`aria-label="${id === "undo" ? "Undo" : "Redo"}"`));
      assert.ok(button[0].includes("icon-only"));
    }
    assert.equal((html.match(/icons\.svg#file-up/g) || []).length, 2);
    assert.doesNotMatch(html, /class="import-symbol" aria-hidden="true">↓/);
  }
  const sprite = await readFile(new URL("../web/assets/icons.svg", import.meta.url), "utf8");
  for (const id of ["refresh-cw", "plus", "folder-open", "folder-down",
    "upload", "download", "undo-2", "redo-2", "file-up"]) {
    assert.ok(sprite.includes(`id="${id}"`), `sprite missing ${id}`);
  }
});

test("track list keeps long filenames separate from fixed icon buttons", async () => {
  const { readFile } = await import("node:fs/promises");
  const js = await readFile(new URL("../web/js/waypoints_page.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  const sprite = await readFile(new URL("../web/assets/icons.svg", import.meta.url), "utf8");
  assert.match(js, /filename\.title = track\.filename/);
  assert.match(js, /filename\.className = "track-filename"/);
  assert.match(js, /content\.className = "track-details"/);
  assert.match(js, /createIcon\(track\.visible \? "eye" : "eye-off"\)/);
  assert.match(js, /remove\.append\(createIcon\("x"\)\)/);
  assert.match(js, /remove\.title = "Close track"/);
  assert.match(js, /card\.classList\.toggle\("track-hidden", !track\.visible\)/);
  assert.match(css, /\.track-details \{[^}]*min-width: 0/);
  assert.match(css, /\.track-filename \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.track-card \.track-action \{[^}]*flex: 0 0 30px/);
  for (const id of ["eye", "eye-off", "x"]) {
    assert.ok(sprite.includes(`<symbol id="${id}"`), `${id} missing from icon sprite`);
  }
});

test("sidebar and config share the local SVG icon set", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const page of ["index.html", "map-editor.html"]) {
    const html = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    assert.match(html, /id="toggleSidebar"[^>]*>[\s\S]*?icons\.svg#panel-left-close/);
    assert.doesNotMatch(html, /id="toggleSidebar"[^>]*>‹/);
  }
  const config = await readFile(new URL("../web/config.html", import.meta.url), "utf8");
  assert.match(config, /id="maxTracks"/);
  assert.match(config, /id="addAlias"[^>]*>[\s\S]*?icons\.svg#plus/);
  const configJS = await readFile(new URL("../web/js/config_page.js", import.meta.url), "utf8");
  assert.match(configJS, /createIcon\("x"\)/);
  assert.match(configJS, /aria-label", "Remove mapping"/);
  const sprite = await readFile(new URL("../web/assets/icons.svg", import.meta.url), "utf8");
  for (const id of ["panel-left-close", "panel-left-open", "plus", "x"]) {
    assert.ok(sprite.includes(`<symbol id="${id}"`));
  }
});

test("map editor exposes the drawing construction mode and 3 px brush", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../web/map-editor.html", import.meta.url), "utf8");
  assert.match(html, /id="brushSize"[^>]*value="3"/);
  assert.match(html, /id="constructionMode"/);
  assert.match(html, /<option value="3-point">3-Point<\/option>/);
  const { HELP_SHORTCUTS } = await import("../web/js/help.js");
  for (const shortcut of ["Shift + rectangle", "Shift + ellipse", "Shift + line", "3-Point mode"]) {
    assert.ok(HELP_SHORTCUTS.maps.some(([name]) => name === shortcut));
  }
});

test("map properties are collapsed by default and show all ROS metadata read-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../web/map-editor.html", import.meta.url), "utf8");
  assert.match(html, /<section class="properties-section hidden" id="mapPropertiesSection">/);
  assert.match(html, /<details class="map-properties" id="mapProperties">/);
  assert.doesNotMatch(html, /<details[^>]*id="mapProperties"[^>]*\sopen(?:\s|>)/);
  for (const id of [
    "propertyImage", "propertySize", "propertyResolution", "propertyOrigin",
    "propertyNegate", "propertyOccupied", "propertyFree", "propertyMode",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /accept="\.yaml,\.yml,\.pgm,\.png,\.bmp,\.zip"/);
});

test("Waypoint Editor accepts BMP and YML map files", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../web/js/waypoints_page.js", import.meta.url), "utf8");
  assert.match(html, /accept="\.yaml,\.yml,\.pgm,\.png,\.bmp,\.zip"/);
  assert.match(html, /YAML \+ PGM\/PNG\/BMP/);
  assert.match(source, /ya\?ml\|pgm\|png\|bmp\|zip/);
});
