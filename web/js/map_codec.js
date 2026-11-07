/** ROS occupancy semantics in image row order (top left first). */
export const MAX_IMAGE_PIXELS = 25_000_000;

export function occupancyFromGray(gray, alpha, map) {
  if (map.mode === "raw") return gray <= 100 ? gray : -1;
  if (alpha < 255) return -1;
  const fraction = map.negate ? gray / 255 : 1 - gray / 255;
  if (fraction <= map.freeThresh) return 0;
  if (fraction >= map.occupiedThresh) return 100;
  if (map.mode === "trinary") return -1;
  return Math.round(
    (100 * (fraction - map.freeThresh)) / (map.occupiedThresh - map.freeThresh),
  );
}

export function decodeOccupancy(rgba, map) {
  const cells = new Int8Array(rgba.length / 4);
  for (let i = 0; i < cells.length; i++) {
    const p = i * 4;
    const gray = Math.round(
      0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2],
    );
    cells[i] = occupancyFromGray(gray, rgba[p + 3], map);
  }
  return cells;
}

/** Prefer ROS map_saver's Unknown shade, constrained to the current YAML thresholds. */
function trinaryUnknownGray(map) {
  const min = Math.floor(255 * map.freeThresh) + 1;
  const max = Math.ceil(255 * map.occupiedThresh) - 1;
  if (min > max) throw Error("Thresholds cannot encode Unknown in 8-bit trinary PGM");

  let value = Math.max(min, Math.min(50, max));
  let gray = map.negate ? value : 255 - value;
  const decoded = occupancyFromGray(gray, 255, map);
  // The decoder uses floating-point division; an exact threshold can need one step.
  if (decoded === 0) value++;
  else if (decoded === 100) value--;
  gray = map.negate ? value : 255 - value;
  if (occupancyFromGray(gray, 255, map) !== -1)
    throw Error("Thresholds cannot encode Unknown in 8-bit trinary PGM");
  return gray;
}

/** Values are encoded using the same thresholds that the decoder uses. */
export function encodeOccupancy(cells, map) {
  const rgba = new Uint8ClampedArray(cells.length * 4);
  const choices = new Array(101);
  if (map.mode === "raw") {
    for (let value = 0; value <= 100; value++) choices[value] = value;
  } else if (map.mode === "trinary") {
    const free = map.negate ? 1 : 254;
    const extremeFree = map.negate ? 0 : 255;
    choices[0] = occupancyFromGray(free, 255, map) === 0 ? free : extremeFree;
    choices[100] = map.negate ? 255 : 0;
  } else {
    for (let value = 0; value <= 100; value++) {
      let best = null;
      for (let gray = 0; gray <= 255; gray++) {
        const decoded = occupancyFromGray(gray, 255, map);
        if (decoded === -1) continue;
        const difference = Math.abs(value - decoded);
        if (!best || difference < best.difference) best = { gray, difference };
        if (difference === 0) break;
      }
      if (best && best.difference <= 1) choices[value] = best.gray;
    }
  }
  let trinaryUnknown;
  for (let i = 0; i < cells.length; i++) {
    const value = cells[i];
    if (!Number.isInteger(value) || value < -1 || value > 100) {
      throw Error(`Invalid occupancy value at pixel ${i}`);
    }
    let gray;
    let alpha = 255;
    if (value === -1) {
      if (map.mode === "scale") {
        gray = 127;
        alpha = 0;
      } else if (map.mode === "raw") gray = 255;
      else {
        if (trinaryUnknown === undefined) trinaryUnknown = trinaryUnknownGray(map);
        gray = trinaryUnknown;
      }
    } else {
      gray = choices[value];
      if (gray === undefined) {
        throw Error(
          `Cannot encode occupancy ${value} in ${map.mode} mode with these thresholds`,
        );
      }
    }
    const offset = i * 4;
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = gray;
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

export function visualGray(value) {
  return value < 0 ? 205 : Math.round(255 * (1 - value / 100));
}

export function renderOccupancy(cells, width, height) {
  if (cells.length !== width * height) throw Error("Invalid grid dimensions");
  const rgba = new Uint8ClampedArray(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    const gray = visualGray(cells[i]);
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
