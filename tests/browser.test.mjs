import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvColumnsError, parseCSV, targetFor, writeCSV } from "../web/js/csv.js";
import { DEFAULTS, validatePreferences } from "../web/js/preferences.js";
import { Tracks } from "../web/js/tracks.js";
import { insertion, stats } from "../web/js/geometry.js";
import {
  parseYaml, updateYamlImage, zipFiles, downloadMapZip, extractMapZip,
} from "../web/js/map_io.js";
import { MapPaint } from "../web/js/map_paint.js";

const aliases = DEFAULTS.aliases;
const input = [
  "# s,x_m,y_m,psi,kappa,v,a,team_comment",
  "0,1,2,0.1,0.3,3,0.01,start",
  "1,2,3,0.2,0.4,4,0.02,middle",
  "2,3,4,0.3,0.5,5,0.03,end",
  "",
].join("\n");

test("CSV aliases map x_m, y_m and psi without layout selection", () => {
  assert.equal(targetFor("x_m", aliases), "x");
  assert.equal(targetFor("psi", aliases), "yaw");
  const result = parseCSV(input, aliases);
  assert.deepEqual(result.points[0], [1, 2]);
  assert.deepEqual(result.speed, [3, 4, 5]);
  assert.deepEqual(result.otherColumns, ["s", "kappa", "a", "team_comment"]);
  assert.equal(result.extraRows[1][7], "middle");
});

test("unmodified CSV round-trips exactly, including unrelated columns", () => {
  assert.equal(writeCSV(parseCSV(input, aliases)), input);
  const lines = "x;y;quality\r\n1;2;great\r\n3;4;good\r\n";
  assert.equal(writeCSV(parseCSV(lines, aliases)), lines);
});

test("CSV decimal places default to 6 and validate as whole numbers from 0 to 12", () => {
  assert.equal(DEFAULTS.csvDecimalPlaces, 6);
  assert.equal(validatePreferences({}).csvDecimalPlaces, 6);
  for (const places of [0, 6, 12]) {
    assert.equal(validatePreferences({ csvDecimalPlaces: places }).csvDecimalPlaces, places);
  }
  for (const places of [-1, 13, 2.5, "6", null]) {
    assert.throws(() => validatePreferences({ csvDecimalPlaces: places }), /CSV decimal places/);
  }
});

test("CSV export rounds regenerated coordinates without trailing zeros or negative zero", () => {
  const track = { points: [[1.123456789, -0.0000002], [10, 2.5]] };
  assert.equal(writeCSV(track), "x,y\n1.123457,0\n10,2.5\n");
  assert.equal(writeCSV(track, 3), "x,y\n1.123,0\n10,2.5\n");
  assert.equal(writeCSV(track, 0), "x,y\n1,0\n10,3\n");
  assert.equal(writeCSV(track, 12), "x,y\n1.123456789,-0.0000002\n10,2.5\n");
  assert.throws(() => writeCSV(track, 13), /CSV decimal places/);
});

test("CSV precision only affects edited geometry, not imported files or undo", () => {
  const original = "x,y,comment\n1.123456789,2.987654321,alpha\n3,4,beta\n";
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV(original, aliases), "precise.csv");
  assert.equal(writeCSV(tracks.active, 0), original);
  tracks.movePoint(0, [1.123456789, -0.0000002]);
  assert.equal(writeCSV(tracks.active), "x,y\n1.123457,0\n3,4\n");
  assert.equal(writeCSV(tracks.active, 2), "x,y\n1.12,0\n3,4\n");
  assert.deepEqual(tracks.active.points[0], [1.123456789, -0.0000002]);
  tracks.undo();
  assert.equal(writeCSV(tracks.active, 2), original);
});

test("users can remove or add aliases", () => {
  const removed = { ...aliases };
  delete removed.x_m;
  assert.throws(() => parseCSV(input, removed), (error) =>
    error instanceof CsvColumnsError && error.missing.includes("x"));
  const custom = { ...removed, x_m: "x", team_column: "other" };
  assert.deepEqual(parseCSV(input, custom).points[2], [3, 4]);
});

test("headerless XY works, ambiguous N-column input fails with a clear message", () => {
  assert.deepEqual(parseCSV("1,2\n3,4\n").points, [[1, 2], [3, 4]]);
  assert.throws(() => parseCSV("1,2,3\n4,5,6\n"), (error) =>
    error instanceof CsvColumnsError && /Headerless/.test(error.message));
});

test("missing required columns produces actionable error", () => {
  assert.throws(() => parseCSV("position,vy\n1,2\n3,4\n", aliases), (error) =>
    error instanceof CsvColumnsError && error.missing.join() === "x,y");
});

test("the CSV parser accepts quoted commas in unknown columns", () => {
  const original = 'x,y,note\n1,2,"fast, straight"\n2,3,"hairpin"\n';
  const result = parseCSV(original, aliases);
  assert.equal(result.extraRows[0][2], "fast, straight");
  assert.equal(writeCSV(result), original);
});

test("track geometry edits clear speed and other columns; undo restores all", () => {
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV(input, aliases), "raceline.csv");
  tracks.movePoint(1, [4, 5]);
  assert.equal(tracks.active.speed, null);
  assert.deepEqual(tracks.active.otherColumns, []);
  assert.equal(writeCSV(tracks.active).split("\n")[0], "x,y");
  tracks.undo();
  assert.equal(writeCSV(tracks.active), input);
  assert.deepEqual(tracks.active.speed, [3, 4, 5]);
  tracks.redo();
  assert.equal(tracks.active.speed, null);
});

test("Set Start and Reverse invalidate dependent columns", () => {
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV(input, aliases), "raceline.csv");
  tracks.setStart(1);
  assert.equal(tracks.active.points[0][0], 2);
  assert.equal(tracks.active.speed, null);
  tracks.undo();
  tracks.reverse();
  assert.equal(tracks.active.points[0][0], 3);
  assert.equal(tracks.active.originalCSV, null);
});

test("open path insertion preserves clicked world coordinates", () => {
  const points = [[0, 0], [1, 0], [1, 2]];
  assert.deepEqual(insertion(points, [0.4, 0.6], false).point, [0.4, 0.6]);
  assert.equal(stats(points, 0.2).length, 3);
});

test("map YAML original filename stays unchanged", () => {
  const yaml = "image: photo.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n";
  assert.equal(parseYaml(yaml).image, "photo.pgm");
  assert.equal(updateYamlImage(yaml, "new.pgm").split("\n")[0], "image: new.pgm");
});

test("map ZIP keeps original YAML and PGM names", async () => {
  const content = new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 255]);
  const map = {
    id: "original", yamlName: "original.yaml", imageName: "photo.pgm",
    yamlText: "image: photo.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n",
    imageBlob: new Blob([content]), width: 1, height: 1,
  };
  const { archive, filename } = await downloadMapZip(map);
  assert.match(filename, /^original_\d{8}_\d{6}\.zip$/);
  const names = new TextDecoder().decode(await archive.arrayBuffer());
  assert.ok(names.includes("/original.yaml"));
  assert.ok(names.includes("/photo.pgm"));
  // Node provides File in recent versions; ZIP parser uses it to recreate local pair.
  const { File } = await import("node:buffer");
  const files = await extractMapZip(new File([archive], filename));
  assert.deepEqual(files.map((file) => file.name), ["original.yaml", "photo.pgm"]);
  assert.equal(await files[0].text(), map.yamlText);
});

test("map painting uses changesets and undo", () => {
  const paint = new MapPaint(4, 4, new Uint8Array(16).fill(255));
  paint.begin(); paint.point(2, 2, paint.value("wall")); paint.commit();
  assert.equal(paint.changed, true);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.redo();
  assert.equal(paint.changed, true);
});

test("preference mapping objects validate deletion and custom rows", () => {
  const result = validatePreferences({ aliases: { custom_easting: "x", custom_northing: "y" } });
  assert.deepEqual(result.aliases, { custom_easting: "x", custom_northing: "y" });
  assert.throws(() => validatePreferences({ aliases: { foo: "invalid" } }), /Invalid CSV alias/);
});

test("ZIP writer handles filenames and contents", async () => {
  const archive = zipFiles([["foo/file.txt", "abc"]]);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
});

test("multiple heading aliases remain importable and retain the extra column", () => {
  const csv = "x,y,theta,psi,v\n1,2,0,0.1,3\n2,3,0,0.2,4\n";
  const parsed = parseCSV(csv, aliases);
  assert.deepEqual(parsed.otherColumns, ["psi"]);
  assert.equal(writeCSV(parsed), csv);
});

test("track limit follows editable color slots, up to 64", () => {
  const colors = DEFAULTS.colors;
  assert.equal(colors.length, 8);
  assert.equal(validatePreferences({ colors }).colors.length, 8);
  assert.equal(validatePreferences({ colors: Array(64).fill("#123456") }).colors.length, 64);
  assert.throws(() => validatePreferences({ colors: Array(65).fill("#123456") }), /1–64/);
  assert.throws(() => validatePreferences({ colors: [] }), /1–64/);
  const tracks = new Tracks({ ...DEFAULTS, colors: colors.slice(0, 2) });
  const csv = parseCSV("x,y\n1,2\n3,4\n", aliases);
  tracks.add(csv, "one.csv");
  tracks.add(csv, "two.csv");
  assert.throws(() => tracks.add(csv, "three.csv"), /Maximum 2 tracks/);
});

test("generated track colors are valid and distinct from defaults", async () => {
  const { nextTrackColor } = await import("../web/js/preferences.js");
  const next = nextTrackColor(DEFAULTS.colors);
  assert.match(next, /^#[0-9a-f]{6}$/i);
  assert.ok(!DEFAULTS.colors.some((color) => color.toLowerCase() === next.toLowerCase()));
});

test("filled and outlined ellipses can be undone", () => {
  const paint = new MapPaint(30, 30, new Uint8Array(900).fill(255));
  paint.begin();
  paint.ellipse(4, 4, 24, 20, 1, paint.value("wall"), true);
  paint.commit();
  assert.equal(paint.pixels[12 * 30 + 14], 0);
  assert.equal(paint.pixels[0], 255);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.begin();
  paint.ellipse(4, 4, 24, 20, 1, paint.value("wall"), false);
  paint.commit();
  assert.equal(paint.pixels[12 * 30 + 14], 255);
  assert.equal(paint.changed, true);
  paint.undo();
  assert.equal(paint.changed, false);
});

test("bucket fill affects only contiguous matching pixels and can be undone", () => {
  const pixels = new Uint8Array([
    255, 255, 0, 255,
    255, 255, 0, 255,
    0, 0, 0, 255,
    255, 255, 0, 255,
  ]);
  const paint = new MapPaint(4, 4, pixels);
  paint.begin();
  paint.floodFill(0, 0, paint.value("unknown"));
  paint.commit();
  assert.equal(paint.pixels[0], 205);
  assert.equal(paint.pixels[5], 205);
  assert.equal(paint.pixels[3], 255);
  assert.equal(paint.pixels[12], 255);
  paint.undo();
  assert.deepEqual([...paint.pixels], [...pixels]);
});

test("eyedropper returns nearest occupancy category without changing pixels", () => {
  const pixels = new Uint8Array([0, 254, 205, 20, 210]);
  const paint = new MapPaint(5, 1, pixels);
  assert.equal(paint.sample(0, 0), "wall");
  assert.equal(paint.sample(1, 0), "free");
  assert.equal(paint.sample(2, 0), "unknown");
  assert.equal(paint.sample(20, 0), null);
  assert.deepEqual([...paint.pixels], [...pixels]);
});

test("Shift constrains an ellipse's bounding box to a square", async () => {
  const { MapEditCanvas } = await import("../web/js/map_canvas.js");
  const canvas = Object.create(MapEditCanvas.prototype);
  canvas.mode = "ellipse";
  assert.deepEqual(canvas.shapeEnd([12, 12], [27, 18], true), [27, 27]);
  assert.deepEqual(canvas.shapeEnd([12, 12], [4, 10], true), [4, 4]);
  assert.deepEqual(canvas.shapeEnd([12, 12], [27, 18], false), [27, 18]);
});

test("right drag pans the map without painting", async () => {
  const { MapEditCanvas } = await import("../web/js/map_canvas.js");
  const view = Object.create(MapEditCanvas.prototype);
  const paint = new MapPaint(20, 20, new Uint8Array(400).fill(255));
  view.canvas = { style: {}, setPointerCapture() {} };
  view.paint = paint;
  view.map = { width: 20, height: 20 };
  view.mode = "brush";
  view.spaceHeld = false;
  view.panX = 0;
  view.panY = 0;
  view.zoom = 1;
  view.draw = () => {};
  view.callbacks = {};
  const event = (button, offsetX, offsetY) => ({
    button, pointerId: 3, offsetX, offsetY, preventDefault() {}, shiftKey: false,
  });
  view.pointerDown(event(2, 7, 6));
  view.pointerMove(event(2, 17, 11));
  view.pointerUp(event(2, 17, 11));
  assert.deepEqual([view.panX, view.panY], [10, 5]);
  assert.equal(paint.changed, false);
  assert.equal(view.drag, null);
  // Space + left drag also pans, without changing the active tool.
  view.spaceHeld = true;
  view.pointerDown(event(0, 15, 10));
  view.pointerMove(event(0, 25, 20));
  view.pointerUp(event(0, 25, 20));
  assert.deepEqual([view.panX, view.panY], [20, 15]);
  assert.equal(view.mode, "brush");
  assert.equal(paint.changed, false);
});

test("bucket-fill over the stroke pixel cap is rejected without partial changes", () => {
  const paint = new MapPaint(1000, 800, new Uint8Array(800_000).fill(255));
  paint.begin();
  assert.throws(() => paint.floodFill(0, 0, 0), /too large/);
  paint.cancel();
  assert.equal(paint.changed, false);
  assert.equal(paint.pixels[0], 255);
  assert.equal(paint.pixels[799_999], 255);
});

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
  const toggle = {
    addEventListener(name, callback) { handlers[`toggle-${name}`] = callback; },
    setAttribute(key, value) { attributes[key] = value; },
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
    const drag = (clientX) => ({ button: 0, pointerId: 1, clientX, preventDefault() {} });
    handlers["divider-pointerdown"](drag(280));
    handlers["divider-pointermove"](drag(360));
    handlers["divider-pointerup"](drag(360));
    assert.equal(properties["--sidebar-width"], "360px");
    handlers["toggle-click"]();
    assert.ok(classes.has("sidebar-collapsed"));
    assert.equal(attributes["aria-expanded"], "false");
    handlers["toggle-click"]();
    assert.ok(!classes.has("sidebar-collapsed"));
    assert.equal(data.get("waypoint_workbench_sidebar_width"), "360");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("waypoint multi-selection supports toggle, index range and additive box", () => {
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV("x,y\n0,0\n1,0\n2,0\n3,0\n4,0\n5,0\n", aliases), "track.csv");
  tracks.setSelection([1], 1);
  tracks.toggleSelection(4);
  assert.deepEqual(tracks.active.selection, [1, 4]);
  tracks.toggleSelection(1);
  assert.deepEqual(tracks.active.selection, [4]);
  tracks.rangeSelection(2);
  assert.deepEqual(tracks.active.selection, [2, 3, 4]);
  tracks.boxSelection([0, 5], true);
  assert.deepEqual(tracks.active.selection, [0, 2, 3, 4, 5]);
  tracks.boxSelection([1, 2]);
  assert.deepEqual(tracks.active.selection, [1, 2]);
  tracks.clearSelection();
  assert.deepEqual(tracks.active.selection, []);
});

test("moving multiple waypoints is one undo and clears dependent columns", () => {
  const csv = "x,y,theta,v,notes\n0,0,0,2,a\n1,0,0,3,b\n2,0,0,4,c\n3,0,0,5,d\n";
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV(csv, aliases), "track.csv");
  tracks.setSelection([1, 3], 3);
  assert.equal(tracks.translateSelection(0.25, -0.1), true);
  assert.deepEqual(tracks.active.points, [[0, 0], [1.25, -0.1], [2, 0], [3.25, -0.1]]);
  assert.equal(tracks.active.undo.length, 1);
  assert.equal(tracks.active.speed, null);
  assert.deepEqual(tracks.active.selection, [1, 3]);
  assert.equal(tracks.translateSelection(0, 0), false);
  assert.equal(tracks.active.undo.length, 1);
  tracks.undo();
  assert.equal(writeCSV(tracks.active), csv);
  assert.deepEqual(tracks.active.selection, [1, 3]);
  tracks.redo();
  assert.deepEqual(tracks.active.points[3], [3.25, -0.1]);
  assert.deepEqual(tracks.active.selection, [1, 3]);
});

test("multi-point deletion is one undo and respects minimum track size", () => {
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV("x,y\n0,0\n1,0\n2,0\n3,0\n4,0\n", aliases), "track.csv");
  tracks.setSelection([1, 3]);
  tracks.deleteSelection();
  assert.deepEqual(tracks.active.points, [[0, 0], [2, 0], [4, 0]]);
  assert.equal(tracks.active.undo.length, 1);
  tracks.undo();
  assert.equal(tracks.active.points.length, 5);
  tracks.setSelection([0, 1, 2, 3]);
  assert.throws(() => tracks.deleteSelection(), /at least two points/);
  assert.equal(tracks.active.points.length, 5);
});

test("waypoint canvas box select, group drag, right pan and space pan", async () => {
  const { MapCanvas } = await import("../web/js/waypoint_canvas.js");
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV("x,y\n10,10\n20,20\n30,30\n40,40\n", aliases), "track.csv");
  const view = Object.create(MapCanvas.prototype);
  view.canvas = { style: {}, setPointerCapture() {}, focus() {} };
  view.workspace = tracks;
  view.mode = "select";
  view.display = "normal";
  view.spaceHeld = false;
  view.panX = 0;
  view.panY = 0;
  view.draw = () => {};
  view.screen = (p) => p;
  view.toWorld = (x, y) => [x, y];
  view.hideTooltip = () => {};
  view.cb = {
    onSelect: (indices, primary) => tracks.setSelection(indices, primary),
    onBoxSelection: (indices, extend) => tracks.boxSelection(indices, extend),
    onDragEnd: (dx, dy) => tracks.translateSelection(dx, dy),
  };
  const event = (button, x, y, options = {}) => ({
    button, offsetX: x, offsetY: y, pointerId: 1, preventDefault() {}, ...options,
  });
  // Empty-space box captures points 1 and 2 without changing point geometry.
  view.down(event(0, 12, 32));
  view.move(event(0, 35, 15));
  view.up(event(0, 35, 15));
  assert.deepEqual(tracks.active.selection, [1, 2]);
  assert.equal(tracks.active.undo.length, 0);
  // Drag one selected point; the entire selected group moves in one operation.
  view.down(event(0, 20, 20));
  view.move(event(0, 25, 17));
  view.up(event(0, 25, 17));
  assert.deepEqual(tracks.active.points, [[10, 10], [25, 17], [35, 27], [40, 40]]);
  assert.equal(tracks.active.undo.length, 1);
  // Right-drag pans, even when Select is active, and never moves points.
  view.down(event(2, 20, 20));
  view.move(event(2, 30, 25));
  view.up(event(2, 30, 25));
  assert.deepEqual([view.panX, view.panY], [10, 5]);
  assert.equal(tracks.active.undo.length, 1);
  // Space + left-drag shares the same pan behavior.
  view.spaceHeld = true;
  view.down(event(0, 8, 8));
  view.move(event(0, 12, 16));
  view.up(event(0, 12, 16));
  assert.deepEqual([view.panX, view.panY], [14, 13]);
});

test("point hover shows index and coordinate values without editing", async () => {
  const { MapCanvas } = await import("../web/js/waypoint_canvas.js");
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV("x,y,v\n1,2,3\n4,5,6\n", aliases), "speed.csv");
  const hidden = new Set(["hidden"]);
  const tooltip = {
    classList: {
      add(key) { hidden.add(key); },
      remove(key) { hidden.delete(key); },
    },
    offsetWidth: 140, offsetHeight: 50, style: {}, textContent: "",
  };
  const view = Object.create(MapCanvas.prototype);
  view.workspace = tracks;
  view.tooltip = tooltip;
  view.width = () => 300;
  view.height = () => 300;
  view.showTooltip(1, 20, 30);
  assert.match(tooltip.textContent, /Point #1/);
  assert.match(tooltip.textContent, /X: 4.000 m/);
  assert.match(tooltip.textContent, /Y: 5.000 m/);
  assert.match(tooltip.textContent, /v: 6.000 m\/s/);
  assert.ok(!hidden.has("hidden"));
  view.hideTooltip();
  assert.ok(hidden.has("hidden"));
});

test("help includes the agreed shared canvas shortcuts", async () => {
  const { HELP_SHORTCUTS } = await import("../web/js/help.js");
  assert.ok(HELP_SHORTCUTS.waypoints.some(([name]) => name === "Ctrl/Cmd + click"));
  assert.ok(HELP_SHORTCUTS.waypoints.some(([name]) => name === "Shift + click"));
  assert.ok(HELP_SHORTCUTS.waypoints.some(([name]) => name === "Drag empty area"));
  assert.ok(HELP_SHORTCUTS.maps.some(([name]) => name === "Shift + ellipse"));
});

test("new track starts empty, appends in order, and undoes to zero points", () => {
  const tracks = new Tracks(DEFAULTS);
  const track = tracks.create("sketch");
  assert.equal(track.filename, "sketch.csv");
  assert.deepEqual(track.points, []);
  tracks.insert(0, [0, 0]);
  tracks.insert(1, [2, 0]);
  tracks.insert(2, [2, 3]);
  assert.equal(writeCSV(track), "x,y\n0,0\n2,0\n2,3\n");
  tracks.undo();
  tracks.undo();
  tracks.undo();
  assert.deepEqual(track.points, []);
  tracks.redo();
  assert.deepEqual(track.points, [[0, 0]]);
  assert.throws(() => tracks.create("sketch"), /already loaded/);
  assert.throws(() => tracks.create("../bad"), /Invalid track name/);
});

test("append always uses the end; insert follows nearest segment", async () => {
  const { MapCanvas } = await import("../web/js/waypoint_canvas.js");
  const view = Object.create(MapCanvas.prototype);
  const captures = [];
  view.mode = "add";
  view.spaceHeld = false;
  view.canvas = { focus() {} };
  view.toWorld = (x, y) => [x, y];
  view.cb = { onAdd: (item) => captures.push(item) };
  view.workspace = { active: { points: [[0, 0], [10, 0], [10, 10]] } };
  view.addMode = "append";
  view.down({ button: 0, offsetX: 5, offsetY: 0, preventDefault() {} });
  assert.equal(captures.at(-1).index, 3);
  view.addMode = "insert";
  view.closureLimit = 0.75;
  view.down({ button: 0, offsetX: 5, offsetY: 0, preventDefault() {} });
  assert.equal(captures.at(-1).index, 1);
  view.workspace.active.points = [];
  view.down({ button: 0, offsetX: 6, offsetY: 8, preventDefault() {} });
  assert.deepEqual(captures.at(-1), { index: 0, point: [6, 8] });
});

function mockMapCanvas() {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {},
      }),
    }),
  };
  return () => { globalThis.document = previous; };
}

test("new map is entirely Free with centered origin and original filenames", async () => {
  const { blankMapFiles, mapFromFiles } = await import("../web/js/map_io.js");
  const { File } = await import("node:buffer");
  const pair = blankMapFiles({
    name: "test_track", width: 20, height: 10, resolution: 0.05, originX: -0.5, originY: -0.25,
  });
  const doc = parseYaml(pair.yamlText);
  assert.deepEqual(doc.origin, [-0.5, -0.25, 0]);
  assert.equal(doc.image, "test_track.pgm");
  const image = new Uint8Array(await pair.imageBlob.arrayBuffer());
  assert.ok(image.slice(image.length - 200).every((pixel) => pixel === 255));
  const restore = mockMapCanvas();
  try {
    const map = await mapFromFiles([
      new File([pair.yamlText], pair.yamlName),
      new File([image], pair.imageName),
    ]);
    assert.equal(map.width, 20);
    assert.equal(map.height, 10);
  } finally { restore(); }
  assert.throws(() => blankMapFiles({
    name: "unsafe/name", width: 10, height: 10, resolution: 0.05, originX: 0, originY: 0,
  }), /Invalid map name/);
});

test("map import retains YAML or image selected in separate steps", async () => {
  const { MapImportSession } = await import("../web/js/map_import.js");
  const { File } = await import("node:buffer");
  const yaml = new File(["image: scan.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n"], "map.yaml");
  const image = new File([new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 255])], "scan.pgm");
  const session = new MapImportSession();
  const first = await session.add([image]);
  assert.equal(first.map, null);
  assert.match(first.message, /waiting for YAML/);
  assert.equal(session.pending, true);
  const restore = mockMapCanvas();
  try {
    const second = await session.add([yaml]);
    assert.equal(second.map.yamlName, "map.yaml");
    assert.equal(session.pending, false);
    const reverseFirst = await session.add([yaml]);
    assert.match(reverseFirst.message, /waiting for scan.pgm/);
    const wrong = await session.add([new File(["anything"], "wrong.pgm")]);
    assert.match(wrong.message, /YAML expects scan.pgm/);
    assert.equal(session.pending, true);
    const reverseSecond = await session.add([image]);
    assert.equal(reverseSecond.map.width, 1);
    assert.equal(session.pending, false);
  } finally { restore(); }
});

test("ZIP import accepts a single map pair and rejects extras or unsafe paths", async () => {
  const { MapImportSession } = await import("../web/js/map_import.js");
  const { File } = await import("node:buffer");
  const yaml = "image: photo.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n";
  const image = new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 255]);
  const good = new File([zipFiles([
    ["stamp/map.yaml", yaml], ["stamp/photo.pgm", image],
  ])], "map.zip");
  const restore = mockMapCanvas();
  try {
    const session = new MapImportSession();
    const { map } = await session.add([good]);
    assert.equal(map.yamlName, "map.yaml");
    assert.equal(session.pending, false);
    for (const files of [
      [["map.yaml", yaml], ["photo.pgm", image], ["notes.txt", "not a map"]],
      [["../map.yaml", yaml], ["../photo.pgm", image]],
      [["other/map.yaml", yaml], ["different/photo.pgm", image]],
      [["map.yaml", yaml], ["wrong.pgm", image]],
    ]) {
      await assert.rejects(() => session.add([
        new File([zipFiles(files)], "invalid.zip"),
      ]));
    }
  } finally { restore(); }
});
