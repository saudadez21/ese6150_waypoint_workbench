import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeOccupancy, encodeOccupancy, occupancyFromGray,
} from "../web/js/map_codec.js";

const meta = { mode: "scale", negate: 0, freeThresh: 0.196, occupiedThresh: 0.65 };

test("all three map modes use one occupancy codec with independent expected values", async () => {
  const { decodeOccupancy, encodeOccupancy } = await import("../web/js/map_codec.js");
  const meta = { mode:"trinary", negate:0, freeThresh:0.196, occupiedThresh:0.65 };
  const rgba = Uint8ClampedArray.from([255,255,255,255, 0,0,0,255, 205,205,205,255]);
  assert.deepEqual([...decodeOccupancy(rgba,meta)],[0,100,-1]);
  assert.deepEqual([...decodeOccupancy(rgba,{...meta,mode:"raw"})],[-1,0,-1]);
  const grid = Int8Array.from([0,67,100,-1]);
  const encoded = encodeOccupancy(grid,{...meta,mode:"scale"});
  const decoded = decodeOccupancy(encoded,{...meta,mode:"scale"});
  assert.deepEqual([...decoded], [...grid]);
});

test("occupancy display shades raw values independently from source mode", async () => {
  const { visualGray, renderOccupancy } = await import("../web/js/map_codec.js");
  assert.deepEqual([0,50,100,-1].map(visualGray),[255,128,0,205]);
  assert.deepEqual([...renderOccupancy(Int8Array.from([0,-1]),2,1)],[255,255,255,255,205,205,205,255]);
});

test("Nav2 scale reference gradient (independent expected cell values)", () => {
  for (const [gray, expected] of [[89,100],[90,99],[147,50],[204,1],[205,0],[255,0]]) {
    assert.equal(occupancyFromGray(gray,255,meta),expected, `gray ${gray}`);
  }
  for (const [gray, expected] of [[0,0],[108,50],[165,99],[166,100],[255,100]]) {
    assert.equal(occupancyFromGray(gray,255,{...meta,negate:1}),expected,`negate gray ${gray}`);
  }
});

test("Nav2 trinary reference boundary, raw and alpha", () => {
  const tri = {...meta,mode:"trinary"};
  for (const [gray, value] of [[89,100],[90,-1],[147,-1],[205,-1],[206,0]]) {
    assert.equal(occupancyFromGray(gray,255,tri),value);
  }
  assert.equal(occupancyFromGray(0,0,tri),-1);
  assert.equal(occupancyFromGray(90,1,meta),-1);
  assert.equal(occupancyFromGray(100,0,{...meta,mode:"raw"}),100);
  assert.equal(occupancyFromGray(255,255,{...meta,mode:"raw"}),-1);
});

test("semantic encode/decode of all modes including Unknown", () => {
  const cells = Int8Array.from([0,100,-1]);
  for (const mode of ["trinary","raw","scale"]) {
    const config = {...meta,mode};
    assert.deepEqual([...decodeOccupancy(encodeOccupancy(cells,config),config)],[...cells]);
  }
  const scale = Int8Array.from([-1, 0, 2, 19, 40, 67, 82, 99, 100]);
  const decoded = decodeOccupancy(encodeOccupancy(scale,meta),meta);
  for (let i=0; i<scale.length; i++) assert.ok(Math.abs(decoded[i]-scale[i])<=1);
});

test("unrepresentable trinary Unknown explicitly fails", () => {
  const narrow = {...meta,mode:"trinary",freeThresh:0.499,occupiedThresh:0.500};
  for (const negate of [0, 1]) {
    assert.throws(
      () => encodeOccupancy(Int8Array.from([-1]), { ...narrow, negate }),
      /Cannot encode Unknown|Thresholds/,
    );
  }
});

test("trinary encoding prefers ROS map_saver shades in both negate modes", () => {
  const cells = Int8Array.from([0, -1, 100]);
  const trinary = { ...meta, mode: "trinary" };
  for (const [negate, expected] of [
    [0, [254, 205, 0]],
    [1, [1, 50, 255]],
  ]) {
    const config = { ...trinary, negate };
    const encoded = encodeOccupancy(cells, config);
    assert.deepEqual([encoded[0], encoded[4], encoded[8]], expected);
    assert.deepEqual([...decodeOccupancy(encoded, config)], [...cells]);
  }
});

test("trinary Free and Unknown adapt to YAML thresholds without changing them", () => {
  const trinary = { ...meta, mode: "trinary" };
  for (const [freeThresh, occupiedThresh, negate, expected] of [
    [0, 0.65, 0, [255, 205, 0]],
    [0, 0.65, 1, [0, 50, 255]],
    [0.25, 0.65, 0, [254, 191, 0]],
    [0.25, 0.65, 1, [1, 64, 255]],
    [0.05, 0.15, 0, [254, 217, 0]],
    [0.05, 0.15, 1, [1, 38, 255]],
  ]) {
    const config = { ...trinary, freeThresh, occupiedThresh, negate };
    const cells = Int8Array.from([0, -1, 100]);
    const encoded = encodeOccupancy(cells, config);
    assert.deepEqual([encoded[0], encoded[4], encoded[8]], expected);
    assert.deepEqual([...decodeOccupancy(encoded, config)], [...cells]);
  }
});

test("trinary Unknown handles a floating-point threshold boundary", () => {
  const config = {
    ...meta,
    mode: "trinary",
    freeThresh: 0,
    occupiedThresh: 1 - 251 / 255,
  };
  const encoded = encodeOccupancy(Int8Array.from([-1]), config);
  assert.equal(encoded[0], 252);
  assert.deepEqual([...decodeOccupancy(encoded, config)], [-1]);
});
