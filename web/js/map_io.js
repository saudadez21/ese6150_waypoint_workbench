/** ROS map YAML, images and ZIP files. Editing logic lives in MapPaint. */
import "../vendor/js-yaml.min.js";
import {
  ZipReader,
  ZipWriter,
  BlobReader,
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  TextWriter,
  configure,
} from "../vendor/zip.min.js";
import { MAX_IMAGE_PIXELS, decodeOccupancy, encodeOccupancy } from "./map_codec.js";

configure({ useWebWorkers: false });
const IMAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(?:pgm|png|bmp)$/i;
const YAML_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.ya?ml$/i;
const ZIP_LIMIT = 64_000_000;

export function parseYaml(text) {
  let doc;
  try {
    doc = globalThis.jsyaml.load(text, { json: false });
  } catch (error) {
    throw Error(`Invalid map YAML: ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw Error("Map YAML must be a mapping");
  const { image, resolution, origin } = doc;
  for (const key of ["negate", "free_thresh", "occupied_thresh"]) {
    if (!Object.hasOwn(doc, key)) throw Error(`Map YAML is missing ${key}`);
  }
  const mode = String(doc.mode ?? "trinary").toLowerCase();
  if (typeof image !== "string" || !IMAGE_NAME.test(image))
    throw Error("YAML image must reference a local PGM, PNG, or BMP");
  if (
    typeof resolution !== "number" ||
    !Number.isFinite(resolution) ||
    resolution <= 0 ||
    !Array.isArray(origin) ||
    origin.length !== 3 ||
    !origin.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw Error("Invalid map resolution or origin");
  }
  if (![0, 1, true, false].includes(doc.negate)) throw Error("Invalid map negate");
  if (!["trinary", "scale", "raw"].includes(mode)) throw Error("Unsupported map mode");
  if (
    typeof doc.free_thresh !== "number" ||
    !Number.isFinite(doc.free_thresh) ||
    typeof doc.occupied_thresh !== "number" ||
    !Number.isFinite(doc.occupied_thresh) ||
    doc.free_thresh < 0 ||
    doc.occupied_thresh > 1 ||
    doc.free_thresh >= doc.occupied_thresh
  ) {
    throw Error("Invalid map occupancy thresholds");
  }
  return {
    image,
    resolution,
    origin,
    negate: Number(doc.negate),
    mode,
    freeThresh: doc.free_thresh,
    occupiedThresh: doc.occupied_thresh,
    extra: doc,
  };
}

/** Update the top-level image entry while retaining other YAML text. */
export function updateYamlImage(text, name) {
  if (!IMAGE_NAME.test(name)) throw Error("Invalid map image name");
  if (parseYaml(text).image === name) return text;
  const lines = text.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const match = lines[i].match(
      /^((?:image|"image"|'image')[ \t]*:[ \t]*)(?:'[^']*'|"(?:\\.|[^"])*"|[^#]*?)([ \t]*(?:#.*)?)$/,
    );
    if (match) {
      lines[i] = `${match[1]}${name}${match[2]}`;
      return lines.join("");
    }
  }
  throw Error("Cannot update image in this YAML layout; use a top-level image: field");
}

/** Read 8-bit Netpbm P2/P5 images. */
export function decodePGM(bytes) {
  const decoder = new TextDecoder("ascii");
  let offset = 0;
  const whitespace = (b) => [9, 10, 13, 32].includes(b);
  const token = () => {
    while (offset < bytes.length) {
      if (bytes[offset] === 35) {
        while (offset < bytes.length && bytes[offset] !== 10) offset++;
      } else if (whitespace(bytes[offset])) offset++;
      else break;
    }
    const start = offset;
    while (offset < bytes.length && !whitespace(bytes[offset]) && bytes[offset] !== 35)
      offset++;
    return decoder.decode(bytes.subarray(start, offset));
  };
  const magic = token(),
    width = Number(token()),
    height = Number(token()),
    max = Number(token());
  if (
    !["P2", "P5"].includes(magic) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_IMAGE_PIXELS ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 255
  )
    throw Error("Unsupported 8-bit PGM header");
  const pixels = new Uint8Array(width * height);
  if (magic === "P5") {
    if (!whitespace(bytes[offset])) throw Error("Invalid PGM data separator");
    if (bytes[offset] === 13 && bytes[offset + 1] === 10) offset += 2;
    else offset++;
    if (bytes.length - offset !== pixels.length) throw Error("Invalid PGM pixel count");
    for (let i = 0; i < pixels.length; i++) {
      const value = bytes[offset++];
      if (value > max) throw Error("PGM pixel exceeds Maxval");
      pixels[i] = Math.round((value * 255) / max);
    }
  } else {
    for (let i = 0; i < pixels.length; i++) {
      const next = token();
      if (!/^\d+$/.test(next) || Number(next) > max) throw Error("Invalid PGM pixel");
      pixels[i] = Math.round((Number(next) * 255) / max);
    }
    if (token()) throw Error("Extra PGM pixel data");
  }
  return { width, height, pixels };
}

function pgmRGBA(pgm) {
  const rgba = new Uint8ClampedArray(pgm.pixels.length * 4);
  for (let i = 0; i < pgm.pixels.length; i++) {
    const gray = pgm.pixels[i];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function assertImageSize(width, height) {
  if (!width || !height || width * height > MAX_IMAGE_PIXELS)
    throw Error("Map image dimensions are invalid or too large");
}

async function readImagePixels(name, blob) {
  if (/\.pgm$/i.test(name)) {
    const pgm = decodePGM(new Uint8Array(await blob.arrayBuffer()));
    return { width: pgm.width, height: pgm.height, rgba: pgmRGBA(pgm) };
  }
  // Avoid allocating an oversized native bitmap before inspecting image dimensions.
  const header = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  const view = new DataView(header.buffer);
  let width, height;
  if (/\.png$/i.test(name)) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      header.length < 26 ||
      !signature.every((b, i) => header[i] === b) ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452
    )
      throw Error("Image content is not PNG");
    width = view.getUint32(16);
    height = view.getUint32(20);
    if (header[24] > 8) throw Error("16-bit PNG images are not supported");
  } else {
    if (header.length < 26 || header[0] !== 66 || header[1] !== 77)
      throw Error("Image content is not BMP");
    const dib = view.getUint32(14, true);
    if (dib === 12) {
      width = view.getUint16(18, true);
      height = view.getUint16(20, true);
    } else if (dib >= 40) {
      width = view.getInt32(18, true);
      height = Math.abs(view.getInt32(22, true));
    } else throw Error("Unsupported BMP header");
  }
  assertImageSize(width, height);
  const bitmap = await createImageBitmap(blob);
  try {
    assertImageSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close?.();
  }
}

export async function loadMapPair(yamlName, yamlText, imageName, imageBlob) {
  if (!YAML_NAME.test(yamlName)) throw Error("Invalid YAML filename");
  if (yamlText.length > 1_000_000 || imageBlob.size > ZIP_LIMIT)
    throw Error("Map file is too large");
  const doc = parseYaml(yamlText);
  if (doc.image !== imageName)
    throw Error(`YAML expects ${doc.image}; received ${imageName}`);
  const { width, height, rgba } = await readImagePixels(imageName, imageBlob);
  return {
    id: yamlName.replace(/\.ya?ml$/i, ""),
    name: yamlName,
    yamlName,
    yamlText,
    imageName,
    imageBlob,
    width,
    height,
    cells: decodeOccupancy(rgba, doc),
    resolution: doc.resolution,
    origin: doc.origin,
    negate: doc.negate,
    mode: doc.mode,
    freeThresh: doc.freeThresh,
    occupiedThresh: doc.occupiedThresh,
  };
}

export async function extractMapZip(file) {
  if (file.size > ZIP_LIMIT) throw Error("Map ZIP exceeds 64 MB");
  const reader = new ZipReader(new BlobReader(file));
  try {
    const all = await reader.getEntries();
    const entries = all.filter((entry) => !entry.directory);
    if (
      entries.length !== 2 ||
      entries.reduce((sum, item) => sum + item.uncompressedSize, 0) > ZIP_LIMIT
    ) {
      throw Error("Map ZIP must contain exactly one YAML and one image (up to 64 MB)");
    }
    const parts = entries.map((entry) => entry.filename.split("/"));
    if (
      parts.some(
        (p) =>
          p.length > 2 ||
          p.some((part) => !part) ||
          (p.length === 2 && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(p[0])),
      ) ||
      parts[0].slice(0, -1).join("/") !== parts[1].slice(0, -1).join("/")
    ) {
      throw Error("Map ZIP files must share the same folder");
    }
    const names = parts.map((p) => p.at(-1));
    const yamls = names.filter((name) => YAML_NAME.test(name));
    const images = names.filter((name) => IMAGE_NAME.test(name));
    if (yamls.length !== 1 || images.length !== 1)
      throw Error("Map ZIP needs one YAML and one PGM/PNG/BMP image");
    const result = [];
    for (let i = 0; i < entries.length; i++) {
      const bytes = await entries[i].getData(new Uint8ArrayWriter());
      result.push(new File([bytes], names[i]));
    }
    return result;
  } catch (error) {
    throw Error(`Cannot read map ZIP: ${error.message}`);
  } finally {
    await reader.close();
  }
}

export async function mapFromFiles(inputFiles) {
  const zip = inputFiles.find((file) => /\.zip$/i.test(file.name));
  const files = zip ? await extractMapZip(zip) : inputFiles;
  const yamls = files.filter((file) => /\.ya?ml$/i.test(file.name));
  const images = files.filter((file) => /\.(?:pgm|png|bmp)$/i.test(file.name));
  if (files.length !== 2 || yamls.length !== 1 || images.length !== 1)
    throw Error("Select one YAML and its referenced PGM/PNG/BMP image");
  return loadMapPair(yamls[0].name, await yamls[0].text(), images[0].name, images[0]);
}

export function blankMapFiles({ name, width, height, resolution, originX, originY }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw Error("Invalid map name");
  if (
    ![width, height].every(
      (size) => Number.isInteger(size) && size >= 1 && size <= 5000,
    ) ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw Error("Invalid map dimensions");
  if (
    !Number.isFinite(resolution) ||
    resolution <= 0 ||
    resolution > 10 ||
    !Number.isFinite(originX) ||
    !Number.isFinite(originY)
  )
    throw Error("Invalid map resolution or origin");
  const imageName = `${name}.pgm`,
    yamlName = `${name}.yaml`;
  const yamlText = `image: ${imageName}\nresolution: ${resolution}\norigin: [${originX}, ${originY}, 0.0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\nmode: trinary\n`;
  return {
    yamlName,
    yamlText,
    imageName,
    imageBlob: encodePGM(width, height, new Uint8Array(width * height).fill(255)),
  };
}

export function encodePGM(width, height, rgbaOrGrayscale) {
  const grayscale =
    rgbaOrGrayscale.length === width * height
      ? rgbaOrGrayscale
      : Uint8Array.from({ length: width * height }, (_, i) => rgbaOrGrayscale[i * 4]);
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  return new Blob([header, grayscale], { type: "application/octet-stream" });
}

export function encodeBMP(width, height, rgba) {
  const stride = (width * 3 + 3) & ~3,
    size = 54 + stride * height;
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  bytes[0] = 66;
  bytes[1] = 77;
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * height, true);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4,
        dst = 54 + (height - 1 - y) * stride + x * 3;
      bytes[dst] = rgba[src + 2];
      bytes[dst + 1] = rgba[src + 1];
      bytes[dst + 2] = rgba[src];
    }
  return new Blob([bytes], { type: "image/bmp" });
}

async function encodePNG(width, height, rgba) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error("Cannot encode PNG"))),
      "image/png",
    ),
  );
}

export async function zipFiles(files) {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  const seen = new Set();
  try {
    for (const [name, data] of files) {
      if (seen.has(name)) throw Error("Duplicate ZIP entry");
      seen.add(name);
      await writer.add(
        name,
        typeof data === "string" ? new TextReader(data) : new Uint8ArrayReader(data),
      );
    }
    return await writer.close();
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

export function timestamp() {
  const d = new Date(),
    pad = (value) => String(value).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Single serialisation path for downloads and optional API uploads. */
export async function serializeMap(
  map,
  cells = map.cells,
  baseName = null,
  changed = false,
) {
  const stem = baseName || map.id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(stem)) throw Error("Invalid map name");
  const renamed = stem !== map.id;
  let extension = map.imageName.split(".").at(-1).toLowerCase();
  if (changed && map.mode === "scale") extension = "png"; // Alpha represents unknown cells.
  const imageName = renamed
    ? `${stem}.${extension}`
    : map.imageName.replace(/\.[^.]+$/, `.${extension}`);
  const yamlName = renamed ? `${stem}.yaml` : map.yamlName;
  let imageBlob = map.imageBlob;
  if (changed) {
    const rgba = encodeOccupancy(cells, map);
    imageBlob =
      extension === "pgm"
        ? encodePGM(map.width, map.height, rgba)
        : extension === "bmp"
          ? encodeBMP(map.width, map.height, rgba)
          : await encodePNG(map.width, map.height, rgba);
  }
  const yamlText =
    imageName === map.imageName
      ? map.yamlText
      : updateYamlImage(map.yamlText, imageName);
  return { yamlName, yamlText, imageName, imageBlob };
}

export async function downloadMapZip(
  map,
  cells = map.cells,
  baseName = null,
  changed = false,
) {
  const files = await serializeMap(map, cells, baseName, changed);
  const folder = `${baseName || map.id}_${timestamp()}`;
  const archive = await zipFiles([
    [`${folder}/${files.yamlName}`, files.yamlText],
    [
      `${folder}/${files.imageName}`,
      new Uint8Array(await files.imageBlob.arrayBuffer()),
    ],
  ]);
  return { archive, filename: `${folder}.zip` };
}
