/** Browser preferences; edits and imported files are never persisted. */
export const DEFAULT_ALIASES = {
  x_m: "x",
  y_m: "y",
  velocity: "v",
  vx_mps: "v",
  speed: "v",
};

export const TARGETS = ["x", "y", "v"];
export const DEFAULTS = {
  apiUrl: "",
  maxTracks: 64,
  closureGap: 0.75,
  csvDecimalPlaces: 6,
  aliases: DEFAULT_ALIASES,
};
const KEY = "waypoint_workbench_preferences_v4";
const PREVIOUS_KEY = "waypoint_workbench_preferences_v3";
export const TOKEN_KEY = "waypoint_workbench_api_token";
const clone = (value) => JSON.parse(JSON.stringify(value));

export function validatePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Settings must be an object");
  }
  const result = clone(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  if (
    !Number.isInteger(result.maxTracks) ||
    result.maxTracks < 1 ||
    result.maxTracks > 64
  ) {
    throw Error("Max tracks must be 1–64");
  }
  if (
    !Number.isFinite(result.closureGap) ||
    result.closureGap <= 0 ||
    result.closureGap > 50
  ) {
    throw Error("Closure gap must be between 0 and 50 m");
  }
  if (
    !Number.isInteger(result.csvDecimalPlaces) ||
    result.csvDecimalPlaces < 0 ||
    result.csvDecimalPlaces > 12
  ) {
    throw Error("CSV decimal places must be an integer from 0 to 12");
  }
  if (
    typeof result.apiUrl !== "string" ||
    (result.apiUrl && !/^https?:\/\/[^\s/]+\/?$/.test(result.apiUrl))
  ) {
    throw Error("Enter an HTTP(S) API origin without a path");
  }
  if (
    !result.aliases ||
    typeof result.aliases !== "object" ||
    Array.isArray(result.aliases)
  ) {
    throw Error("CSV aliases must be an object");
  }
  const clean = {};
  for (const [rawAlias, target] of Object.entries(result.aliases)) {
    const alias = rawAlias.trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_ -]{0,63}$/.test(alias) || !TARGETS.includes(target)) {
      throw Error(`Invalid CSV alias: ${rawAlias}`);
    }
    if (Object.hasOwn(clean, alias)) throw Error(`Duplicate CSV alias: ${alias}`);
    clean[alias] = target;
  }
  result.aliases = clean;
  return result;
}

// Migrate v3 preferences to v4. Remove on the next schema update.
function migratePreferences(previous) {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw Error("Invalid previous preferences");
  }
  const migrated = { ...previous };
  if (
    previous.aliases &&
    typeof previous.aliases === "object" &&
    !Array.isArray(previous.aliases)
  ) {
    migrated.aliases = Object.fromEntries(
      Object.entries(previous.aliases).filter(([, target]) => TARGETS.includes(target)),
    );
  }
  return validatePreferences(migrated);
}

export function readPreferences() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) return validatePreferences(JSON.parse(stored));

    const previous = localStorage.getItem(PREVIOUS_KEY);
    if (previous === null) return clone(DEFAULTS);

    const migrated = migratePreferences(JSON.parse(previous));
    localStorage.setItem(KEY, JSON.stringify(migrated));
    localStorage.removeItem(PREVIOUS_KEY);
    return migrated;
  } catch {
    return clone(DEFAULTS);
  }
}

export function savePreferences(value) {
  const result = validatePreferences(value);
  localStorage.setItem(KEY, JSON.stringify(result));
  return result;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Pick a well-separated color for the next track slot. */
export function nextTrackColor(colors) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const used = colors.map(rgb);
  let best = "#60A5FA";
  let score = -1;
  for (let i = 0; i < 72; i++) {
    const hue = ((i * 137.508 + Math.random() * 12) % 360) / 60;
    const light = 0.61;
    const chroma = (1 - Math.abs(2 * light - 1)) * 0.78;
    const x = chroma * (1 - Math.abs((hue % 2) - 1));
    const parts =
      hue < 1
        ? [chroma, x, 0]
        : hue < 2
          ? [x, chroma, 0]
          : hue < 3
            ? [0, chroma, x]
            : hue < 4
              ? [0, x, chroma]
              : hue < 5
                ? [x, 0, chroma]
                : [chroma, 0, x];
    const candidate = parts.map((v) => Math.round((v + light - chroma / 2) * 255));
    const distance = used.length
      ? Math.min(
          ...used.map((c) => c.reduce((sum, v, n) => sum + (v - candidate[n]) ** 2, 0)),
        )
      : Infinity;
    if (distance > score) {
      score = distance;
      best = `#${candidate.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return best;
}
