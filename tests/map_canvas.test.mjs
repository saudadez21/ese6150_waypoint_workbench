import assert from "node:assert/strict";
import { test } from "node:test";
import { MapPaint } from "../web/js/map_paint.js";

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
  const paint = new MapPaint(20, 20, new Int8Array(400).fill(0));
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

async function mapViewForInput(mode, { construction = "drag", filled = false } = {}) {
  const { MapEditCanvas } = await import("../web/js/map_canvas.js");
  const view = Object.create(MapEditCanvas.prototype);
  view.canvas = { style: {}, setPointerCapture() {}, focus() {} };
  view.paint = new MapPaint(80, 80, new Int8Array(6400).fill(0));
  view.map = { width: 80, height: 80 };
  view.mode = mode;
  view.value = "wall";
  view.brushSize = 3;
  view.construction = construction;
  view.filled = filled;
  view.drag = null;
  view.lineAnchor = null;
  view.shapePoints = [];
  view.preview = null;
  view.spaceHeld = false;
  view.shiftHeld = false;
  view.panX = 0;
  view.panY = 0;
  view.zoom = 1;
  view.draw = () => {};
  view.syncPixels = () => { view.paint.drainDirty(); };
  view.callbacks = {};
  return view;
}

function pointer(button, x, y, { shiftKey = false, detail = 1 } = {}) {
  return {
    button, offsetX: x, offsetY: y, pointerId: 1, shiftKey, detail,
    preventDefault() {},
  };
}

function mapClick(view, x, y, config = {}) {
  const e = pointer(0, x, y, config);
  view.pointerDown(e);
  view.pointerUp(e);
}

function mapDrag(view, x0, y0, x1, y1, config = {}) {
  const start = pointer(0, x0, y0, config);
  const end = pointer(0, x1, y1, config);
  view.pointerDown(start);
  view.pointerMove(end);
  view.pointerUp(end);
}

test("line click-click continues with one undo step per segment", async () => {
  const view = await mapViewForInput("line");
  mapClick(view, 10, 10);
  assert.equal(view.paint.changed, false);
  assert.deepEqual(view.lineAnchor, [10, 10]);
  mapClick(view, 20, 10);
  mapClick(view, 20, 20);
  assert.equal(view.paint.undoStack.length, 2);
  assert.equal(view.paint.cells[10 * 80 + 15], 100);
  assert.equal(view.paint.cells[15 * 80 + 20], 100);
  view.paint.undo();
  assert.equal(view.paint.cells[15 * 80 + 20], 0);
  assert.equal(view.paint.cells[10 * 80 + 15], 100);
  // A subsequent double-click terminates the chain without writing more pixels.
  view.pointerDown(pointer(0, 20, 20, { detail: 2 }));
  assert.equal(view.lineAnchor, null);
});

test("line dblclick terminates a chain even when pointer detail is zero", async () => {
  const { MapEditCanvas } = await import("../web/js/map_canvas.js");
  const oldWindow = globalThis.window;
  const oldResizeObserver = globalThis.ResizeObserver;
  const listeners = {};
  globalThis.window = { addEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} };
  try {
    const element = {
      getContext() { return {}; }, parentElement: {}, style: {},
      addEventListener(name, handler) { listeners[name] = handler; },
      focus() {}, setPointerCapture() {},
    };
    const view = new MapEditCanvas(element);
    view.paint = new MapPaint(80, 80, new Int8Array(6400).fill(0));
    view.map = { width: 80, height: 80 };
    view.mode = "line";
    view.value = "wall";
    view.panX = 0;
    view.panY = 0;
    view.zoom = 1;
    let redraws = 0;
    view.draw = () => { redraws++; };
    view.syncPixels = () => { view.paint.drainDirty(); };
    view.updateCursor = () => {};

    mapClick(view, 10, 10, { detail: 0 });
    mapClick(view, 20, 10, { detail: 0 });
    assert.equal(view.paint.undoStack.length, 1);
    assert.deepEqual(view.lineAnchor, [20, 10]);
    assert.equal(typeof listeners.dblclick, "function");
    let prevented = false;
    listeners.dblclick({ button: 0, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(view.lineAnchor, null);
    assert.equal(view.preview, null);
    view.pointerMove(pointer(0, 25, 25, { detail: 0 }));
    assert.equal(view.preview, null);
    assert.equal(view.paint.undoStack.length, 1);

    // Cancel must redraw even when the pixel buffer has no pending changes.
    mapClick(view, 30, 30, { detail: 0 });
    const before = redraws;
    view.cancelStroke();
    assert.ok(redraws > before);
    assert.equal(view.lineAnchor, null);
    assert.equal(view.preview, null);
    assert.equal(view.paint.undoStack.length, 1);
  } finally {
    globalThis.window = oldWindow;
    globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("second pointerup with detail two ends line without adding a segment", async () => {
  const view = await mapViewForInput("line");
  mapClick(view, 10, 10);
  mapClick(view, 20, 10);
  const before = view.paint.undoStack.length;
  view.pointerDown(pointer(0, 20, 10, { detail: 0 }));
  view.pointerUp(pointer(0, 20, 10, { detail: 2 }));
  assert.equal(view.lineAnchor, null);
  assert.equal(view.preview, null);
  assert.equal(view.paint.undoStack.length, before);
});

test("line drag is a single segment; Shift snaps to a 45-degree direction", async () => {
  const view = await mapViewForInput("line");
  mapDrag(view, 10, 10, 25, 12, { shiftKey: true });
  assert.equal(view.paint.undoStack.length, 1);
  assert.equal(view.lineAnchor, null);
  assert.equal(view.paint.cells[10 * 80 + 20], 100);
  assert.equal(view.paint.cells[12 * 80 + 25], 0);
  view.undo();
  assert.equal(view.paint.changed, false);
});

test("three-click rectangle and ellipse commit one undo step and Esc cancels", async () => {
  const view = await mapViewForInput("rectangle", { construction: "3-point", filled: true });
  mapClick(view, 10, 20);
  mapClick(view, 20, 10);
  assert.equal(view.paint.changed, false);
  assert.equal(view.shapePoints.length, 2);
  mapClick(view, 30, 20);
  assert.equal(view.paint.undoStack.length, 1);
  assert.equal(view.shapePoints.length, 0);
  assert.equal(view.paint.cells[20 * 80 + 20], 100);
  view.undo();
  assert.equal(view.paint.changed, false);
  mapClick(view, 10, 20);
  view.cancelStroke();
  assert.equal(view.shapePoints.length, 0);
  assert.equal(view.paint.changed, false);
  view.mode = "ellipse";
  mapClick(view, 10, 20);
  mapClick(view, 20, 10);
  mapClick(view, 30, 20, { shiftKey: true });
  assert.equal(view.paint.undoStack.length, 1);
  assert.equal(view.paint.cells[20 * 80 + 20], 100);
});

test("right-button pan preserves pending line and does not paint", async () => {
  const view = await mapViewForInput("line");
  mapClick(view, 10, 10);
  view.pointerDown(pointer(2, 15, 15));
  view.pointerMove(pointer(2, 19, 18));
  view.pointerUp(pointer(2, 19, 18));
  assert.equal(view.paint.changed, false);
  assert.deepEqual(view.lineAnchor, [10, 10]);
  assert.deepEqual([view.panX, view.panY], [4, 3]);
});
