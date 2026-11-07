/** File-only drag and drop shared by both editors. */
export function hasFileTransfer(dataTransfer) {
  return Boolean(
    dataTransfer && Array.from(dataTransfer.types || []).includes("Files"),
  );
}

export function initFileDrop(overlay, onFiles) {
  let depth = 0;

  function hide() {
    depth = 0;
    overlay.classList.add("hidden");
  }

  document.addEventListener("dragenter", (event) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    depth += 1;
    overlay.classList.remove("hidden");
  });
  document.addEventListener("dragover", (event) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    overlay.classList.remove("hidden");
  });
  document.addEventListener("dragleave", (event) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  document.addEventListener("drop", (event) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    hide();
    if (files.length) onFiles(files);
  });
  window.addEventListener("blur", hide);
}
