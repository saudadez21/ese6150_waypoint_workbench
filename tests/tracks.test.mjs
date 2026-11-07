import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCSV, writeCSV } from "../web/js/csv.js";
import { DEFAULTS, validatePreferences } from "../web/js/preferences.js";
import { Tracks } from "../web/js/tracks.js";

const aliases = DEFAULTS.aliases;
const input = [
  "# s,x_m,y_m,psi,kappa,v,a,team_comment",
  "0,1,2,0.1,0.3,3,0.01,start",
  "1,2,3,0.2,0.4,4,0.02,middle",
  "2,3,4,0.3,0.5,5,0.03,end",
  "",
].join("\n");
const original = "x_m,y_m,vx_mps,psi_rad\n0,0,4,0\n1,1,8,0.3\n";

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

test("geometry edits export XY only; Undo restores source", () => {
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV(input, aliases), "raceline.csv");
  const original = writeCSV(tracks.active);
  tracks.movePoint(0, [8, 2]);
  assert.equal(tracks.active.speed, null);
  assert.equal(writeCSV(tracks.active).split("\n")[0], "x,y");
  tracks.undo();
  assert.equal(writeCSV(tracks.active), original);
  assert.equal(tracks.active.dirty, false);
});

test("Set Start is limited to closed tracks and Reverse invalidates speed", () => {
  const tracks = new Tracks(DEFAULTS);
  tracks.add(parseCSV("x,y,v\n0,0,1\n2,0,2\n3,0,3\n", aliases), "open.csv");
  assert.throws(() => tracks.setStart(1), /closed track/);
  tracks.reverse();
  assert.equal(tracks.active.speed, null);
  assert.equal(tracks.active.dirty, true);
});

test("maximum track count is independent of colors", () => {
  assert.equal(DEFAULTS.maxTracks, 64);
  assert.throws(() => validatePreferences({ maxTracks: 65 }), /1–64/);
  const tracks = new Tracks({ ...DEFAULTS, maxTracks: 2 });
  const parsed = parseCSV("x,y\n1,2\n3,4\n", aliases);
  tracks.add(parsed, "a.csv"); tracks.add(parsed, "b.csv");
  assert.throws(() => tracks.add(parsed, "c.csv"), /Maximum 2/);
  assert.notEqual(tracks.items[0].color, tracks.items[1].color);
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

test("successful upload checkpoint replaces Reset baseline",()=>{
  const tracks=new Tracks(DEFAULTS);
  const t=tracks.add(parseCSV(original,DEFAULTS.aliases),"raceline.csv");
  tracks.movePoint(0,[5,0]);
  assert.equal(t.dirty,true);
  const uploaded=writeCSV(t);
  assert.match(uploaded,/^x,y/);
  tracks.checkpoint(t,uploaded);
  assert.equal(t.dirty,false);
  assert.equal(writeCSV(t),uploaded);
  tracks.undo();
  assert.equal(t.dirty,true);
  tracks.redo();
  assert.equal(t.dirty,false);
  tracks.movePoint(0,[10,0]);
  tracks.reset();
  assert.equal(t.dirty,false);
  assert.deepEqual(t.points[0],[5,0]);
});

test("Undo back to initial CSV restores all original columns",()=>{
  const tracks=new Tracks(DEFAULTS);
  const t=tracks.add(parseCSV(original,DEFAULTS.aliases),"original.csv");
  tracks.movePoint(1,[10,11]);
  assert.equal(t.speed,null);
  assert.equal(writeCSV(t).split("\n")[0],"x,y");
  tracks.undo();
  assert.deepEqual(t.speed,[4,8]);
  assert.equal(writeCSV(t),original);
});
