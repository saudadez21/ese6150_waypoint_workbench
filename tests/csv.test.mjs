import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvColumnsError, parseCSV, targetFor, writeCSV } from "../web/js/csv.js";
import { DEFAULTS } from "../web/js/preferences.js";

const aliases = DEFAULTS.aliases;
const input = [
  "# s,x_m,y_m,psi,kappa,v,a,team_comment",
  "0,1,2,0.1,0.3,3,0.01,start",
  "1,2,3,0.2,0.4,4,0.02,middle",
  "2,3,4,0.3,0.5,5,0.03,end",
  "",
].join("\n");

test("CSV aliases identify coordinates and optional speed", () => {
  assert.equal(targetFor("x_m", aliases), "x");
  const result = parseCSV(input, aliases);
  assert.deepEqual(result.points[0], [1, 2]);
  assert.equal(result.speed[0], 3);
});

test("unmodified CSV round-trips exactly, including unrelated columns", () => {
  assert.equal(writeCSV(parseCSV(input, aliases)), input);
  const lines = "x;y;quality\r\n1;2;great\r\n3;4;good\r\n";
  assert.equal(writeCSV(parseCSV(lines, aliases)), lines);
});

test("CSV export rounds regenerated coordinates without trailing zeros or negative zero", () => {
  const track = { points: [[1.123456789, -0.0000002], [10, 2.5]] };
  assert.equal(writeCSV(track), "x,y\n1.123457,0\n10,2.5\n");
  assert.equal(writeCSV(track, 3), "x,y\n1.123,0\n10,2.5\n");
  assert.equal(writeCSV(track, 0), "x,y\n1,0\n10,3\n");
  assert.equal(writeCSV(track, 12), "x,y\n1.123456789,-0.0000002\n10,2.5\n");
  assert.throws(() => writeCSV(track, 13), /CSV decimal places/);
});

test("users can remove or add aliases", () => {
  const removed = { ...aliases };
  delete removed.x_m;
  assert.throws(() => parseCSV(input, removed), (error) =>
    error instanceof CsvColumnsError && error.missing.includes("x"));
  const custom = { easting: "x", northing: "y" };
  assert.deepEqual(parseCSV("easting,northing\n1,2\n3,4\n", custom).points[1], [3, 4]);
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

test("CSV parser tolerates quoted unknown columns and preserves the source", () => {
  const original = 'x,y,label\n1,2,"north, east"\n3,4,south\n';
  const result = parseCSV(original, aliases);
  assert.deepEqual(result.points[0], [1, 2]);
  assert.equal(writeCSV(result), original);
});
