import { initHelp } from "./help.js";
import {
  DEFAULT_ALIASES,
  DEFAULTS,
  MAX_TRACK_COLORS,
  TARGETS,
  TOKEN_KEY,
  download,
  nextTrackColor,
  readPreferences,
  savePreferences,
  validatePreferences,
} from "./preferences.js";
import { Api } from "./api.js";

const $ = (id) => document.getElementById(id);
initHelp("config");
const fields = ["apiUrl", "closureGap", "undoLimit", "csvDecimalPlaces"];

function row(alias = "", target = "other") {
  const element = document.createElement("div");
  element.className = "alias-row";
  const name = document.createElement("input");
  name.placeholder = "CSV column name";
  name.value = alias;
  name.setAttribute("aria-label", "CSV column name");
  const arrow = document.createElement("span");
  arrow.textContent = "→";
  arrow.className = "alias-arrow";
  const selection = document.createElement("select");
  selection.setAttribute("aria-label", "Mapped field");
  TARGETS.forEach((value) =>
    selection.add(new Option(value === "other" ? "other (keep)" : value, value)),
  );
  selection.value = target;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button icon danger";
  remove.textContent = "×";
  remove.title = "Remove mapping";
  element.append(name, arrow, selection, remove);
  remove.onclick = () => element.remove();
  $("aliasRows").append(element);
}

function updateColorCount() {
  const count = $("colors").children.length;
  $("colorCount").textContent = `${count} track slots`;
  $("addColor").disabled = count >= MAX_TRACK_COLORS;
  $("colors")
    .querySelectorAll(".color-remove")
    .forEach((button) => {
      button.disabled = count <= 1;
    });
  $("colors")
    .querySelectorAll(".color-title")
    .forEach((label, index) => {
      label.textContent = `Track ${index + 1}`;
    });
}

function colorRow(color) {
  const item = document.createElement("div");
  item.className = "color-row";
  const title = document.createElement("span");
  title.className = "color-title";
  const input = document.createElement("input");
  input.type = "color";
  input.setAttribute("aria-label", "Track color");
  input.value = color;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button small danger color-remove";
  remove.textContent = "×";
  remove.title = "Remove track color";
  remove.setAttribute("aria-label", "Remove track color");
  remove.onclick = () => {
    item.remove();
    updateColorCount();
  };
  item.append(title, input, remove);
  $("colors").append(item);
  updateColorCount();
}

function load(config) {
  for (const key of fields) $(key).value = config[key];
  $("colors").replaceChildren();
  config.colors.forEach((color) => colorRow(color));
  updateColorCount();
  $("aliasRows").replaceChildren();
  Object.entries(config.aliases).forEach(([alias, target]) => row(alias, target));
  $("token").value = sessionStorage.getItem(TOKEN_KEY) || "";
}

function values() {
  const aliases = {};
  for (const item of $("aliasRows").children) {
    const alias = item.querySelector("input").value.trim().toLowerCase();
    if (!alias) throw Error("CSV alias cannot be empty");
    if (Object.hasOwn(aliases, alias)) throw Error(`Duplicate CSV alias: ${alias}`);
    aliases[alias] = item.querySelector("select").value;
  }
  return validatePreferences({
    apiUrl: $("apiUrl").value.trim(),
    closureGap: Number($("closureGap").value),
    undoLimit: Number($("undoLimit").value),
    csvDecimalPlaces:
      $("csvDecimalPlaces").value.trim() === ""
        ? NaN
        : Number($("csvDecimalPlaces").value),
    colors: [...$("colors").querySelectorAll('input[type="color"]')].map(
      (el) => el.value,
    ),
    aliases,
  });
}

function save() {
  const saved = savePreferences(values());
  if ($("token").value) sessionStorage.setItem(TOKEN_KEY, $("token").value);
  else sessionStorage.removeItem(TOKEN_KEY);
  $("configMessage").textContent = "Saved";
  return saved;
}

function run(action) {
  Promise.resolve()
    .then(action)
    .catch((error) => {
      $("configMessage").textContent = error.message;
    });
}

load(readPreferences());
$("settings").addEventListener("submit", (event) => {
  event.preventDefault();
  run(save);
});
$("addAlias").addEventListener("click", () => row());
$("resetAliases").addEventListener("click", () => {
  $("aliasRows").replaceChildren();
  Object.entries(DEFAULT_ALIASES).forEach(([alias, target]) => row(alias, target));
});
$("addColor").addEventListener("click", () => {
  const colors = [...$("colors").querySelectorAll('input[type="color"]')].map(
    (el) => el.value,
  );
  if (colors.length < MAX_TRACK_COLORS) colorRow(nextTrackColor(colors));
  updateColorCount();
});
$("resetColors").addEventListener("click", () => {
  $("colors").replaceChildren();
  DEFAULTS.colors.forEach((color) => colorRow(color));
  updateColorCount();
});
$("exportConfig").addEventListener("click", () =>
  run(() => {
    download(
      new Blob([JSON.stringify(values(), null, 2)], { type: "application/json" }),
      "waypoint_config.json",
    );
  }),
);
$("importConfig").addEventListener("click", () => $("configFile").click());
$("configFile").addEventListener("change", () =>
  run(async () => {
    const file = $("configFile").files[0];
    if (!file) return;
    load(savePreferences(JSON.parse(await file.text())));
    $("configMessage").textContent = "Imported";
    $("configFile").value = "";
  }),
);
$("testApi").addEventListener("click", () =>
  run(async () => {
    save();
    const api = new Api();
    $("apiStatus").textContent = (await api.connect()) ? "Connected" : "Unavailable";
  }),
);
