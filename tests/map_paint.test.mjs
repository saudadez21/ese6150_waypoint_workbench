import assert from "node:assert/strict";
import { test } from "node:test";
import { MapPaint } from "../web/js/map_paint.js";

test("map painting uses changesets and undo", () => {
  const paint = new MapPaint(4, 4, new Int8Array(16).fill(0));
  paint.begin(); paint.point(2, 2, paint.value("wall")); paint.commit();
  assert.equal(paint.changed, true);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.redo();
  assert.equal(paint.changed, true);
});

test("filled and outlined ellipses can be undone", () => {
  const paint = new MapPaint(30, 30, new Int8Array(900).fill(0));
  paint.begin();
  paint.ellipse(4, 4, 24, 20, 1, paint.value("wall"), true);
  paint.commit();
  assert.equal(paint.cells[12 * 30 + 14], 100);
  assert.equal(paint.cells[0], 0);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.begin();
  paint.ellipse(4, 4, 24, 20, 1, paint.value("wall"), false);
  paint.commit();
  assert.equal(paint.cells[12 * 30 + 14], 0);
  assert.equal(paint.changed, true);
  paint.undo();
  assert.equal(paint.changed, false);
});

test("flood fill changes only adjacent equal occupancy cells and supports Undo", () => {
  const cells = Int8Array.from([0,0,100,0, 0,0,100,0, 100,100,100,0, 0,0,100,0]);
  const paint = new MapPaint(4,4,cells);
  paint.begin(); paint.floodFill(0,0,-1); paint.commit();
  assert.equal(paint.cells[0],-1);
  assert.equal(paint.cells[5],-1);
  assert.equal(paint.cells[3],0);
  paint.undo();
  assert.equal(paint.changed,false);
  assert.deepEqual([...paint.cells],[0,0,100,0,0,0,100,0,100,100,100,0,0,0,100,0]);
});

test("eyedropper samples occupancy categories without editing", () => {
  const cells = Int8Array.from([100, 0, -1, 80, 20]);
  const paint = new MapPaint(5, 1, cells);
  assert.equal(paint.sample(0,0),"wall");
  assert.equal(paint.sample(1,0),"free");
  assert.equal(paint.sample(2,0),"unknown");
  assert.equal(paint.sample(99,0),null);
  assert.deepEqual([...paint.cells],[100,0,-1,80,20]);
});

test("bucket-fill over the stroke pixel cap is rejected without partial changes", () => {
  const paint = new MapPaint(1000, 800, new Int8Array(800_000).fill(0));
  paint.begin();
  assert.throws(() => paint.floodFill(0, 0, 100), /too large/);
  paint.cancel();
  assert.equal(paint.changed, false);
  assert.equal(paint.cells[0], 0);
  assert.equal(paint.cells[799_999], 0);
});

test("45-degree line snapping preserves length and follows eight directions", async () => {
  const { snapLine45 } = await import("../web/js/map_paint.js");
  const start = [10, 10];
  assert.deepEqual(snapLine45(start, [12, 30], false), [12, 30]);
  const right = snapLine45(start, [20, 12], true);
  assert.ok(Math.abs(right[1] - 10) < 1e-8);
  const diagonal = snapLine45(start, [20, 18], true);
  assert.ok(Math.abs(diagonal[0] - diagonal[1]) < 1e-8);
  const upward = snapLine45(start, [11, -15], true);
  assert.ok(Math.abs(upward[0] - 10) < 1e-8);
  assert.ok(Math.abs(Math.hypot(...diagonal.map((c, i) => c - start[i])) -
    Math.hypot(10, 8)) < 1e-8);
});

test("three-point frames support rotated rectangles, signed depth, and squares", async () => {
  const { threePointFrame } = await import("../web/js/map_paint.js");
  const frame = threePointFrame([10, 20], [20, 10], [30, 20]);
  assert.ok(frame);
  assert.deepEqual(frame.corners.map((p) => p.map(Math.round)), [
    [10, 20], [20, 10], [30, 20], [20, 30],
  ]);
  assert.deepEqual(frame.center.map(Math.round), [20, 20]);
  assert.equal(threePointFrame([3, 3], [3, 3], [5, 5]), null);
  const square = threePointFrame([10, 20], [20, 10], [12, 22], true);
  assert.ok(Math.abs(square.width - Math.abs(square.height)) < 1e-8);
  const reverse = threePointFrame([10, 20], [20, 10], [10, 0]);
  assert.ok(reverse.height < 0);
});

test("rotated filled and outlined shapes rasterize and undo correctly", () => {
  const paint = new MapPaint(50, 50, new Int8Array(2500).fill(0));
  const wall = paint.value("wall");
  const a = [10, 20];
  const b = [20, 10];
  const c = [30, 20];
  paint.begin();
  paint.rotatedRectangle(a, b, c, 1, wall, true);
  paint.commit();
  assert.equal(paint.cells[20 * 50 + 20], wall);
  assert.equal(paint.cells[5 * 50 + 5], 0);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.begin();
  paint.rotatedRectangle(a, b, c, 1, wall, false);
  paint.commit();
  assert.equal(paint.cells[20 * 50 + 20], 0);
  assert.equal(paint.cells[20 * 50 + 10], wall);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.begin();
  paint.rotatedEllipse(a, b, c, 1, wall, true);
  paint.commit();
  assert.equal(paint.cells[20 * 50 + 20], wall);
  assert.equal(paint.cells[5 * 50 + 5], 0);
  paint.undo();
  assert.equal(paint.changed, false);
  paint.begin();
  paint.rotatedEllipse(a, b, c, 1, wall, false);
  paint.commit();
  assert.equal(paint.cells[20 * 50 + 20], 0);
  assert.equal(paint.changed, true);
  paint.undo();
  assert.equal(paint.changed, false);
});

test("MapPaint owns the document's cells; checkpoint and history stay separate", () => {
  const cells=Int8Array.from([0,0,0,0]);
  const paint=new MapPaint(2,2,cells);
  paint.begin();paint.point(0,0,100);paint.commit();
  assert.equal(cells[0],100);
  paint.checkpoint();
  assert.equal(paint.changed,false);
  paint.undo();
  assert.equal(cells[0],0);
  assert.equal(paint.changed,true);
  paint.redo();
  assert.equal(paint.changed,false);
  paint.reset();
  assert.equal(paint.changed,false);
});
