import { MapPaint } from "./map_paint.js";

/** Pixel-space ROS occupancy map painter, separate from waypoint interactions. */
export class MapEditCanvas {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.callbacks = callbacks;
    this.map = null;
    this.image = null;
    this.paint = null;
    this.imageData = null;
    this.buffer = null;
    this.mode = "brush";
    this.value = "wall";
    this.brushSize = 7;
    this.filled = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.drag = null;
    this.preview = null;
    this.spaceHeld = false;

    window.addEventListener("keydown", (event) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
          document.activeElement?.tagName,
        )
      )
        return;
      event.preventDefault();
      this.spaceHeld = true;
      this.updateCursor();
    });
    window.addEventListener("keyup", (event) => {
      if (event.code !== "Space") return;
      this.spaceHeld = false;
      this.updateCursor();
    });
    window.addEventListener("blur", () => {
      this.spaceHeld = false;
      this.updateCursor();
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => {
      if (this.drag?.pointerId === event.pointerId) this.cancelStroke();
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 1.17 : 1 / 1.17);
      },
      { passive: false },
    );
  }

  async setMap(map, image) {
    this.map = map;
    this.image = image;
    this.buffer = document.createElement("canvas");
    this.buffer.width = map.width;
    this.buffer.height = map.height;
    const context = this.buffer.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    this.imageData = context.getImageData(0, 0, map.width, map.height);
    const pixels = new Uint8Array(map.width * map.height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = this.imageData.data[i * 4];
    this.paint = new MapPaint(map.width, map.height, pixels, map.negate);
    this.preview = null;
    this.drag = null;
    this.fit();
    this.callbacks.onHistory?.();
  }

  get changed() {
    return this.paint?.changed ?? false;
  }

  get canUndo() {
    return (this.paint?.undoStack.length ?? 0) > 0;
  }

  get canRedo() {
    return (this.paint?.redoStack.length ?? 0) > 0;
  }

  setOptions({ mode, value, size, filled }) {
    this.mode = mode;
    this.value = value;
    this.brushSize = Math.max(1, Math.min(50, Number(size) || 1));
    this.filled = filled;
    this.updateCursor();
    this.draw();
  }

  updateCursor() {
    this.canvas.style.cursor =
      this.drag?.type === "pan"
        ? "grabbing"
        : this.mode === "pan" || this.spaceHeld
          ? "grab"
          : this.mode === "eyedropper"
            ? "copy"
            : "crosshair";
  }

  width() {
    return this.canvas.clientWidth;
  }
  height() {
    return this.canvas.clientHeight;
  }

  resize() {
    const w = this.width();
    const h = this.height();
    if (!w || !h) return;
    const scale = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.draw();
  }

  fit() {
    if (!this.map || !this.width() || !this.height()) return;
    this.zoom = Math.min(
      (this.width() - 64) / this.map.width,
      (this.height() - 64) / this.map.height,
    );
    this.panX = (this.width() - this.map.width * this.zoom) / 2;
    this.panY = (this.height() - this.map.height * this.zoom) / 2;
    this.draw();
    this.callbacks.onZoom?.(this.zoom);
  }

  toPixel(x, y) {
    return [(x - this.panX) / this.zoom, (y - this.panY) / this.zoom];
  }

  zoomAt(x, y, factor) {
    const before = this.toPixel(x, y);
    this.zoom = Math.max(0.035, Math.min(28, this.zoom * factor));
    this.panX = x - before[0] * this.zoom;
    this.panY = y - before[1] * this.zoom;
    this.draw();
    this.callbacks.onZoom?.(this.zoom);
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width(), this.height());
    if (!this.map) return;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.drawImage(
      this.buffer,
      this.panX,
      this.panY,
      this.map.width * this.zoom,
      this.map.height * this.zoom,
    );
    ctx.restore();
    if (!this.preview) return;

    const { start, end, circle } = this.preview;
    const adjusted = this.shapeEnd(start, end, circle);
    const x0 = this.panX + start[0] * this.zoom;
    const y0 = this.panY + start[1] * this.zoom;
    const x1 = this.panX + adjusted[0] * this.zoom;
    const y1 = this.panY + adjusted[1] * this.zoom;
    ctx.save();
    ctx.strokeStyle = "#6edcff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (this.mode === "line") {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    } else if (this.mode === "ellipse") {
      ctx.ellipse(
        (x0 + x1) / 2,
        (y0 + y1) / 2,
        Math.max(0.01, Math.abs(x1 - x0) / 2),
        Math.max(0.01, Math.abs(y1 - y0) / 2),
        0,
        0,
        2 * Math.PI,
      );
    } else {
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Refresh the changed grayscale pixels without rebuilding a large canvas every move. */
  syncPixels(full = false) {
    if (!this.paint) return;
    const data = this.imageData.data;
    let indices;
    if (full) {
      indices = null;
    } else {
      indices = this.paint.drainDirty();
      if (!indices.length) return;
    }

    let left = this.map.width;
    let top = this.map.height;
    let right = 0;
    let bottom = 0;
    const update = (index) => {
      const gray = this.paint.pixels[index];
      const offset = index * 4;
      data[offset] = gray;
      data[offset + 1] = gray;
      data[offset + 2] = gray;
      data[offset + 3] = 255;
      const x = index % this.map.width;
      const y = Math.floor(index / this.map.width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    };

    if (indices) {
      for (const index of indices) update(index);
    } else {
      for (let index = 0; index < this.paint.pixels.length; index++) update(index);
      this.paint.drainDirty();
    }
    const ctx = this.buffer.getContext("2d");
    ctx.putImageData(
      this.imageData,
      0,
      0,
      left,
      top,
      right - left + 1,
      bottom - top + 1,
    );
    this.draw();
    this.callbacks.onHistory?.();
  }

  shapeEnd(start, end, circle = false) {
    if (!circle || this.mode !== "ellipse") return end;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [start[0] + Math.sign(dx || 1) * side, start[1] + Math.sign(dy || 1) * side];
  }

  stroke(start, end, circle = false) {
    const value = this.paint.value(this.value);
    if (this.mode === "brush") {
      this.paint.line(...start, ...end, this.brushSize, value);
    } else if (this.mode === "line") {
      this.paint.line(...start, ...end, this.brushSize, value);
    } else if (this.mode === "rectangle") {
      this.paint.rectangle(...start, ...end, this.brushSize, value, this.filled);
    } else if (this.mode === "ellipse") {
      this.paint.ellipse(
        ...start,
        ...this.shapeEnd(start, end, circle),
        this.brushSize,
        value,
        this.filled,
      );
    }
  }

  pointerDown(event) {
    if (!this.paint || this.drag || ![0, 2].includes(event.button)) return;
    this.canvas.focus?.({ preventScroll: true });
    const pan = event.button === 2 || this.mode === "pan" || this.spaceHeld;
    const raw = this.toPixel(event.offsetX, event.offsetY);
    if (
      !pan &&
      (raw[0] < 0 ||
        raw[1] < 0 ||
        raw[0] >= this.map.width ||
        raw[1] >= this.map.height)
    )
      return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    if (pan) {
      this.drag = {
        type: "pan",
        pointerId: event.pointerId,
        x: event.offsetX,
        y: event.offsetY,
        panX: this.panX,
        panY: this.panY,
      };
      this.updateCursor();
      return;
    }
    const point = raw.map(Math.round);
    if (this.mode === "eyedropper") {
      const sampled = this.paint.sample(...point);
      if (sampled) this.callbacks.onSample?.(sampled);
      return;
    }
    this.paint.begin();
    if (this.mode === "fill") {
      try {
        this.paint.floodFill(...point, this.paint.value(this.value));
        this.paint.commit();
        this.syncPixels();
      } catch (error) {
        this.cancelStroke();
        this.callbacks.onError?.(error);
      }
      return;
    }
    this.drag = {
      type: "paint",
      pointerId: event.pointerId,
      start: point,
      last: point,
      circle: event.shiftKey,
    };
    if (this.mode === "brush") {
      try {
        this.stroke(point, point);
        this.syncPixels();
      } catch (error) {
        this.cancelStroke();
        this.callbacks.onError?.(error);
      }
    } else {
      this.preview = { start: point, end: point, circle: event.shiftKey };
      this.draw();
    }
  }

  pointerMove(event) {
    const p = this.toPixel(event.offsetX, event.offsetY);
    this.callbacks.onCursor?.(p);
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    if (this.drag.type === "pan") {
      this.panX = this.drag.panX + event.offsetX - this.drag.x;
      this.panY = this.drag.panY + event.offsetY - this.drag.y;
      this.draw();
      return;
    }
    const point = p.map(Math.round);
    try {
      if (this.mode === "brush") {
        this.stroke(this.drag.last, point);
        this.drag.last = point;
        this.syncPixels();
      } else {
        this.drag.circle = event.shiftKey;
        this.preview = { start: this.drag.start, end: point, circle: event.shiftKey };
        this.draw();
      }
    } catch (error) {
      this.cancelStroke();
      this.callbacks.onError?.(error);
    }
  }

  pointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    if (this.drag.type === "pan") {
      this.drag = null;
      this.updateCursor();
      return;
    }
    try {
      if (this.mode !== "brush") {
        const end = this.toPixel(event.offsetX, event.offsetY).map(Math.round);
        this.stroke(this.drag.start, end, event.shiftKey);
      }
      this.paint.commit();
      this.preview = null;
      this.drag = null;
      this.updateCursor();
      this.syncPixels();
      this.callbacks.onHistory?.();
    } catch (error) {
      this.cancelStroke();
      this.callbacks.onError?.(error);
    }
  }

  cancelStroke() {
    this.paint?.cancel();
    this.drag = null;
    this.preview = null;
    this.updateCursor();
    this.syncPixels();
  }

  undo() {
    if (!this.paint?.undo()) return false;
    this.syncPixels();
    return true;
  }

  redo() {
    if (!this.paint?.redo()) return false;
    this.syncPixels();
    return true;
  }

  reset() {
    if (!this.paint) return;
    this.paint.reset();
    this.syncPixels(true);
  }

  toBlob() {
    return new Promise((resolve, reject) => {
      if (!this.buffer) return reject(Error("No map loaded"));
      this.buffer.toBlob(
        (blob) => (blob ? resolve(blob) : reject(Error("PNG encoding failed"))),
        "image/png",
      );
    });
  }
}
