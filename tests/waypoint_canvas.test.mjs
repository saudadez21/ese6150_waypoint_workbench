import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCSV } from "../web/js/csv.js";
import { DEFAULTS } from "../web/js/preferences.js";
import { Tracks } from "../web/js/tracks.js";
import { MapCanvas } from "../web/js/waypoint_canvas.js";

const aliases = DEFAULTS.aliases;

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

test("Speed legend combines visible tracks and ignores hidden tracks",()=>{
  const tracks=new Tracks({...DEFAULTS,maxTracks:3});
  const a=tracks.add(parseCSV("x,y,v\n0,0,1\n1,1,4\n"),"a.csv");
  const b=tracks.add(parseCSV("x,y,v\n0,0,10\n1,1,20\n"),"b.csv");
  const canvas=Object.create(MapCanvas.prototype);
  canvas.workspace=tracks;
  assert.deepEqual(canvas.speedRange(),[1,20]);
  a.visible=false;
  assert.deepEqual(canvas.speedRange(),[10,20]);
  b.visible=false;
  assert.deepEqual(canvas.speedRange(),[0,1]);
});
