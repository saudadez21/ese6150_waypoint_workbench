import { nearestSegmentInsertion } from "./editor.js";

/** Map image and waypoint geometry canvas. The ROS world/pixel transform matches map_io.py. */
export class MapCanvas {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cb = callbacks;
    this.map = null;
    this.image = null;
    this.workspace = null;
    this.mode = "select";
    this.display = "normal";
    this.clearance = null;
    this.closureLimit = 0.75;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.drag = null;
    this.hover = null;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.17 : 1 / 1.17);
      },
      { passive: false },
    );
  }
  setMap(map, img) {
    this.map = map;
    this.image = img;
    this.fit();
  }
  setWorkspace(ws) {
    this.workspace = ws;
    this.draw();
  }
  setMode(mode) {
    this.mode = mode;
    this.canvas.style.cursor =
      mode === "add" ? "crosshair" : mode === "pan" ? "grab" : "default";
  }
  width() {
    return this.canvas.clientWidth;
  }
  height() {
    return this.canvas.clientHeight;
  }
  resize() {
    const w = this.width(),
      h = this.height();
    if (!w || !h) return;
    const dpi = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpi);
    this.canvas.height = Math.round(h * dpi);
    this.ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    if (!this.zoom || !this.panX) this.fit();
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
    } else {
      this.zoom = 1;
      this.panX = w / 2;
      this.panY = h / 2;
    }
    this.draw();
    this.cb.onZoom?.(this.zoom);
  }
  zoomAt(x, y, factor) {
    const before = this.toPixel(x, y);
    this.zoom = Math.max(0.035, Math.min(28, this.zoom * factor));
    this.panX = x - before[0] * this.zoom;
    this.panY = y - before[1] * this.zoom;
    this.draw();
    this.cb.onZoom?.(this.zoom);
  }
  screen(p) {
    const [x, y] = this.toPixelWorld(p);
    return [this.panX + x * this.zoom, this.panY + y * this.zoom];
  }
  toPixelWorld(p) {
    if (!this.map) return [p[0] * 20, -p[1] * 20];
    const [ox, oy, yaw] = this.map.origin,
      dx = p[0] - ox,
      dy = p[1] - oy,
      res = this.map.resolution;
    return [
      (Math.cos(yaw) * dx + Math.sin(yaw) * dy) / res,
      this.map.height - 1 - (-Math.sin(yaw) * dx + Math.cos(yaw) * dy) / res,
    ];
  }
  toWorld(px, py) {
    const p = this.toPixel(px, py);
    if (!this.map) return [p[0] / 20, -p[1] / 20];
    const [ox, oy, yaw] = this.map.origin,
      x = p[0] * this.map.resolution,
      y = (this.map.height - 1 - p[1]) * this.map.resolution;
    return [
      ox + Math.cos(yaw) * x - Math.sin(yaw) * y,
      oy + Math.sin(yaw) * x + Math.cos(yaw) * y,
    ];
  }
  toPixel(x, y) {
    return [(x - this.panX) / this.zoom, (y - this.panY) / this.zoom];
  }
  draw() {
    const c = this.ctx,
      w = this.width(),
      h = this.height();
    if (!w || !h) return;
    c.clearRect(0, 0, w, h);
    if (this.map && this.image) {
      c.save();
      c.globalAlpha = 0.86;
      c.imageSmoothingEnabled = true;
      c.drawImage(
        this.image,
        this.panX,
        this.panY,
        this.map.width * this.zoom,
        this.map.height * this.zoom,
      );
      c.restore();
    }
    if (!this.workspace) return;
    const active = this.workspace.active;
    // Draw active geometry underneath thin dashed reference tracks so that
    // coincident paths do not completely hide each other's colors.
    if (active?.visible) this.drawTrack(active, true);
    let referenceIndex = 0;
    for (const track of this.workspace.tracks) {
      if (track.visible && track !== active)
        this.drawTrack(track, false, referenceIndex++);
    }
    // Keep editable handles above the reference lines.
    if (active?.visible) this.drawPoints(active);
  }
  drawPath(points, color, speed = null, clearances = null, style = {}) {
    if (!points?.length) return;
    const c = this.ctx,
      n = points.length,
      screen = points.map((p) => this.screen(p)),
      gap = Math.hypot(
        points[0][0] - points[n - 1][0],
        points[0][1] - points[n - 1][1],
      ),
      closed = gap <= this.closureLimit;
    c.save();
    c.lineWidth = style.width ?? 2.5;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.globalAlpha = style.opacity ?? 1;
    if (style.dash) c.setLineDash(style.dash);
    if (style.dashOffset) c.lineDashOffset = style.dashOffset;
    const segments = closed ? n : n - 1;
    const low = speed ? Math.min(...speed) : 0,
      high = speed ? Math.max(...speed) : 1;
    for (let i = 0; i < segments; i++) {
      let stroke = color || "#60a5fa";
      if (speed) {
        const t = (speed[i] - low) / (high - low || 1);
        stroke = this.speedColor(t);
      }
      if (clearances) {
        const v = clearances[i];
        stroke =
          v < 0.008
            ? "#ef535e"
            : v < this.clearance.threshold_m
              ? "#ffc15e"
              : "#38d4a9";
      }
      c.strokeStyle = stroke;
      c.beginPath();
      c.moveTo(...screen[i]);
      c.lineTo(...screen[(i + 1) % n]);
      c.stroke();
    }
    if (!closed) {
      c.setLineDash([4, 7]);
      c.strokeStyle = "#f87171";
      c.lineWidth = 1.7;
      c.beginPath();
      c.moveTo(...screen[n - 1]);
      c.lineTo(...screen[0]);
      c.stroke();
    }
    c.restore();
  }
  speedColor(t) {
    const stops = [
      [59, 130, 246],
      [34, 197, 201],
      [251, 191, 36],
      [239, 83, 90],
    ];
    const a = Math.min(2, Math.floor(t * 3)),
      f = t * 3 - a;
    return `rgb(${stops[a]
      .map((v, i) => Math.round(v + (stops[a + 1][i] - v) * f))
      .join(",")})`;
  }
  drawTrack(track, active, referenceIndex = 0) {
    let speed = null,
      clearances = null;
    if (
      active &&
      this.workspace.tracks.length === 1 &&
      this.display === "speed" &&
      track.speed
    )
      speed = track.speed;
    if (active && this.display === "clearance" && this.clearance?.segment_clearances_m)
      clearances = this.clearance.segment_clearances_m;
    const style = active
      ? { width: 3.2 }
      : { width: 1.8, dash: [7, 7], dashOffset: referenceIndex * 3, opacity: 0.95 };
    this.drawPath(track.points, track.color, speed, clearances, style);
  }
  drawPoints(track) {
    // In clearance/speed modes, waypoint handles would obscure colored lines.
    // Keep hit-testing enabled so the user can still select/move points.
    if (this.display === "clearance" || this.display === "speed") return;
    const c = this.ctx,
      points = track.points;
    // Avoid expensive circles for huge datasets; selected point is always shown.
    const step = Math.max(1, Math.ceil(points.length / 2500));
    c.save();
    for (let i = 0; i < points.length; i += step) {
      const [x, y] = this.screen(points[i]);
      if (x < -8 || y < -8 || x > this.width() + 8 || y > this.height() + 8) continue;
      c.fillStyle = i === 0 ? "#fff" : track.color;
      c.beginPath();
      c.arc(x, y, i === 0 ? 4.2 : 2.4, 0, Math.PI * 2);
      c.fill();
    }
    if (track.selected != null) {
      const [x, y] = this.screen(points[track.selected]);
      c.strokeStyle = "#fff";
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, y, 8, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = track.color;
      c.beginPath();
      c.arc(x, y, 4, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  nearby(sx, sy) {
    const t = this.workspace?.active;
    if (!t) return null;
    let best = null,
      dist = 11;
    for (let i = 0; i < t.points.length; i++) {
      const p = this.screen(t.points[i]),
        d = Math.hypot(p[0] - sx, p[1] - sy);
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    return best;
  }
  insertSegment(point) {
    const t = this.workspace?.active;
    if (!t) return null;
    const first = t.points[0],
      last = t.points.at(-1);
    const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
    return nearestSegmentInsertion(t.points, point, gap <= this.closureLimit);
  }
  down(e) {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const point = this.toWorld(e.offsetX, e.offsetY),
      selected = this.nearby(e.offsetX, e.offsetY);
    if (this.mode === "add" && this.workspace?.active) {
      const segment = this.insertSegment(point);
      if (segment) this.cb.onAdd?.(segment);
      return;
    }
    if (this.mode === "select" && selected != null) {
      const t = this.workspace.active;
      t.selected = selected;
      this.drag = {
        type: "point",
        index: selected,
        start: [...t.points[selected]],
        moved: false,
      };
      this.cb.onSelection?.();
      this.draw();
      return;
    }
    this.drag = {
      type: "pan",
      x: e.offsetX,
      y: e.offsetY,
      panX: this.panX,
      panY: this.panY,
    };
    if (this.mode === "select" && this.workspace?.active) {
      this.workspace.active.selected = null;
      this.cb.onSelection?.();
      this.draw();
    }
  }
  move(e) {
    const world = this.toWorld(e.offsetX, e.offsetY);
    this.cb.onCursor?.(world);
    if (!this.drag) return;
    if (this.drag.type === "pan") {
      this.panX = this.drag.panX + e.offsetX - this.drag.x;
      this.panY = this.drag.panY + e.offsetY - this.drag.y;
      this.draw();
    } else if (this.drag.type === "point") {
      const t = this.workspace?.active;
      if (!t) return;
      const i = this.drag.index;
      t.points[i] = world;
      this.drag.moved =
        this.drag.moved ||
        Math.hypot(world[0] - this.drag.start[0], world[1] - this.drag.start[1]) > 1e-5;
      this.draw();
      this.cb.onSelection?.();
    }
  }
  up(e) {
    if (!this.drag) return;
    if (this.drag.type === "point" && this.drag.moved) {
      const t = this.workspace?.active;
      if (t) {
        const final = [...t.points[this.drag.index]];
        t.points[this.drag.index] = this.drag.start;
        this.cb.onDragEnd?.(this.drag.index, final);
      }
    }
    this.drag = null;
  }
}
