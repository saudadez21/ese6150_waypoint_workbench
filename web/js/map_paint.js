/** Occupancy grid editing with per-stroke undo/redo. */
const HISTORY_LIMIT = 100;
const MAX_STROKE_PIXELS = 750_000;

/** A rectangle's first edge and signed perpendicular depth, in image pixels. */
export function threePointFrame(start, axis, through, square = false) {
  const dx = axis[0] - start[0];
  const dy = axis[1] - start[1];
  const width = Math.hypot(dx, dy);
  if (width < 0.001) return null;
  const ux = dx / width;
  const uy = dy / width;
  const vx = -uy;
  const vy = ux;
  const depth = (through[0] - axis[0]) * vx + (through[1] - axis[1]) * vy;
  const height = square ? Math.sign(depth || 1) * width : depth;
  const offset = [vx * height, vy * height];
  const corners = [
    start,
    axis,
    [axis[0] + offset[0], axis[1] + offset[1]],
    [start[0] + offset[0], start[1] + offset[1]],
  ];
  return {
    corners,
    ux,
    uy,
    vx,
    vy,
    width,
    height,
    center: [start[0] + (dx + offset[0]) / 2, start[1] + (dy + offset[1]) / 2],
  };
}

/** Snap a line's direction to multiples of 45 degrees without changing its length. */
export function snapLine45(start, end, constrained = false) {
  if (!constrained) return end;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (!length) return end;
  const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
  return [start[0] + length * Math.cos(angle), start[1] + length * Math.sin(angle)];
}

export class MapPaint {
  constructor(width, height, cells) {
    if (cells.length !== width * height) throw Error("Invalid map grid dimensions");
    this.width = width;
    this.height = height;
    // Edit the document cells directly so other views share the same map.
    this.cells = cells;
    this.original = Int8Array.from(cells);
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.dirty = new Set();
    this.modifiedPixels = 0;
  }

  drainDirty() {
    const updated = [...this.dirty];
    this.dirty.clear();
    return updated;
  }

  get changed() {
    return this.modifiedPixels > 0;
  }

  setPixel(index, value) {
    const previous = this.cells[index];
    if (previous === value) return;
    if (previous !== this.original[index]) this.modifiedPixels--;
    if (value !== this.original[index]) this.modifiedPixels++;
    this.cells[index] = value;
    this.dirty.add(index);
  }

  value(tool) {
    const value = { wall: 100, free: 0, unknown: -1 }[tool];
    if (value === undefined) throw Error(`Unknown map paint tool: ${tool}`);
    return value;
  }

  /** Establish the saved checkpoint without discarding undo history. */
  checkpoint() {
    this.original.set(this.cells);
    this.modifiedPixels = 0;
  }

  begin() {
    if (this.pending) throw new Error("A map stroke is already in progress");
    this.pending = new Map();
  }

  point(x, y, value) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = y * this.width + x;
    if (this.cells[index] === value) return;
    if (!this.pending.has(index)) {
      if (this.pending.size >= MAX_STROKE_PIXELS) {
        throw Error("Map edit is too large for one undo step");
      }
      this.pending.set(index, this.cells[index]);
    }
    this.setPixel(index, value);
  }

  brush(x, y, size, value) {
    const radius = Math.max(0, (size - 1) / 2);
    const cx = Math.round(x);
    const cy = Math.round(y);
    const extent = Math.ceil(radius);
    for (let dy = -extent; dy <= extent; dy++) {
      for (let dx = -extent; dx <= extent; dx++) {
        if (dx * dx + dy * dy <= radius * radius + 0.01) {
          this.point(cx + dx, cy + dy, value);
        }
      }
    }
  }

  line(x0, y0, x1, y1, size, value) {
    const distance = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const steps = Math.max(1, Math.ceil(distance));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      this.brush(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, size, value);
    }
  }

  rectangle(x0, y0, x1, y1, size, value, filled) {
    if (!filled) {
      this.line(x0, y0, x1, y0, size, value);
      this.line(x1, y0, x1, y1, size, value);
      this.line(x1, y1, x0, y1, size, value);
      this.line(x0, y1, x0, y0, size, value);
      return;
    }
    const left = Math.max(0, Math.round(Math.min(x0, x1)));
    const right = Math.min(this.width - 1, Math.round(Math.max(x0, x1)));
    const top = Math.max(0, Math.round(Math.min(y0, y1)));
    const bottom = Math.min(this.height - 1, Math.round(Math.max(y0, y1)));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) this.point(x, y, value);
    }
  }

  ellipse(x0, y0, x1, y1, size, value, filled) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2;
    const ry = Math.abs(y1 - y0) / 2;
    if (rx < 0.5 || ry < 0.5) {
      this.line(x0, y0, x1, y1, size, value);
      return;
    }
    if (filled) {
      const left = Math.max(0, Math.floor(cx - rx));
      const right = Math.min(this.width - 1, Math.ceil(cx + rx));
      const top = Math.max(0, Math.floor(cy - ry));
      const bottom = Math.min(this.height - 1, Math.ceil(cy + ry));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.001) {
            this.point(x, y, value);
          }
        }
      }
    } else {
      const steps = Math.max(16, Math.ceil(2 * Math.PI * Math.max(rx, ry) * 2));
      let previous = [cx + rx, cy];
      for (let step = 1; step <= steps; step++) {
        const angle = (2 * Math.PI * step) / steps;
        const current = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
        this.line(...previous, ...current, size, value);
        previous = current;
      }
    }
  }

  rotatedRectangle(start, axis, through, size, value, filled, square = false) {
    const frame = threePointFrame(start, axis, through, square);
    if (!frame || Math.abs(frame.height) < 0.001) return;
    if (!filled) {
      const corners = frame.corners;
      for (let i = 0; i < 4; i++) {
        this.line(...corners[i], ...corners[(i + 1) % 4], size, value);
      }
      return;
    }
    const xs = frame.corners.map((point) => point[0]);
    const ys = frame.corners.map((point) => point[1]);
    const left = Math.max(0, Math.floor(Math.min(...xs)));
    const right = Math.min(this.width - 1, Math.ceil(Math.max(...xs)));
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    const startX = start[0];
    const startY = start[1];
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const along = (x - startX) * frame.ux + (y - startY) * frame.uy;
        const across = (x - startX) * frame.vx + (y - startY) * frame.vy;
        if (
          along >= -0.001 &&
          along <= frame.width + 0.001 &&
          Math.min(0, frame.height) - 0.001 <= across &&
          across <= Math.max(0, frame.height) + 0.001
        ) {
          this.point(x, y, value);
        }
      }
    }
  }

  rotatedEllipse(start, axis, through, size, value, filled, circle = false) {
    const frame = threePointFrame(start, axis, through, circle);
    if (!frame || Math.abs(frame.height) < 0.001) return;
    const rx = frame.width / 2;
    const ry = Math.abs(frame.height) / 2;
    const { center, ux, uy, vx, vy } = frame;
    if (filled) {
      const extentX = Math.hypot(rx * ux, ry * vx);
      const extentY = Math.hypot(rx * uy, ry * vy);
      const left = Math.max(0, Math.floor(center[0] - extentX));
      const right = Math.min(this.width - 1, Math.ceil(center[0] + extentX));
      const top = Math.max(0, Math.floor(center[1] - extentY));
      const bottom = Math.min(this.height - 1, Math.ceil(center[1] + extentY));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const dx = x - center[0];
          const dy = y - center[1];
          const localX = (dx * ux + dy * uy) / rx;
          const localY = (dx * vx + dy * vy) / ry;
          if (localX ** 2 + localY ** 2 <= 1.001) this.point(x, y, value);
        }
      }
      return;
    }
    const steps = Math.max(16, Math.ceil(4 * Math.PI * Math.max(rx, ry)));
    const pointAt = (angle) => [
      center[0] + rx * Math.cos(angle) * ux + ry * Math.sin(angle) * vx,
      center[1] + rx * Math.cos(angle) * uy + ry * Math.sin(angle) * vy,
    ];
    let previous = pointAt(0);
    for (let step = 1; step <= steps; step++) {
      const current = pointAt((2 * Math.PI * step) / steps);
      this.line(...previous, ...current, size, value);
      previous = current;
    }
  }

  /** Fill a connected region of exactly equal occupancy values. */
  floodFill(x, y, value) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const start = y * this.width + x;
    const original = this.cells[start];
    if (original === value) return;
    const length = this.cells.length;
    const visited = new Uint8Array(length);
    const queue = new Int32Array(Math.min(length, MAX_STROKE_PIXELS + 8));
    let front = 0,
      back = 1;
    queue[0] = start;
    visited[start] = 1;
    while (front < back) {
      const index = queue[front++];
      this.point(index % this.width, Math.floor(index / this.width), value);
      const x = index % this.width;
      const neighbors = [
        x ? index - 1 : -1,
        x + 1 < this.width ? index + 1 : -1,
        index >= this.width ? index - this.width : -1,
        index + this.width < length ? index + this.width : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && !visited[next] && this.cells[next] === original) {
          if (back >= queue.length)
            throw Error("Map edit is too large for one undo step");
          visited[next] = 1;
          queue[back++] = next;
        }
      }
    }
  }

  sample(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const occupancy = this.cells[y * this.width + x];
    return occupancy < 0 ? "unknown" : occupancy >= 50 ? "wall" : "free";
  }

  commit() {
    if (!this.pending) return false;
    const changes = [...this.pending].map(([index, previous]) => [
      index,
      previous,
      this.cells[index],
    ]);
    this.pending = null;
    if (!changes.length) return false;
    this.undoStack.push(changes);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  cancel() {
    if (!this.pending) return;
    for (const [index, previous] of this.pending) this.setPixel(index, previous);
    this.pending = null;
  }

  undo() {
    const changes = this.undoStack.pop();
    if (!changes) return false;
    for (const [index, previous] of changes) this.setPixel(index, previous);
    this.redoStack.push(changes);
    return true;
  }

  redo() {
    const changes = this.redoStack.pop();
    if (!changes) return false;
    for (const [index, , next] of changes) this.setPixel(index, next);
    this.undoStack.push(changes);
    return true;
  }

  reset() {
    for (let i = 0; i < this.cells.length; i++) this.setPixel(i, this.original[i]);
    this.pending = null;
    this.undoStack = [];
    this.redoStack = [];
  }
}
