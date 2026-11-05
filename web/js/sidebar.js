/** Shared resizable and collapsible sidebar for both editors. */
const WIDTH_KEY = "waypoint_workbench_sidebar_width";
const COLLAPSED_KEY = "waypoint_workbench_sidebar_collapsed";
const MIN_WIDTH = 220;
const MAX_WIDTH = 600;

const clamp = (value) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));

export function initSidebar() {
  const layout = document.querySelector(".layout");
  const divider = document.getElementById("sidebarDivider");
  const toggle = document.getElementById("toggleSidebar");
  if (!layout || !divider || !toggle) return;

  const stored = Number(localStorage.getItem(WIDTH_KEY));
  let width = Number.isFinite(stored) && stored >= MIN_WIDTH ? clamp(stored) : 280;
  let collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
  let resizing = null;

  function paint() {
    layout.style.setProperty("--sidebar-width", `${width}px`);
    layout.classList.toggle("sidebar-collapsed", collapsed);
    toggle.textContent = collapsed ? "›" : "‹";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    divider.setAttribute("aria-valuenow", String(width));
    divider.setAttribute("aria-valuemin", String(MIN_WIDTH));
    divider.setAttribute("aria-valuemax", String(MAX_WIDTH));
  }

  function setWidth(value) {
    const available = Math.max(MIN_WIDTH, window.innerWidth - 320);
    width = clamp(Math.min(value, available));
    paint();
  }

  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    paint();
  });

  divider.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      collapsed ||
      window.matchMedia("(max-width: 790px)").matches
    )
      return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    resizing = { id: event.pointerId, startX: event.clientX, initialWidth: width };
    layout.classList.add("is-resizing");
  });
  divider.addEventListener("pointermove", (event) => {
    if (resizing?.id === event.pointerId) {
      setWidth(resizing.initialWidth + event.clientX - resizing.startX);
    }
  });
  function finish(event) {
    if (resizing?.id !== event.pointerId) return;
    resizing = null;
    layout.classList.remove("is-resizing");
    localStorage.setItem(WIDTH_KEY, String(width));
  }
  divider.addEventListener("pointerup", finish);
  divider.addEventListener("pointercancel", finish);
  divider.addEventListener("keydown", (event) => {
    if (collapsed || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setWidth(width + (event.key === "ArrowRight" ? 16 : -16));
    localStorage.setItem(WIDTH_KEY, String(width));
  });
  window.addEventListener("resize", () => {
    if (!collapsed && window.innerWidth > 790) setWidth(width);
  });
  paint();
}
