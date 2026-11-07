import { loadMapPair, mapFromFiles, parseYaml } from "./map_io.js";

/** Shared, memory-only map import across both editors. */
export class MapImportSession {
  constructor() {
    this.clear();
  }

  clear() {
    this.yaml = null;
    this.image = null;
  }

  get pending() {
    return Boolean(this.yaml || this.image);
  }

  async add(inputFiles) {
    const files = [...inputFiles];
    if (!files.length) return { map: null, message: "" };
    const zips = files.filter((file) => /\.zip$/i.test(file.name));
    if (zips.length) {
      if (files.length !== 1) throw Error("Select one map ZIP at a time");
      const map = await mapFromFiles(zips);
      this.clear();
      return { map, message: "" };
    }

    if (files.some((file) => !/\.(?:ya?ml|pgm|png|bmp)$/i.test(file.name))) {
      throw Error("Select YAML, PGM, PNG, BMP, or a map ZIP");
    }
    const yamls = files.filter((file) => /\.ya?ml$/i.test(file.name));
    const images = files.filter((file) => /\.(?:pgm|png|bmp)$/i.test(file.name));
    if (yamls.length > 1 || images.length > 1) {
      throw Error("Select at most one YAML and one image");
    }

    const yaml = yamls[0] ?? this.yaml;
    const image = images[0] ?? this.image;
    let expected = null;
    let yamlText = null;
    if (yaml) {
      yamlText = await yaml.text();
      expected = parseYaml(yamlText).image;
    }
    // Keep a valid YAML pending when the selected image does not match it.
    this.yaml = yaml;
    this.image = image;
    if (!yaml)
      return { map: null, message: `${image.name} selected · waiting for YAML` };
    if (!image)
      return { map: null, message: `${yaml.name} selected · waiting for ${expected}` };
    if (expected !== image.name) {
      this.image = null;
      return {
        map: null,
        message: `YAML expects ${expected}; select the matching image`,
        error: yamls.length === 1 && images.length === 1,
      };
    }
    const map = await loadMapPair(yaml.name, yamlText, image.name, image);
    this.clear();
    return { map, message: "" };
  }
}
