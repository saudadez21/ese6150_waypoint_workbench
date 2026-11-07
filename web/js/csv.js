/** Name-based CSV parsing. Every untouched column is preserved on export. */

export class CsvColumnsError extends Error {
  constructor(missing, detail = "") {
    super(detail || `Missing required CSV columns: ${missing.join(", ")}`);
    this.name = "CsvColumnsError";
    this.missing = missing;
  }
}

function canonical(raw, aliases = {}) {
  const name = raw
    .replace(/^\ufeff/, "")
    .trim()
    .toLowerCase();
  return aliases[name] || (["x", "y", "v"].includes(name) ? name : null);
}

export function targetFor(name, aliases = {}) {
  return canonical(name, aliases);
}

function rowsFromCSV(text, delimiter) {
  const rows = [];
  let row = [],
    cell = "",
    quote = false;
  const normalized = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '"') {
      if (quote && normalized[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quote && cell.trim() !== "") {
        throw Error("Unexpected CSV quote");
      } else {
        quote = !quote;
      }
    } else if (ch === delimiter && !quote) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" && !quote) {
      row.push(cell.trim());
      if (row.some((entry) => entry !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (quote) throw Error("Unclosed CSV quote");
  row.push(cell.trim());
  if (row.some((entry) => entry !== "")) rows.push(row);
  return rows;
}

function delimiterFor(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate =
    lines.find((line) => !line.startsWith("#") && /[,;]/.test(line)) ||
    lines.find((line) => /[,;]/.test(line)) ||
    "";
  return (candidate.match(/;/g) || []).length > (candidate.match(/,/g) || []).length
    ? ";"
    : ",";
}

function isNumeric(row) {
  return row.every((cell) => cell !== "" && Number.isFinite(Number(cell)));
}

export function parseCSV(text, aliases = {}, limit = 20000) {
  if (typeof text !== "string" || !text.trim()) throw Error("Empty CSV");
  const delimiter = delimiterFor(text);
  const rows = rowsFromCSV(text, delimiter);
  const comments = rows.filter((row) => row[0].startsWith("#"));
  const body = rows.filter((row) => !row[0].startsWith("#"));
  if (!body.length) throw Error("CSV has no waypoint rows");

  let header = null;
  let headerKind = "none";
  const commentHeader = comments
    .map((row) => [row[0].replace(/^#\s*/, ""), ...row.slice(1)])
    .find(
      (row) =>
        row.some((name) => canonical(name, aliases) === "x") &&
        row.some((name) => canonical(name, aliases) === "y"),
    );
  if (commentHeader) {
    header = commentHeader;
    headerKind = "comment";
  } else if (!isNumeric(body[0])) {
    header = body.shift();
    headerKind = "normal";
  } else if (body[0].length === 2) {
    header = ["x", "y"];
  } else {
    throw new CsvColumnsError(
      ["x", "y"],
      "Headerless CSV with more than two columns needs column names",
    );
  }

  const targets = header.map((name) => canonical(name, aliases));
  const missing = ["x", "y"].filter((key) => !targets.includes(key));
  if (missing.length) throw new CsvColumnsError(missing);
  for (const key of ["x", "y"]) {
    if (targets.filter((name) => name === key).length > 1) {
      throw Error(`Multiple columns map to ${key}; check Config aliases`);
    }
  }
  // Only the first recognized speed column is used for visualization.
  for (const key of ["v"]) {
    let found = false;
    for (let i = 0; i < targets.length; i++) {
      if (targets[i] === key) {
        if (found) targets[i] = null;
        found = true;
      }
    }
  }
  if (body.length < 2) throw Error("At least two waypoint rows are required");
  if (body.length > limit) throw Error(`CSV exceeds ${limit} points`);
  const xIndex = targets.indexOf("x");
  const yIndex = targets.indexOf("y");
  const speedIndex = targets.indexOf("v");
  const points = [],
    speed = [];
  for (const [i, cells] of body.entries()) {
    if (cells.length !== header.length) {
      throw Error(
        `Row ${i + 1}: expected ${header.length} columns, got ${cells.length}`,
      );
    }
    const x = Number(cells[xIndex]);
    const y = Number(cells[yIndex]);
    if (
      cells[xIndex] === "" ||
      cells[yIndex] === "" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw Error(`Row ${i + 1}: invalid x/y coordinate`);
    }
    points.push([x, y]);
    speed.push(speedIndex === -1 ? NaN : Number(cells[speedIndex]));
  }
  const validSpeed =
    speedIndex >= 0 &&
    body.every(
      (cells, i) =>
        cells[speedIndex] !== "" && Number.isFinite(speed[i]) && speed[i] >= 0,
    );
  return {
    points,
    speed: validSpeed ? speed : null,
    originalCSV: text,
    columns: [...header],
  };
}

function formatDecimal(value, places) {
  if (!Number.isFinite(value)) throw Error("Invalid waypoint coordinate");
  const fixed = value.toFixed(places);
  const trimmed = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  return Number(trimmed) === 0 ? "0" : trimmed;
}

export function writeCSV(track, decimalPlaces = 6) {
  if (!track?.points?.length) throw Error("No track selected");
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 12) {
    throw Error("CSV decimal places must be an integer from 0 to 12");
  }
  // No geometry edits: preserve every header and original value, including unknown columns.
  if (typeof track.originalCSV === "string") {
    return track.originalCSV;
  }
  return (
    "x,y\n" +
    track.points
      .map(
        ([x, y]) =>
          `${formatDecimal(x, decimalPlaces)},${formatDecimal(y, decimalPlaces)}`,
      )
      .join("\n") +
    "\n"
  );
}
