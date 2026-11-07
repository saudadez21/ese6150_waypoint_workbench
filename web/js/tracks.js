import { stats } from "./geometry.js";
import { nextTrackColor } from "./preferences.js";

const copy = (value) => structuredClone(value);

export function selectedIndices(track) {
  if (!track) return [];
  const indices = track.selection ?? (track.selected == null ? [] : [track.selected]);
  return [...new Set(indices)]
    .filter(
      (index) => Number.isInteger(index) && index >= 0 && index < track.points.length,
    )
    .sort((a, b) => a - b);
}

export class Tracks {
  constructor(config) {
    this.config = config;
    this.items = [];
    this.activeId = null;
    this.nextId = 1;
  }

  get active() {
    return this.items.find((item) => item.id === this.activeId) || null;
  }

  add(parsed, filename, source = { type: "local" }) {
    if (this.items.length >= this.config.maxTracks) {
      throw Error(`Maximum ${this.config.maxTracks} tracks`);
    }
    const color = nextTrackColor(this.items.map((track) => track.color));
    const track = {
      ...parsed,
      id: this.nextId++,
      filename,
      source,
      color,
      visible: true,
      selected: null,
      selection: [],
      anchor: null,
      undo: [],
      redo: [],
      dirty: false,
      baseline: copy({
        points: parsed.points,
        speed: parsed.speed,
        originalCSV: parsed.originalCSV,
      }),
    };
    this.items.push(track);
    this.select(track.id);
    return track;
  }

  create(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) {
      throw Error("Invalid track name");
    }
    const filename = `${name}.csv`;
    if (this.items.some((track) => track.filename === filename)) {
      throw Error(`${filename} is already loaded`);
    }
    return this.add(
      {
        points: [],
        speed: null,
        originalCSV: null,
      },
      filename,
    );
  }

  select(id) {
    if (!this.items.some((track) => track.id === id)) return;
    if (this.activeId !== id) {
      for (const track of this.items) {
        track.selected = null;
        track.selection = [];
        track.anchor = null;
      }
    }
    this.activeId = id;
  }

  remove(id) {
    this.items = this.items.filter((track) => track.id !== id);
    if (this.activeId === id) {
      this.activeId = null;
      if (this.items.length) this.select(this.items.at(-1).id);
    }
  }

  clearSelection() {
    const track = this.active;
    if (!track) return;
    track.selected = null;
    track.selection = [];
    track.anchor = null;
  }

  setSelection(indices, primary = null, anchor = primary) {
    const track = this.active;
    if (!track) return;
    const valid = [...new Set(indices)]
      .filter(
        (index) => Number.isInteger(index) && index >= 0 && index < track.points.length,
      )
      .sort((a, b) => a - b);
    track.selection = valid;
    track.selected = valid.includes(primary) ? primary : valid.at(-1) ?? null;
    track.anchor = valid.includes(anchor) ? anchor : track.selected;
  }

  toggleSelection(index) {
    const current = selectedIndices(this.active);
    const next = current.includes(index)
      ? current.filter((item) => item !== index)
      : [...current, index];
    this.setSelection(next, next.includes(index) ? index : next.at(-1));
  }

  rangeSelection(index) {
    const anchor = this.active?.anchor ?? this.active?.selected ?? index;
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    this.setSelection(
      Array.from({ length: end - start + 1 }, (_, i) => start + i),
      index,
      anchor,
    );
  }

  boxSelection(indices, extend = false) {
    const current = extend ? selectedIndices(this.active) : [];
    const merged = [...new Set([...current, ...indices])];
    this.setSelection(merged, merged.at(-1) ?? null);
  }

  snapshot(track) {
    return {
      points: copy(track.points),
      selected: track.selected,
      selection: copy(selectedIndices(track)),
      anchor: track.anchor,
    };
  }

  /** Compare edits with the latest saved checkpoint. */
  reconcile(track) {
    const baseline = track.baseline.points;
    const equal =
      track.points.length === baseline.length &&
      track.points.every(
        (point, i) => point[0] === baseline[i][0] && point[1] === baseline[i][1],
      );
    track.dirty = !equal;
    track.originalCSV = equal ? track.baseline.originalCSV : null;
    track.speed = equal ? copy(track.baseline.speed) : null;
  }

  checkpoint(track = this.active, csv = track?.originalCSV) {
    if (!track) return;
    // Reset returns to the latest saved track.
    track.baseline = copy({
      points: track.points,
      speed: track.speed,
      originalCSV: csv,
    });
    this.reconcile(track);
  }

  mutate(operation) {
    const track = this.active;
    if (!track) return;
    const before = this.snapshot(track);
    operation(track);
    track.selected = null;
    track.selection = [];
    track.anchor = null;
    this.reconcile(track);
    track.undo.push(before);
    if (track.undo.length > 100) track.undo.shift();
    track.redo = [];
  }

  undo() {
    const track = this.active;
    if (!track?.undo.length) return false;
    track.redo.push(this.snapshot(track));
    Object.assign(track, track.undo.pop());
    this.reconcile(track);
    return true;
  }

  redo() {
    const track = this.active;
    if (!track?.redo.length) return false;
    track.undo.push(this.snapshot(track));
    Object.assign(track, track.redo.pop());
    this.reconcile(track);
    return true;
  }

  reset() {
    const track = this.active;
    if (!track || !track.dirty) return;
    this.mutate((item) => {
      item.points = copy(item.baseline.points);
    });
    this.reconcile(track);
  }

  movePoint(index, point) {
    const track = this.active;
    if (!track || index == null || !point.every(Number.isFinite)) return;
    if (!track.points[index]) return;
    if (track.points[index][0] === point[0] && track.points[index][1] === point[1])
      return;
    this.mutate((item) => {
      item.points[index] = [...point];
    });
    this.setSelection([index], index);
  }

  translateSelection(dx, dy) {
    const track = this.active;
    const indices = selectedIndices(track);
    if (!indices.length || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (dx === 0 && dy === 0) return false;
    const primary = track.selected;
    const anchor = track.anchor;
    this.mutate((item) => {
      for (const index of indices) {
        item.points[index] = [item.points[index][0] + dx, item.points[index][1] + dy];
      }
    });
    this.setSelection(indices, primary, anchor);
    return true;
  }

  insert(index, point) {
    this.mutate((item) => {
      item.points.splice(index, 0, [...point]);
    });
    this.setSelection([index], index);
  }

  deleteSelection() {
    const track = this.active;
    const indices = selectedIndices(track);
    if (!indices.length) return false;
    if (track.points.length >= 2 && track.points.length - indices.length < 2) {
      throw Error("Track needs at least two points");
    }
    this.mutate((item) => {
      for (const index of [...indices].reverse()) item.points.splice(index, 1);
    });
    return true;
  }

  deletePoint(index) {
    if (index == null) return;
    this.setSelection([index], index);
    return this.deleteSelection();
  }

  reverse() {
    this.mutate((track) => {
      track.points.reverse();
    });
  }

  setStart(index) {
    if (index == null) return;
    if (!stats(this.active?.points, this.config.closureGap).closed) {
      throw Error("Set Start requires a closed track");
    }
    this.mutate((track) => {
      track.points = track.points.slice(index).concat(track.points.slice(0, index));
    });
  }

  measurements() {
    return stats(this.active?.points, this.config.closureGap);
  }
}
