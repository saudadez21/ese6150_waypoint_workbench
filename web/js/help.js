const GENERAL = [
  ["Right-drag", "Pan"],
  ["Space + drag", "Pan"],
  ["Wheel", "Zoom at pointer"],
  ["Ctrl/Cmd + Z", "Undo"],
  ["Ctrl/Cmd + Y", "Redo"],
  ["Esc", "Cancel / clear selection"],
];

export const HELP_SHORTCUTS = {
  waypoints: [
    ["Click point", "Select"],
    ["Ctrl/Cmd + click", "Toggle point"],
    ["Shift + click", "Select index range"],
    ["Drag empty area", "Box select"],
    ["Shift + box drag", "Add to selection"],
    ["Drag selected point", "Move selected points"],
    ["Ctrl/Cmd + A", "Select all (canvas focused)"],
    ["Delete / Backspace", "Delete selection"],
  ],
  maps: [
    ["Left-drag", "Paint with current tool"],
    ["Shift + ellipse", "Draw a circle"],
  ],
  config: [],
};

export function initHelp(page) {
  const button = document.querySelector("[data-help]");
  if (!button) return;
  const dialog = document.createElement("dialog");
  dialog.className = "shortcuts-dialog";
  dialog.setAttribute("aria-label", "Keyboard and mouse shortcuts");
  const title = document.createElement("h2");
  title.textContent = "Keyboard & Mouse Shortcuts";
  dialog.append(title);
  const addSection = (label, rows) => {
    if (!rows.length) return;
    const heading = document.createElement("h3");
    heading.textContent = label;
    const table = document.createElement("table");
    for (const [key, description] of rows) {
      const row = table.insertRow();
      const shortcut = row.insertCell();
      const meaning = row.insertCell();
      shortcut.textContent = key;
      meaning.textContent = description;
    }
    dialog.append(heading, table);
  };
  addSection(page === "waypoints" ? "Waypoints" : "Maps", HELP_SHORTCUTS[page] ?? []);
  if (page !== "config") addSection("General", GENERAL);
  else {
    const note = document.createElement("p");
    note.textContent =
      "Editor shortcuts are available on the Waypoints and Map Editor pages.";
    dialog.append(note);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button";
  close.textContent = "Close";
  close.onclick = () => dialog.close();
  dialog.append(close);
  document.body.append(dialog);
  button.onclick = () => dialog.showModal();
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "?" &&
      !event.repeat &&
      !dialog.open &&
      !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
    ) {
      event.preventDefault();
      dialog.showModal();
    }
  });
}
