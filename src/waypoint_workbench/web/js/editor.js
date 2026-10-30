const copy = (v) => (v == null ? null : structuredClone(v));
export class Workspace {
  constructor(limit = 5, colors = []) {
    this.tracks = [];
    this.limit = limit;
    this.colors = colors;
    this.activeId = null;
    this.nextId = 1;
  }
  get active() {
    return this.tracks.find((t) => t.id === this.activeId) || null;
  }
  add(data, name, source = null) {
    if (this.tracks.length >= this.limit) throw Error(`Maximum ${this.limit} tracks`);
    const usedColors = new Set(this.tracks.map((t) => t.color.toLowerCase()));
    const color = this.colors.find((c) => !usedColors.has(c.toLowerCase()));
    if (!color)
      throw Error("No available track color; check editor.track_colors in TOML");
    const t = {
      id: this.nextId++,
      name,
      source,
      points: copy(data.points),
      speed: copy(data.speed),
      visible: true,
      color,
      baseline: { points: copy(data.points), speed: copy(data.speed) },
      undo: [],
      redo: [],
      selected: null,
      changed: false,
    };
    this.tracks.push(t);
    this.activeId = t.id;
    return t;
  }
  select(id) {
    if (this.tracks.some((t) => t.id === id)) this.activeId = id;
  }
  remove(id) {
    this.tracks = this.tracks.filter((t) => t.id !== id);
    if (this.activeId === id) this.activeId = this.tracks.at(-1)?.id ?? null;
  }
  snapshot(t) {
    return { points: copy(t.points), speed: copy(t.speed), selected: t.selected };
  }
  push(t) {
    t.undo.push(this.snapshot(t));
    if (t.undo.length > 70) t.undo.shift();
    t.redo = [];
  }
  commit(t, newState, geometryChange = true) {
    this.push(t);
    t.points = copy(newState.points);
    t.speed = geometryChange ? null : copy(newState.speed);
    t.selected = null;
    t.changed = true;
  }
  undo() {
    const t = this.active;
    if (!t || !t.undo.length) return false;
    t.redo.push(this.snapshot(t));
    Object.assign(t, t.undo.pop());
    t.changed = true;
    return true;
  }
  redo() {
    const t = this.active;
    if (!t || !t.redo.length) return false;
    t.undo.push(this.snapshot(t));
    Object.assign(t, t.redo.pop());
    t.changed = true;
    return true;
  }
  reset() {
    const t = this.active;
    if (!t) return false;
    this.commit(t, t.baseline, false);
    return true;
  }
  reverse() {
    const t = this.active;
    if (!t) return;
    this.commit(t, { points: [...t.points].reverse() }, true);
  }
  startAt(index) {
    const t = this.active;
    if (!t || index == null) return;
    const rotate = (list) =>
      list == null ? null : list.slice(index).concat(list.slice(0, index));
    this.push(t);
    t.points = rotate(t.points);
    t.speed = rotate(t.speed);
    t.selected = 0;
    t.changed = true;
  }
  deletePoint(index) {
    const t = this.active;
    if (!t || index == null) return;
    if (t.points.length <= 3) throw Error("A track needs at least three points");
    this.push(t);
    t.points.splice(index, 1);
    t.speed = null;
    t.selected = null;
    t.changed = true;
  }
  changePoint(index, x, y) {
    const t = this.active;
    if (!t || index == null) return;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw Error("Coordinates must be finite");
    if (t.points[index][0] === x && t.points[index][1] === y) return;
    this.push(t);
    t.points[index] = [x, y];
    t.speed = null;
    t.changed = true;
  }
  insertAt(index, point) {
    const t = this.active;
    if (!t) return;
    this.push(t);
    t.points.splice(index, 0, point);
    t.speed = null;
    t.selected = index;
    t.changed = true;
  }
}
export function stats(points) {
  if (!points?.length) return { length: 0, gap: 0 };
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    length += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  const a = points[0],
    b = points.at(-1);
  return { length, gap: Math.hypot(a[0] - b[0], a[1] - b[1]) };
}

/**
 * Determine where a clicked waypoint belongs in the ordered path.
 *
 * The nearest line segment is used for ordering ONLY. The inserted point keeps
 * its exact clicked world coordinates.
 *
 * The red dashed last-to-first edge of an OPEN track is a *real editing gap*:
 * ignoring it makes clicks near the gap join unrelated segments.
 * If that gap wins, extend whichever endpoint is closer to the click:
 *   - near the first point -> prepend at index 0;
 *   - near the last point  -> append at index points.length.
 * The open gap stays dashed until the endpoints are close enough. On CLOSED
 * tracks, insertion into the cyclic last-to-first edge always appends.
 */
export function nearestSegmentInsertion(points, clickPoint, closed = true) {
  if (
    !points ||
    points.length < 2 ||
    !clickPoint ||
    clickPoint.length !== 2 ||
    !clickPoint.every(Number.isFinite)
  )
    return null;

  let bestIndex = null,
    smallest = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const u = Math.max(
      0,
      Math.min(
        1,
        ((clickPoint[0] - a[0]) * dx + (clickPoint[1] - a[1]) * dy) / lengthSquared,
      ),
    );
    const projectedX = a[0] + u * dx,
      projectedY = a[1] + u * dy;
    const distanceSquared =
      (projectedX - clickPoint[0]) ** 2 + (projectedY - clickPoint[1]) ** 2;
    if (distanceSquared < smallest) {
      smallest = distanceSquared;
      if (i === points.length - 1 && !closed) {
        const firstDistance =
          (clickPoint[0] - points[0][0]) ** 2 + (clickPoint[1] - points[0][1]) ** 2;
        const lastDistance = (clickPoint[0] - a[0]) ** 2 + (clickPoint[1] - a[1]) ** 2;
        bestIndex = firstDistance < lastDistance ? 0 : points.length;
      } else {
        bestIndex = i + 1;
      }
    }
  }
  return bestIndex === null ? null : { index: bestIndex, point: [...clickPoint] };
}
