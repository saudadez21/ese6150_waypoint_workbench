/** Ordered path geometry. */
export function stats(points, closureGap = 0.75) {
  if (!points || points.length < 2) return { length: 0, gap: 0, closed: false };
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    );
  }
  const gap = Math.hypot(
    points[0][0] - points.at(-1)[0],
    points[0][1] - points.at(-1)[1],
  );
  const closed = gap <= closureGap;
  return { length: length + (closed ? gap : 0), gap, closed };
}

export function insertion(points, click, closed) {
  if (!points || points.length < 2) return null;
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const mag = dx * dx + dy * dy;
    if (mag === 0) continue;
    const t = Math.min(
      1,
      Math.max(0, ((click[0] - a[0]) * dx + (click[1] - a[1]) * dy) / mag),
    );
    const d = (click[0] - a[0] - t * dx) ** 2 + (click[1] - a[1] - t * dy) ** 2;
    if (best === null || d < best.d) {
      let index = i + 1;
      if (i === points.length - 1 && !closed) {
        const first = Math.hypot(click[0] - b[0], click[1] - b[1]);
        const last = Math.hypot(click[0] - a[0], click[1] - a[1]);
        index = first < last ? 0 : points.length;
      }
      best = { index, point: [...click], d };
    }
  }
  return best && { index: best.index, point: best.point };
}
