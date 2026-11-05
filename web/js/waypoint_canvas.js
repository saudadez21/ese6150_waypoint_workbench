import { insertion } from "./geometry.js";
import { selectedIndices } from "./tracks.js";

/** Renders ROS map coordinates and editable waypoint tracks. */
export class MapCanvas {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cb = callbacks;
    this.map = null;
    this.image = null;
    this.workspace = null;
    this.mode = "select";
    this.addMode = "insert";
    this.display = "normal";
    this.closureLimit = 0.75;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.drag = null;
    this.spaceHeld = false;
    this.tooltip = callbacks.tooltip ?? null;

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
    canvas.addEventListener("pointerleave", () => this.hideTooltip());

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (event) => this.down(event));
    canvas.addEventListener("pointermove", (event) => this.move(event));
    canvas.addEventListener("pointerup", (event) => this.up(event));
    canvas.addEventListener("pointercancel", (event) => this.cancel(event));
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 1.17 : 1 / 1.17);
      },
      { passive: false },
    );
  }

  width() {
    return this.canvas.clientWidth;
  }
  height() {
    return this.canvas.clientHeight;
  }

  setMap(map, image) {
    this.map = map;
    this.image = image;
    this.fit();
  }

  setWorkspace(workspace) {
    this.workspace = workspace;
    this.draw();
  }

  setMode(mode) {
    this.mode = mode;
    this.hideTooltip();
    this.updateCursor();
  }

  resize() {
    if (!this.width() || !this.height()) return;
    const dpi = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width() * dpi);
    this.canvas.height = Math.round(this.height() * dpi);
    this.ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    if (this.panX === 0 && this.panY === 0) this.fit();
    else this.draw();
  }

  fit() {
    const w = this.width(),
      h = this.height();
    if (!w || !h) return;
    if (this.map) {
      this.zoom = Math.min((w - 64) / this.map.width, (h - 64) / this.map.height);
      this.panX = (w - this.map.width * this.zoom) / 2;
      this.panY = (h - this.map.height * this.zoom) / 2;
    } else if (
      this.workspace?.items.some((track) => track.visible && track.points.length)
    ) {
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity;
      for (const track of this.workspace.items) {
        if (!track.visible || !track.points.length) continue;
        for (const [worldX, worldY] of track.points) {
          const x = worldX * 20,
            y = -worldY * 20;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
      this.zoom = Math.min(
        28,
        Math.max(
          0.035,
          Math.min((w - 64) / Math.max(1, x1 - x0), (h - 64) / Math.max(1, y1 - y0)),
        ),
      );
      this.panX = w / 2 - ((x0 + x1) * this.zoom) / 2;
      this.panY = h / 2 - ((y0 + y1) * this.zoom) / 2;
    } else {
      this.zoom = 1;
      this.panX = w / 2;
      this.panY = h / 2;
    }
    this.draw();
    this.cb.onZoom?.(this.zoom);
  }

  zoomAt(x, y, factor) {
    const previous = this.toPixel(x, y);
    this.zoom = Math.max(0.035, Math.min(28, this.zoom * factor));
    this.panX = x - previous[0] * this.zoom;
    this.panY = y - previous[1] * this.zoom;
    this.draw();
    this.cb.onZoom?.(this.zoom);
  }

  toPixel(x, y) {
    return [(x - this.panX) / this.zoom, (y - this.panY) / this.zoom];
  }

  toPixelWorld([x, y]) {
    if (!this.map) return [x * 20, -y * 20];
    const [ox, oy, yaw] = this.map.origin;
    const dx = x - ox,
      dy = y - oy;
    return [
      (Math.cos(yaw) * dx + Math.sin(yaw) * dy) / this.map.resolution,
      this.map.height -
        1 -
        (-Math.sin(yaw) * dx + Math.cos(yaw) * dy) / this.map.resolution,
    ];
  }

  toWorld(x, y) {
    const pixel = this.toPixel(x, y);
    if (!this.map) return [pixel[0] / 20, -pixel[1] / 20];
    const [ox, oy, yaw] = this.map.origin;
    const dx = pixel[0] * this.map.resolution;
    const dy = (this.map.height - 1 - pixel[1]) * this.map.resolution;
    return [
      ox + Math.cos(yaw) * dx - Math.sin(yaw) * dy,
      oy + Math.sin(yaw) * dx + Math.cos(yaw) * dy,
    ];
  }

  screen(point) {
    const [x, y] = this.toPixelWorld(point);
    return [this.panX + x * this.zoom, this.panY + y * this.zoom];
  }

  speedColor(value) {
    const stops = [
      [59, 130, 246],
      [34, 197, 201],
      [251, 191, 36],
      [239, 83, 90],
    ];
    const position = Math.max(0, Math.min(1, value)) * 3;
    const index = Math.min(2, Math.floor(position));
    const f = position - index;
    return `rgb(${stops[index]
      .map((n, i) => Math.round(n + (stops[index + 1][i] - n) * f))
      .join(",")})`;
  }

  drawPath(track, active, referenceIndex) {
    const { points } = track;
    if (points.length < 2) return;
    const ctx = this.ctx;
    const screen = points.map((point) => this.screen(point));
    const gap = Math.hypot(
      points[0][0] - points.at(-1)[0],
      points[0][1] - points.at(-1)[1],
    );
    const closed = gap <= this.closureLimit;
    const useSpeed =
      active &&
      this.workspace.items.length === 1 &&
      this.display === "speed" &&
      Array.isArray(track.speed);
    let low = Infinity,
      high = -Infinity;
    if (useSpeed) {
      for (const value of track.speed) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    ctx.save();
    ctx.lineWidth = active ? 3.2 : 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (!active) {
      ctx.setLineDash([7, 7]);
      ctx.lineDashOffset = referenceIndex * 3;
    }
    for (let i = 0; i < (closed ? points.length : points.length - 1); i++) {
      ctx.strokeStyle = useSpeed
        ? this.speedColor((track.speed[i] - low) / (high - low || 1))
        : track.color;
      ctx.beginPath();
      ctx.moveTo(...screen[i]);
      ctx.lineTo(...screen[(i + 1) % screen.length]);
      ctx.stroke();
    }
    if (!closed) {
      ctx.setLineDash([4, 7]);
      ctx.strokeStyle = "#f87171";
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(...screen.at(-1));
      ctx.lineTo(...screen[0]);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPoints(track) {
    if (this.display === "speed") return;
    const ctx = this.ctx;
    const selected = selectedIndices(track);
    const step = Math.max(1, Math.ceil(track.points.length / 2500));
    ctx.save();
    for (let i = 0; i < track.points.length; i += step) {
      const [x, y] = this.screen(track.points[i]);
      if (x < -8 || y < -8 || x > this.width() + 8 || y > this.height() + 8) continue;
      ctx.fillStyle = i === 0 ? "#ffffff" : track.color;
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 4.2 : 2.4, 0, 2 * Math.PI);
      ctx.fill();
    }
    for (const index of selected) {
      const [x, y] = this.screen(track.points[index]);
      if (x < -10 || y < -10 || x > this.width() + 10 || y > this.height() + 10)
        continue;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fillStyle = track.color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  draw() {
    if (!this.width() || !this.height()) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width(), this.height());
    if (this.map && this.image) {
      ctx.save();
      ctx.globalAlpha = 0.86;
      ctx.drawImage(
        this.image,
        this.panX,
        this.panY,
        this.map.width * this.zoom,
        this.map.height * this.zoom,
      );
      ctx.restore();
    }
    if (!this.workspace) return;
    const active = this.workspace.active;
    if (active?.visible) this.drawPath(active, true, 0);
    let referenceIndex = 0;
    for (const track of this.workspace.items) {
      if (track.visible && track !== active)
        this.drawPath(track, false, referenceIndex++);
    }
    if (active?.visible) this.drawPoints(active);
    if (this.drag?.type === "box") {
      const { startX, startY, endX, endY } = this.drag;
      ctx.save();
      ctx.fillStyle = "#729eff25";
      ctx.strokeStyle = "#92b2ff";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 4]);
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      ctx.fillRect(x, y, Math.abs(endX - startX), Math.abs(endY - startY));
      ctx.strokeRect(x, y, Math.abs(endX - startX), Math.abs(endY - startY));
      ctx.restore();
    }
  }

  updateCursor() {
    this.canvas.style.cursor =
      this.drag?.type === "pan"
        ? "grabbing"
        : this.spaceHeld || this.mode === "pan"
          ? "grab"
          : this.mode === "add" || this.mode === "select"
            ? "crosshair"
            : "default";
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.classList.add("hidden");
  }

  showTooltip(index, x, y) {
    const track = this.workspace?.active;
    if (!this.tooltip || !track || index == null) {
      this.hideTooltip();
      return;
    }
    const point = track.points[index];
    const speed =
      Array.isArray(track.speed) && Number.isFinite(track.speed[index])
        ? `\nv: ${track.speed[index].toFixed(3)} m/s`
        : "";
    this.tooltip.textContent = `Point #${index}\nX: ${point[0].toFixed(
      3,
    )} m · Y: ${point[1].toFixed(3)} m${speed}`;
    this.tooltip.classList.remove("hidden");
    const width = this.tooltip.offsetWidth || 190;
    const height = this.tooltip.offsetHeight || 56;
    this.tooltip.style.left = `${Math.max(
      8,
      Math.min(x + 14, this.width() - width - 8),
    )}px`;
    this.tooltip.style.top = `${Math.max(
      8,
      Math.min(y + 14, this.height() - height - 8),
    )}px`;
  }

  nearby(x, y) {
    const track = this.workspace?.active;
    if (!track?.visible) return null;
    let closest = null;
    let distance = 10;
    for (let i = 0; i < track.points.length; i++) {
      const pixel = this.screen(track.points[i]);
      const d = Math.hypot(pixel[0] - x, pixel[1] - y);
      if (d < distance) {
        closest = i;
        distance = d;
      }
    }
    return closest;
  }

  boxIndices(box) {
    const track = this.workspace?.active;
    if (!track?.visible) return [];
    const left = Math.min(box.startX, box.endX);
    const right = Math.max(box.startX, box.endX);
    const top = Math.min(box.startY, box.endY);
    const bottom = Math.max(box.startY, box.endY);
    const indices = [];
    for (let index = 0; index < track.points.length; index++) {
      const [x, y] = this.screen(track.points[index]);
      if (x >= left && x <= right && y >= top && y <= bottom) indices.push(index);
    }
    return indices;
  }

  down(event) {
    if (this.drag || ![0, 2].includes(event.button)) return;
    this.canvas.focus?.({ preventScroll: true });
    const pan = event.button === 2 || this.spaceHeld || this.mode === "pan";
    if (pan) {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        type: "pan",
        pointerId: event.pointerId,
        startX: event.offsetX,
        startY: event.offsetY,
        panX: this.panX,
        panY: this.panY,
      };
      this.hideTooltip();
      this.updateCursor();
      return;
    }
    const track = this.workspace?.active;
    if (this.mode === "add" && track) {
      event.preventDefault();
      const point = this.toWorld(event.offsetX, event.offsetY);
      if (this.addMode === "append" || track.points.length < 2) {
        this.cb.onAdd?.({ index: track.points.length, point });
      } else {
        const first = track.points[0],
          last = track.points.at(-1);
        const closed =
          track.points.length >= 3 &&
          Math.hypot(first[0] - last[0], first[1] - last[1]) <= this.closureLimit;
        const target = insertion(track.points, point, closed);
        if (target) this.cb.onAdd?.(target);
      }
      return;
    }
    if (this.mode !== "select" || !track || this.display === "speed") return;
    event.preventDefault();
    const index = this.nearby(event.offsetX, event.offsetY);
    if (index != null && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      if (event.shiftKey) this.cb.onRangeSelection?.(index);
      else this.cb.onToggleSelection?.(index);
      this.hideTooltip();
      this.draw();
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    if (index != null) {
      if (!selectedIndices(track).includes(index)) this.cb.onSelect?.([index], index);
      const indices = selectedIndices(track);
      this.drag = {
        type: "points",
        pointerId: event.pointerId,
        indices,
        original: indices.map((i) => [...track.points[i]]),
        startWorld: this.toWorld(event.offsetX, event.offsetY),
        moved: false,
      };
    } else {
      this.drag = {
        type: "box",
        pointerId: event.pointerId,
        startX: event.offsetX,
        startY: event.offsetY,
        endX: event.offsetX,
        endY: event.offsetY,
        extend: event.shiftKey,
      };
    }
    this.hideTooltip();
    this.draw();
  }

  move(event) {
    const point = this.toWorld(event.offsetX, event.offsetY);
    this.cb.onCursor?.(point);
    if (!this.drag) {
      if (this.mode === "select" && this.display !== "speed" && !this.spaceHeld) {
        this.showTooltip(
          this.nearby(event.offsetX, event.offsetY),
          event.offsetX,
          event.offsetY,
        );
      } else this.hideTooltip();
      return;
    }
    if (this.drag.pointerId !== event.pointerId) return;
    if (this.drag.type === "pan") {
      this.panX = this.drag.panX + event.offsetX - this.drag.startX;
      this.panY = this.drag.panY + event.offsetY - this.drag.startY;
    } else if (this.drag.type === "box") {
      this.drag.endX = event.offsetX;
      this.drag.endY = event.offsetY;
    } else if (this.drag.type === "points") {
      const track = this.workspace?.active;
      if (!track) return;
      const dx = point[0] - this.drag.startWorld[0];
      const dy = point[1] - this.drag.startWorld[1];
      this.drag.moved = this.drag.moved || Math.hypot(dx, dy) > 1e-5;
      for (let i = 0; i < this.drag.indices.length; i++) {
        const origin = this.drag.original[i];
        track.points[this.drag.indices[i]] = [origin[0] + dx, origin[1] + dy];
      }
      this.cb.onSelection?.();
    }
    this.draw();
  }

  finish(event, cancelled = false) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const drag = this.drag;
    const track = this.workspace?.active;
    this.drag = null;
    if (drag.type === "points" && track) {
      for (let i = 0; i < drag.indices.length; i++) {
        track.points[drag.indices[i]] = drag.original[i];
      }
      if (!cancelled && drag.moved) {
        const final = this.toWorld(event.offsetX, event.offsetY);
        this.cb.onDragEnd?.(
          final[0] - drag.startWorld[0],
          final[1] - drag.startWorld[1],
        );
      }
    } else if (drag.type === "box" && !cancelled) {
      drag.endX = event.offsetX;
      drag.endY = event.offsetY;
      const moved = Math.hypot(drag.endX - drag.startX, drag.endY - drag.startY) >= 4;
      this.cb.onBoxSelection?.(moved ? this.boxIndices(drag) : [], drag.extend);
    }
    this.updateCursor();
    this.cb.onSelection?.();
    this.draw();
  }

  up(event) {
    this.finish(event);
  }
  cancel(event) {
    this.finish(event, true);
  }
}
