import assert from "node:assert/strict";
import { test } from "node:test";
import { imageToWorld, insertion, stats, worldToImage } from "../web/js/geometry.js";

test("open path insertion preserves clicked world coordinates", () => {
  const points = [[0, 0], [1, 0], [1, 2]];
  assert.deepEqual(insertion(points, [0.4, 0.6], false).point, [0.4, 0.6]);
  assert.equal(stats(points, 0.2).length, 3);
});

test("continuous image/world coordinates use the image boundary, including yaw", () => {
  const map = {width:100,height:100,resolution:0.05,origin:[0,0,0]};
  assert.deepEqual(imageToWorld(map,0,100),[0,0]);
  assert.deepEqual(imageToWorld(map,0.5,99.5),[0.025,0.025]);
  assert.deepEqual(worldToImage(map,0.025,0.025),[0.5,99.5]);
  const rotated = {...map,origin:[12,-3,Math.PI/2]};
  const sample=[31.25,77.75], world=imageToWorld(rotated,...sample);
  const recovered=worldToImage(rotated,...world);
  assert.ok(Math.abs(recovered[0]-sample[0])<1e-8);
  assert.ok(Math.abs(recovered[1]-sample[1])<1e-8);
});
