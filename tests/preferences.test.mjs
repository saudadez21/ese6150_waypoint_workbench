import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, DEFAULT_ALIASES, nextTrackColor, readPreferences, validatePreferences } from "../web/js/preferences.js";

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

test("preference mapping objects validate deletion and custom rows", () => {
  const result = validatePreferences({ aliases: { custom_easting: "x", custom_northing: "y" } });
  assert.deepEqual(result.aliases, { custom_easting: "x", custom_northing: "y" });
  assert.throws(() => validatePreferences({ aliases: { foo: "invalid" } }), /Invalid CSV alias/);
});

test("automatic track color is valid and differs from loaded colors", () => {
  const a = nextTrackColor([]), b = nextTrackColor([a]);
  assert.match(a, /^#[0-9a-f]{6}$/i);
  assert.match(b, /^#[0-9a-f]{6}$/i);
  assert.notEqual(a, b);
});

function withStorage(initial, check) {
  const previous = globalThis.localStorage;
  const entries = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  try {
    check(entries);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

const v3Key = "waypoint_workbench_preferences_v3";
const v4Key = "waypoint_workbench_preferences_v4";

test("New users receive default preferences without creating storage entries", () => {
  withStorage({}, (entries) => {
    assert.deepEqual(readPreferences(), DEFAULTS);
    assert.equal(entries.size, 0);
  });
});

test("Preferences migrate v3 settings to v4 once", () => {
  const previous = {
    apiUrl: "http://127.0.0.1:6150",
    closureGap: 0.5,
    csvDecimalPlaces: 4,
    aliases: { x_m: "x", y_m: "y", vx_mps: "v", psi_rad: "yaw", notes: "other" },
    colors: ["#abcdef"],
    undoLimit: 300,
  };
  withStorage({ [v3Key]: JSON.stringify(previous) }, (entries) => {
    const prefs = readPreferences();
    assert.equal(prefs.apiUrl, previous.apiUrl);
    assert.equal(prefs.closureGap, 0.5);
    assert.equal(prefs.csvDecimalPlaces, 4);
    assert.equal(prefs.maxTracks, 64);
    assert.deepEqual(prefs.aliases, { x_m: "x", y_m: "y", vx_mps: "v" });
    assert.equal(Object.hasOwn(prefs, "colors"), false);
    assert.equal(Object.hasOwn(prefs, "undoLimit"), false);
    assert.equal(entries.has(v3Key), false);
    assert.deepEqual(JSON.parse(entries.get(v4Key)), prefs);
    assert.deepEqual(readPreferences(), prefs);
  });
});

test("Preferences load v4 directly when both versions exist", () => {
  const current = { ...DEFAULTS, maxTracks: 12 };
  withStorage({
    [v4Key]: JSON.stringify(current),
    [v3Key]: JSON.stringify({ apiUrl: "http://old.example.com" }),
  }, (entries) => {
    assert.equal(readPreferences().maxTracks, 12);
    assert.equal(entries.has(v3Key), true);
  });
});

test("Preferences with invalid current data fall back to defaults", () => {
  withStorage({ [v4Key]: "not json" }, (entries) => {
    assert.deepEqual(readPreferences(), DEFAULTS);
    assert.equal(entries.get(v4Key), "not json");
  });
});

test("Preferences migrate v3 without custom aliases using defaults", () => {
  withStorage({ [v3Key]: JSON.stringify({ maxTracks: 10, colors: ["#abcdef"] }) }, (entries) => {
    assert.deepEqual(readPreferences().aliases, DEFAULT_ALIASES);
    assert.equal(entries.has(v3Key), false);
  });
});
