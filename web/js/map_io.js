/** Browser ROS map import/export. Supports ordinary 8-bit P5/P2 PGM and PNG. */
function readHeaders(bytes) {
  const decoder = new TextDecoder("ascii");
  let offset = 0;
  const next = () => {
    while (offset < bytes.length) {
      if (bytes[offset] === 35) {
        while (offset < bytes.length && bytes[offset] !== 10) offset++;
      } else if ([9, 10, 13, 32].includes(bytes[offset])) offset++;
      else break;
    }
    const start = offset;
    while (offset < bytes.length && ![9, 10, 13, 32, 35].includes(bytes[offset]))
      offset++;
    return decoder.decode(bytes.subarray(start, offset));
  };
  const magic = next(),
    width = Number(next()),
    height = Number(next()),
    max = Number(next());
  if (
    !["P5", "P2"].includes(magic) ||
    !width ||
    !height ||
    max !== 255 ||
    width * height > 25_000_000
  )
    throw Error("Unsupported 8-bit PGM");
  if (magic === "P5") {
    // P5 header is followed by ONE whitespace character; subsequent bytes are pixels.
    if (![9, 10, 13, 32].includes(bytes[offset])) throw Error("Invalid PGM header");
    if (bytes[offset] === 13 && bytes[offset + 1] === 10) offset += 2;
    else offset++;
    if (bytes.length - offset < width * height) throw Error("Truncated PGM");
    return { width, height, pixels: bytes.subarray(offset, offset + width * height) };
  }
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Number(next());
    if (!Number.isFinite(pixels[i])) throw Error("Invalid PGM pixels");
  }
  return { width, height, pixels };
}

export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const field = (key) => {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*:`).test(line));
    if (index < 0) throw Error(`Missing map YAML field ${key}`);
    const content = lines[index]
      .replace(/^.*?:/, "")
      .replace(/\s+#.*$/, "")
      .trim();
    return { index, content: content.replace(/^['"]|['"]$/g, "") };
  };
  const image = field("image").content;
  if (!/^[\w-]+\.(pgm|png)$/i.test(image)) {
    throw Error("YAML image must reference a PGM or PNG in the same folder");
  }
  const originField = field("origin");
  let origin;
  if (originField.content.startsWith("[")) {
    origin = originField.content
      .slice(1, -1)
      .split(",")
      .map((part) => Number(part.trim()));
  } else {
    origin = [];
    for (const line of lines.slice(originField.index + 1)) {
      const match = line.match(
        /^\s*-\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:#.*)?$/,
      );
      if (!match) break;
      origin.push(Number(match[1]));
      if (origin.length === 3) break;
    }
  }
  const resolution = Number(field("resolution").content);
  const negate = lines.some((line) => /^\s*negate\s*:/.test(line))
    ? Number(field("negate").content)
    : 0;
  if (
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    !Number.isFinite(resolution) ||
    resolution <= 0 ||
    ![0, 1].includes(negate)
  ) {
    throw Error("Invalid map origin, resolution, or negate");
  }
  return { image, origin, resolution, negate };
}

export function updateYamlImage(text, name) {
  if (!/^[\w-]+\.(pgm|png)$/i.test(name)) throw Error("Invalid map image name");
  return text.replace(/^(\s*image\s*:\s*).*$/m, (_line, prefix) => prefix + name);
}

function pixelsToImage(pgm) {
  const canvas = document.createElement("canvas");
  canvas.width = pgm.width;
  canvas.height = pgm.height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(pgm.width, pgm.height);
  for (let i = 0; i < pgm.pixels.length; i++) {
    image.data.set([pgm.pixels[i], pgm.pixels[i], pgm.pixels[i], 255], i * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export async function loadMapPair(yamlName, yamlText, imageName, imageBlob) {
  if (!/^[-\w]+\.ya?ml$/i.test(yamlName)) throw Error("Invalid YAML filename");
  if (yamlText.length > 1_000_000 || imageBlob.size > 64_000_000) {
    throw Error("Map file is too large");
  }
  const doc = parseYaml(yamlText);
  if (doc.image !== imageName)
    throw Error(`YAML expects ${doc.image}; received ${imageName}`);
  let drawable;
  if (/\.pgm$/i.test(imageName)) {
    drawable = pixelsToImage(
      readHeaders(new Uint8Array(await imageBlob.arrayBuffer())),
    );
  } else {
    drawable = await createImageBitmap(imageBlob);
  }
  if (drawable.width * drawable.height > 25_000_000) throw Error("Map too large");
  return {
    id: yamlName.replace(/\.ya?ml$/i, ""),
    name: yamlName,
    yamlName,
    yamlText,
    imageName,
    imageBlob,
    image: drawable,
    width: drawable.width,
    height: drawable.height,
    origin: doc.origin,
    resolution: doc.resolution,
    negate: doc.negate,
  };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read a single map pair from a standard ZIP (stored or deflated). */
export async function extractMapZip(file) {
  if (file.size > 64_000_000) throw Error("Map ZIP exceeds 64 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6)) throw Error("Invalid map ZIP");
  const count = u16(end + 10);
  if (count < 2 || count > 5 || count !== u16(end + 8)) {
    throw Error("Map ZIP must contain one YAML and one PGM/PNG image");
  }
  const centralEnd = u32(end + 16) + u32(end + 12);
  if (centralEnd > end) throw Error("Invalid ZIP directory");
  const decoder = new TextDecoder();
  let at = u32(end + 16);
  let total = 0;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > centralEnd || u32(at) !== 0x02014b50)
      throw Error("Invalid ZIP entry");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressed = u32(at + 20);
    const expanded = u32(at + 24);
    const filenameLength = u16(at + 28);
    const next = at + 46 + filenameLength + u16(at + 30) + u16(at + 32);
    if (next > centralEnd) throw Error("Truncated ZIP directory");
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + filenameLength));
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some((part) => part === ".." || part === "." || part.includes(":"))
    ) {
      throw Error("Unsafe ZIP filename");
    }
    if (!path.endsWith("/")) {
      const parts = path.split("/");
      if (
        parts.length > 2 ||
        parts.some((part) => !part) ||
        !/^[\w-]+\.(?:ya?ml|pgm|png)$/i.test(parts.at(-1))
      ) {
        throw Error("Map ZIP must contain only YAML and PGM/PNG files");
      }
      if (flags & 1 || ![0, 8].includes(method) || expanded > 32_000_000) {
        throw Error("Unsupported or oversized ZIP entry");
      }
      total += expanded;
      if (total > 64_000_000) throw Error("Map ZIP expanded size exceeds 64 MB");
      entries.push({
        path,
        name: parts.at(-1),
        folder: parts.slice(0, -1).join("/"),
        method,
        flags,
        crc,
        compressed,
        expanded,
        offset: u32(at + 42),
      });
    }
    at = next;
  }
  if (
    at !== centralEnd ||
    entries.length !== 2 ||
    entries[0].folder !== entries[1].folder ||
    entries.filter((entry) => /\.ya?ml$/i.test(entry.name)).length !== 1 ||
    entries.filter((entry) => /\.(?:pgm|png)$/i.test(entry.name)).length !== 1
  ) {
    throw Error("Map ZIP must contain exactly one YAML and one PGM/PNG image");
  }

  const files = [];
  for (const entry of entries) {
    const pos = entry.offset;
    if (
      pos + 30 > bytes.length ||
      u32(pos) !== 0x04034b50 ||
      u16(pos + 8) !== entry.method
    )
      throw Error("Invalid ZIP local entry");
    const start = pos + 30 + u16(pos + 26) + u16(pos + 28);
    if (start + entry.compressed > bytes.length) throw Error("Truncated ZIP content");
    const compressed = bytes.subarray(start, start + entry.compressed);
    let content;
    if (entry.method === 0) {
      content = compressed;
    } else {
      if (!globalThis.DecompressionStream)
        throw Error("ZIP decompression unavailable; unzip it first");
      let reader;
      try {
        reader = new Blob([compressed])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"))
          .getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 32_000_000 || size > entry.expanded) {
            await reader.cancel();
            throw Error("ZIP expanded size exceeds declared size");
          }
          chunks.push(value);
        }
        content = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) {
          content.set(chunk, cursor);
          cursor += chunk.length;
        }
      } catch (error) {
        throw Error(`Cannot decompress map ZIP: ${error.message}`);
      }
    }
    if (content.length !== entry.expanded || crc32(content) !== entry.crc) {
      throw Error(`Corrupted ZIP entry: ${entry.name}`);
    }
    files.push(new File([content], entry.name));
  }
  return files;
}

export async function mapFromFiles(inputFiles) {
  const zip = inputFiles.find((file) => /\.zip$/i.test(file.name));
  const files = zip ? await extractMapZip(zip) : inputFiles;
  const yamls = files.filter((file) => /\.ya?ml$/i.test(file.name));
  const images = files.filter((file) => /\.(?:pgm|png)$/i.test(file.name));
  if (files.length !== 2 || yamls.length !== 1 || images.length !== 1) {
    throw Error("Select one YAML and its referenced PGM/PNG image");
  }
  const yaml = yamls[0];
  const text = await yaml.text();
  const image = images[0];
  if (parseYaml(text).image !== image.name)
    throw Error(`YAML expects ${parseYaml(text).image}`);
  return loadMapPair(yaml.name, text, image.name, image);
}

export function blankMapFiles({ name, width, height, resolution, originX, originY }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw Error("Invalid map name");
  if (
    ![width, height].every(
      (size) => Number.isInteger(size) && size >= 1 && size <= 5000,
    ) ||
    width * height > 25_000_000
  )
    throw Error("Invalid map dimensions");
  if (
    !Number.isFinite(resolution) ||
    resolution <= 0 ||
    resolution > 10 ||
    !Number.isFinite(originX) ||
    !Number.isFinite(originY)
  ) {
    throw Error("Invalid map resolution or origin");
  }
  const imageName = `${name}.pgm`;
  const yamlName = `${name}.yaml`;
  const yamlText =
    `image: ${imageName}\nresolution: ${resolution}\n` +
    `origin: [${originX}, ${originY}, 0.0]\nnegate: 0\n` +
    "occupied_thresh: 0.65\nfree_thresh: 0.196\nmode: trinary\n";
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const pixels = new Uint8Array(width * height).fill(255);
  return {
    yamlName,
    yamlText,
    imageName,
    imageBlob: new Blob([header, pixels], { type: "application/octet-stream" }),
  };
}

export function encodePGM(width, height, rgba) {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const bytes = new Uint8Array(header.length + width * height);
  bytes.set(header);
  for (let i = 0; i < width * height; i++) bytes[header.length + i] = rgba[i * 4];
  return new Blob([bytes], { type: "application/octet-stream" });
}

export function zipFiles(files) {
  // Minimal ZIP writer: stored entries, CRC-32; compatible with Windows Explorer.
  const encoder = new TextEncoder();
  const parts = [],
    directory = [];
  let offset = 0;
  const write = (size) => new DataView(new ArrayBuffer(size));
  for (const [name, data] of files) {
    const filename = encoder.encode(name),
      content = data instanceof Uint8Array ? data : encoder.encode(data);
    const crc = crc32(content),
      head = write(30),
      localOffset = offset;
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, content.length, true);
    head.setUint32(22, content.length, true);
    head.setUint16(26, filename.length, true);
    parts.push(head.buffer, filename, content);
    offset += 30 + filename.length + content.length;
    directory.push({ filename, crc, size: content.length, offset: localOffset });
  }
  const centralStart = offset;
  for (const entry of directory) {
    const head = write(46);
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint32(16, entry.crc, true);
    head.setUint32(20, entry.size, true);
    head.setUint32(24, entry.size, true);
    head.setUint16(28, entry.filename.length, true);
    head.setUint32(42, entry.offset, true);
    parts.push(head.buffer, entry.filename);
    offset += 46 + entry.filename.length;
  }
  const end = write(22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, directory.length, true);
  end.setUint16(10, directory.length, true);
  end.setUint32(12, offset - centralStart, true);
  end.setUint32(16, centralStart, true);
  parts.push(end.buffer);
  return new Blob(parts, { type: "application/zip" });
}

export function timestamp() {
  const d = new Date();
  const n = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}_${n(
    d.getHours(),
  )}${n(d.getMinutes())}${n(d.getSeconds())}`;
}

export async function downloadMapZip(map, grayPixels = null, baseName = null) {
  const stem = baseName || map.id;
  if (!/^[\w-]{1,80}$/.test(stem))
    throw Error("Map name must contain letters, numbers, _ or -");
  const renamed = stem !== map.id;
  const imageName = renamed
    ? `${stem}.${map.imageName.split(".").at(-1).toLowerCase()}`
    : map.imageName;
  const yamlName = renamed ? `${stem}.yaml` : map.yamlName;
  const imageBlob = grayPixels
    ? imageName.endsWith(".pgm")
      ? encodePGM(map.width, map.height, grayPixels)
      : await new Promise((resolve) => {
          const canvas = document.createElement("canvas");
          canvas.width = map.width;
          canvas.height = map.height;
          canvas
            .getContext("2d")
            .putImageData(new ImageData(grayPixels, map.width, map.height), 0, 0);
          canvas.toBlob(resolve, "image/png");
        })
    : map.imageBlob;
  const folder = `${stem}_${timestamp()}`;
  const archive = zipFiles([
    [
      `${folder}/${yamlName}`,
      renamed ? updateYamlImage(map.yamlText, imageName) : map.yamlText,
    ],
    [`${folder}/${imageName}`, new Uint8Array(await imageBlob.arrayBuffer())],
  ]);
  return { archive, filename: `${folder}.zip` };
}
