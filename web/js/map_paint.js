/** Small, dependency-free grayscale occupancy editor with per-stroke undo/redo. */
const HISTORY_LIMIT = 100;
const MAX_STROKE_PIXELS = 750_000;

export class MapPaint {
  constructor(width, height, pixels, negate = 0) {
    if (pixels.length !== width * height) {
      throw new Error("Invalid map image dimensions");
    }
    this.width = width;
    this.height = height;
    this.original = Uint8Array.from(pixels);
    this.pixels = Uint8Array.from(pixels);
    this.negate = negate;
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
    const before = this.pixels[index];
    if (before === value) return;
    if (before !== this.original[index]) this.modifiedPixels--;
    if (value !== this.original[index]) this.modifiedPixels++;
    this.pixels[index] = value;
    this.dirty.add(index);
  }

  value(tool) {
    if (tool === "wall") return this.negate ? 255 : 0;
    if (tool === "free") return this.negate ? 0 : 255;
    if (tool === "unknown") return this.negate ? 50 : 205;
    throw new Error("Unknown map paint tool");
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
    if (this.pixels[index] === value) return;
    if (!this.pending.has(index)) {
      if (this.pending.size >= MAX_STROKE_PIXELS) {
        throw new Error("Map edit is too large for one undo step");
      }
      this.pending.set(index, this.pixels[index]);
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

  /** Fill the connected region matching the clicked pixel's exact grayscale value. */
  floodFill(x, y, value) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const start = y * this.width + x;
    const original = this.pixels[start];
    if (original === value) return;
    const length = this.pixels.length;
    const visited = new Uint8Array(length);
    const queue = new Int32Array(Math.min(length, MAX_STROKE_PIXELS + 8));
    let front = 0;
    let back = 1;
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
        if (next >= 0 && !visited[next] && this.pixels[next] === original) {
          if (back >= queue.length)
            throw new Error("Map edit is too large for one undo step");
          visited[next] = 1;
          queue[back++] = next;
        }
      }
    }
  }

  /** Return the nearest canonical ROS paint category. */
  sample(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const gray = this.pixels[y * this.width + x];
    return ["wall", "free", "unknown"].reduce(
      (closest, category) =>
        Math.abs(this.value(category) - gray) < Math.abs(this.value(closest) - gray)
          ? category
          : closest,
      "wall",
    );
  }

  commit() {
    if (!this.pending) return false;
    const changes = [...this.pending].map(([index, previous]) => [
      index,
      previous,
      this.pixels[index],
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
    for (const [index, previous] of this.pending) {
      this.setPixel(index, previous);
    }
    this.pending = null;
  }

  undo() {
    const changes = this.undoStack.pop();
    if (!changes) return false;
    for (const [index, previous] of changes) {
      this.setPixel(index, previous);
    }
    this.redoStack.push(changes);
    return true;
  }

  redo() {
    const changes = this.redoStack.pop();
    if (!changes) return false;
    for (const [index, , next] of changes) {
      this.setPixel(index, next);
    }
    this.undoStack.push(changes);
    return true;
  }

  reset() {
    this.pixels.set(this.original);
    this.dirty.clear();
    this.modifiedPixels = 0;
    this.pending = null;
    this.undoStack = [];
    this.redoStack = [];
  }
}
