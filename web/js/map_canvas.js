import { visualGray, renderOccupancy } from "./map_codec.js";
import { MapPaint, snapLine45, threePointFrame } from "./map_paint.js";

/** Pixel-space ROS occupancy map painter, separate from waypoint interactions. */
export class MapEditCanvas {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.callbacks = callbacks;
    this.map = null;
    this.paint = null;
    this.buffer = null;
    this.mode = "brush";
    this.value = "wall";
    this.brushSize = 3;
    this.filled = false;
    this.construction = "drag";
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.drag = null;
    this.preview = null;
    this.lineAnchor = null;
    this.shapePoints = [];
    this.shiftHeld = false;
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
    window.addEventListener("keydown", (event) => {
      if (event.key === "Shift") {
        this.shiftHeld = true;
        if (this.preview) {
          this.preview.shift = true;
          this.draw();
        }
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.key === "Shift") {
        this.shiftHeld = false;
        if (this.preview) {
          this.preview.shift = false;
          this.draw();
        }
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code !== "Space") return;
      this.spaceHeld = false;
      this.updateCursor();
    });
    window.addEventListener("blur", () => {
      this.spaceHeld = false;
      this.shiftHeld = false;
      this.updateCursor();
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("dblclick", (event) => {
      if (event.button !== 0 || this.mode !== "line" || this.spaceHeld) return;
      event.preventDefault();
      this.finishLineChain();
    });
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

  async setMap(map) {
    this.map = map;
    this.buffer = document.createElement("canvas");
    this.buffer.width = map.width;
    this.buffer.height = map.height;
    const context = this.buffer.getContext("2d", { willReadFrequently: true });
    this.paint = new MapPaint(map.width, map.height, map.cells);
    this.displayImageData = context.createImageData(map.width, map.height);
    this.displayImageData.data.set(renderOccupancy(map.cells, map.width, map.height));
    context.putImageData(this.displayImageData, 0, 0);
    this.preview = null;
    this.drag = null;
    this.lineAnchor = null;
    this.shapePoints = [];
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

  setOptions({ mode, value, size, filled, construction = "drag" }) {
    if (this.mode !== mode || this.construction !== construction) {
      this.cancelStroke();
    }
    this.mode = mode;
    this.value = value;
    this.brushSize = Math.max(1, Math.min(50, Number(size) || 1));
    this.filled = filled;
    this.construction = construction;
    this.updateCursor();
    this.draw();
  }

  get hasPending() {
    return Boolean(this.drag || this.lineAnchor || this.shapePoints?.length);
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

    const preview = this.preview;
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    ctx.strokeStyle = "#6edcff";
    ctx.lineWidth = 2 / this.zoom;
    ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
    ctx.beginPath();
    if (preview.kind === "line") {
      const end = snapLine45(preview.start, preview.end, preview.shift);
      ctx.moveTo(...preview.start);
      ctx.lineTo(...end);
    } else if (preview.kind === "three-point") {
      const points = preview.points;
      if (points.length === 1) {
        ctx.moveTo(...points[0]);
        ctx.lineTo(...preview.end);
      } else {
        const frame = threePointFrame(points[0], points[1], preview.end, preview.shift);
        if (frame) this.traceFrame(ctx, frame, preview.mode);
      }
    } else {
      const end = this.shapeEnd(preview.start, preview.end, preview.shift);
      const x0 = preview.start[0];
      const y0 = preview.start[1];
      const x1 = end[0];
      const y1 = end[1];
      if (preview.mode === "ellipse") {
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
    }
    ctx.stroke();
    ctx.restore();
  }

  traceFrame(ctx, frame, mode) {
    if (mode === "rectangle") {
      ctx.moveTo(...frame.corners[0]);
      for (let i = 1; i < 4; i++) ctx.lineTo(...frame.corners[i]);
      ctx.closePath();
      return;
    }
    const [x, y] = frame.center;
    const angle = Math.atan2(frame.uy, frame.ux);
    ctx.ellipse(
      x,
      y,
      frame.width / 2,
      Math.max(0.01, Math.abs(frame.height) / 2),
      angle,
      0,
      2 * Math.PI,
    );
  }

  /** Update the display buffer only where pixels changed. */
  syncPixels(full = false) {
    if (!this.paint) return;
    const dirty = full ? null : this.paint.drainDirty();
    if (dirty && !dirty.length) return;
    const data = this.displayImageData.data;
    let left = this.map.width,
      top = this.map.height,
      right = 0,
      bottom = 0;
    const update = (index) => {
      const gray = visualGray(this.paint.cells[index]);
      const offset = index * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = gray;
      data[offset + 3] = 255;
      const x = index % this.map.width,
        y = Math.floor(index / this.map.width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    };
    if (dirty) for (const index of dirty) update(index);
    else {
      for (let i = 0; i < this.paint.cells.length; i++) update(i);
      this.paint.drainDirty();
    }
    this.buffer
      .getContext("2d")
      .putImageData(
        this.displayImageData,
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

  shapeEnd(start, end, square = false) {
    if (!square || !["rectangle", "ellipse"].includes(this.mode)) return end;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [start[0] + Math.sign(dx || 1) * side, start[1] + Math.sign(dy || 1) * side];
  }

  /** Commit one complete geometry operation as a single undo step. */
  commitShape(operation) {
    this.paint.begin();
    try {
      operation(this.paint.value(this.value));
      this.paint.commit();
      this.syncPixels();
    } catch (error) {
      this.paint.cancel();
      this.syncPixels();
      this.callbacks.onError?.(error);
    }
  }

  /** End a continuous line without removing committed segments. */
  finishLineChain() {
    this.lineAnchor = null;
    this.preview = null;
    this.draw();
  }

  finishLine(start, end, shift = false) {
    const snapped = snapLine45(start, end, shift);
    if (Math.hypot(snapped[0] - start[0], snapped[1] - start[1]) < 0.001) {
      return start;
    }
    this.commitShape((value) => {
      this.paint.line(...start, ...snapped, this.brushSize, value);
    });
    return snapped;
  }

  finishShape(start, end, shift = false) {
    const adjusted = this.shapeEnd(start, end, shift);
    this.commitShape((value) => {
      if (this.mode === "rectangle") {
        this.paint.rectangle(...start, ...adjusted, this.brushSize, value, this.filled);
      } else if (this.mode === "ellipse") {
        this.paint.ellipse(...start, ...adjusted, this.brushSize, value, this.filled);
      }
    });
  }

  finishThreePoint(points, shift = false) {
    this.commitShape((value) => {
      if (this.mode === "rectangle") {
        this.paint.rotatedRectangle(
          ...points,
          this.brushSize,
          value,
          this.filled,
          shift,
        );
      } else if (this.mode === "ellipse") {
        this.paint.rotatedEllipse(...points, this.brushSize, value, this.filled, shift);
      }
    });
  }

  /** One click sets one construction point; the third commits the shape. */
  acceptShapePoint(point, shift = false) {
    this.shapePoints.push(point);
    if (this.shapePoints.length === 3) {
      this.finishThreePoint(this.shapePoints, shift);
      this.shapePoints = [];
    }
    this.preview = this.shapePoints.length
      ? {
          kind: "three-point",
          mode: this.mode,
          points: [...this.shapePoints],
          end: point,
          shift,
        }
      : null;
    this.draw();
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
    const point = raw.map(Math.round);
    if (pan) {
      this.canvas.setPointerCapture(event.pointerId);
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
    if (this.mode === "eyedropper") {
      const sampled = this.paint.sample(...point);
      if (sampled) this.callbacks.onSample?.(sampled);
      return;
    }
    if (this.mode === "fill") {
      this.commitShape((value) => this.paint.floodFill(...point, value));
      return;
    }
    if (this.mode === "line" && event.detail >= 2) {
      this.finishLineChain();
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = {
      type: this.mode === "brush" ? "brush" : "geometry",
      pointerId: event.pointerId,
      down: point,
      last: point,
      x: event.offsetX,
      y: event.offsetY,
      moved: false,
    };
    if (this.mode === "brush") {
      this.paint.begin();
      try {
        this.paint.line(
          ...point,
          ...point,
          this.brushSize,
          this.paint.value(this.value),
        );
        this.syncPixels();
      } catch (error) {
        this.cancelStroke();
        this.callbacks.onError?.(error);
      }
    } else if (this.mode === "line") {
      this.preview = {
        kind: "line",
        start: this.lineAnchor ?? point,
        end: point,
        shift: event.shiftKey,
      };
      this.draw();
    } else if (this.construction === "3-point") {
      this.preview = {
        kind: "three-point",
        mode: this.mode,
        points: this.shapePoints.length ? [...this.shapePoints] : [point],
        end: point,
        shift: event.shiftKey,
      };
      this.draw();
    } else {
      this.preview = {
        kind: "drag-shape",
        mode: this.mode,
        start: point,
        end: point,
        shift: event.shiftKey,
      };
      this.draw();
    }
  }

  pointerMove(event) {
    const p = this.toPixel(event.offsetX, event.offsetY);
    this.callbacks.onCursor?.(p);
    if (!this.drag) {
      if (this.lineAnchor && this.mode === "line") {
        this.preview = {
          kind: "line",
          start: this.lineAnchor,
          end: p,
          shift: event.shiftKey || this.shiftHeld,
        };
        this.draw();
      } else if (this.shapePoints.length && this.construction === "3-point") {
        this.preview = {
          kind: "three-point",
          mode: this.mode,
          points: [...this.shapePoints],
          end: p,
          shift: event.shiftKey || this.shiftHeld,
        };
        this.draw();
      }
      return;
    }
    if (this.drag.pointerId !== event.pointerId) return;
    if (this.drag.type === "pan") {
      this.panX = this.drag.panX + event.offsetX - this.drag.x;
      this.panY = this.drag.panY + event.offsetY - this.drag.y;
      this.draw();
      return;
    }
    const point = p.map(Math.round);
    if (Math.hypot(event.offsetX - this.drag.x, event.offsetY - this.drag.y) > 4) {
      this.drag.moved = true;
    }
    try {
      if (this.drag.type === "brush") {
        this.paint.line(
          ...this.drag.last,
          ...point,
          this.brushSize,
          this.paint.value(this.value),
        );
        this.drag.last = point;
        this.syncPixels();
      } else if (this.mode === "line") {
        this.preview = {
          kind: "line",
          start: this.lineAnchor ?? this.drag.down,
          end: point,
          shift: event.shiftKey || this.shiftHeld,
        };
        this.draw();
      } else if (this.construction === "3-point") {
        this.preview = {
          kind: "three-point",
          mode: this.mode,
          points: this.shapePoints.length ? [...this.shapePoints] : [this.drag.down],
          end: point,
          shift: event.shiftKey || this.shiftHeld,
        };
        this.draw();
      } else {
        this.preview = {
          kind: "drag-shape",
          mode: this.mode,
          start: this.drag.down,
          end: point,
          shift: event.shiftKey || this.shiftHeld,
        };
        this.draw();
      }
    } catch (error) {
      this.cancelStroke();
      this.callbacks.onError?.(error);
    }
  }

  pointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    this.updateCursor();
    if (drag.type === "pan") return;
    if (this.mode === "line" && !drag.moved && event.detail >= 2) {
      this.finishLineChain();
      return;
    }
    try {
      const point = this.toPixel(event.offsetX, event.offsetY).map(Math.round);
      const shift = event.shiftKey || this.shiftHeld;
      if (drag.type === "brush") {
        this.paint.commit();
      } else if (this.mode === "line") {
        if (drag.moved) {
          this.finishLine(this.lineAnchor ?? drag.down, point, shift);
          this.lineAnchor = null;
        } else if (this.lineAnchor) {
          this.lineAnchor = this.finishLine(this.lineAnchor, point, shift);
        } else {
          this.lineAnchor = drag.down;
        }
        this.preview = this.lineAnchor
          ? { kind: "line", start: this.lineAnchor, end: this.lineAnchor, shift }
          : null;
      } else if (this.construction === "3-point") {
        if (drag.moved && !this.shapePoints.length) {
          this.shapePoints.push(drag.down);
        }
        this.acceptShapePoint(point, shift);
      } else {
        this.finishShape(drag.down, point, shift);
        this.preview = null;
      }
      this.draw();
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
    this.lineAnchor = null;
    this.shapePoints = [];
    this.updateCursor();
    this.syncPixels();
    // syncPixels skips rendering when no pixels changed; clear stale previews anyway.
    this.draw();
  }

  undo() {
    this.cancelStroke();
    if (!this.paint?.undo()) return false;
    this.syncPixels();
    return true;
  }

  redo() {
    this.cancelStroke();
    if (!this.paint?.redo()) return false;
    this.syncPixels();
    return true;
  }

  reset() {
    if (!this.paint) return;
    this.cancelStroke();
    this.paint.reset();
    this.syncPixels(true);
  }
}
