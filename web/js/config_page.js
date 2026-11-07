import { initHelp } from "./help.js";
import { createIcon } from "./icons.js";
import {
  DEFAULT_ALIASES,
  TARGETS,
  TOKEN_KEY,
  download,
  readPreferences,
  savePreferences,
  validatePreferences,
} from "./preferences.js";
import { Api } from "./api.js";

const $ = (id) => document.getElementById(id);
initHelp("config");
const fields = ["apiUrl", "closureGap", "maxTracks", "csvDecimalPlaces"];

function row(alias = "", target = "x") {
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
  TARGETS.forEach((value) => selection.add(new Option(value, value)));
  selection.value = target;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button icon-only danger config-remove";
  remove.append(createIcon("x"));
  remove.title = "Remove mapping";
  remove.setAttribute("aria-label", "Remove mapping");
  element.append(name, arrow, selection, remove);
  remove.onclick = () => element.remove();
  $("aliasRows").append(element);
}

function load(config) {
  for (const key of fields) $(key).value = config[key];
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
    maxTracks: Number($("maxTracks").value),
    csvDecimalPlaces:
      $("csvDecimalPlaces").value.trim() === ""
        ? NaN
        : Number($("csvDecimalPlaces").value),
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
    const settings = values();
    const api = new Api();
    api.base = settings.apiUrl.replace(/\/$/, "");
    api.token = $("token").value;
    $("apiStatus").textContent = (await api.connect()) ? "Connected" : "Unavailable";
  }),
);
