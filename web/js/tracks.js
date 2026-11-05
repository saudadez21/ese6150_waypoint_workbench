import { stats } from "./geometry.js";

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
    if (this.items.length >= this.config.colors.length) {
      throw Error(`Maximum ${this.config.colors.length} tracks (add colors in Config)`);
    }
    const used = new Set(this.items.map((track) => track.color));
    const color =
      this.config.colors.find((candidate) => !used.has(candidate)) ||
      this.config.colors[0];
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
      baseline: copy(parsed),
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
        columns: ["x", "y"],
        otherColumns: [],
        extraRows: null,
        headerKind: "normal",
        delimiter: ",",
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
      speed: copy(track.speed),
      originalCSV: track.originalCSV,
      extraRows: copy(track.extraRows),
      otherColumns: copy(track.otherColumns),
      columns: copy(track.columns),
      headerKind: track.headerKind,
      delimiter: track.delimiter,
      selected: track.selected,
      selection: copy(selectedIndices(track)),
      anchor: track.anchor,
      dirty: track.dirty,
    };
  }

  mutate(operation) {
    const track = this.active;
    if (!track) return;
    const before = this.snapshot(track);
    operation(track);
    // Geometry and point ordering changes invalidate all dependent CSV columns.
    track.speed = null;
    track.originalCSV = null;
    track.extraRows = null;
    track.otherColumns = [];
    track.columns = ["x", "y"];
    track.selected = null;
    track.selection = [];
    track.anchor = null;
    track.dirty = true;
    track.undo.push(before);
    if (track.undo.length > this.config.undoLimit) track.undo.shift();
    track.redo = [];
  }

  undo() {
    const track = this.active;
    if (!track?.undo.length) return false;
    track.redo.push(this.snapshot(track));
    Object.assign(track, track.undo.pop());
    return true;
  }

  redo() {
    const track = this.active;
    if (!track?.redo.length) return false;
    track.undo.push(this.snapshot(track));
    Object.assign(track, track.redo.pop());
    return true;
  }

  reset() {
    const track = this.active;
    if (!track) return;
    this.mutate((item) => Object.assign(item, copy(item.baseline)));
    Object.assign(track, copy(track.baseline));
    track.dirty = false;
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
    this.mutate((track) => {
      track.points = track.points.slice(index).concat(track.points.slice(0, index));
    });
  }

  measurements() {
    return stats(this.active?.points, this.config.closureGap);
  }
}
