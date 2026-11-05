import { readPreferences, TOKEN_KEY } from "./preferences.js";

export class Api {
  constructor() {
    const { apiUrl } = readPreferences();
    this.base = apiUrl.replace(/\/$/, "");
    this.token = sessionStorage.getItem(TOKEN_KEY) || "";
    this.online = false;
    this.capabilities = {};
  }

  async connect() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1800);
      let response;
      try {
        response = await fetch(`${this.base}/api/health`, {
          signal: controller.signal,
          cache: "no-store",
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw Error("API unavailable");
      const info = await response.json();
      if (info.service !== "waypoint_workbench") throw Error("Unknown API");
      this.online = true;
      this.capabilities = info.capabilities;
    } catch {
      this.online = false;
      this.capabilities = {};
    }
    return this.online;
  }

  async request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.token && options.method && options.method !== "GET") {
      headers.Authorization = `Bearer ${this.token}`;
    }
    let response;
    try {
      response = await fetch(`${this.base}${path}`, { ...options, headers });
    } catch (error) {
      this.online = false;
      this.capabilities = {};
      throw error;
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async list(kind) {
    return (await (await this.request(`/api/${kind}`)).json()).files;
  }

  async waypoint(name) {
    const response = await this.request(`/api/waypoints/${encodeURIComponent(name)}`);
    return { text: await response.text(), etag: response.headers.get("ETag") };
  }

  async map(name) {
    const response = await this.request(`/api/maps/${encodeURIComponent(name)}/bundle`);
    const item = await response.json();
    const bytes = Uint8Array.from(atob(item.image_base64), (char) =>
      char.charCodeAt(0),
    );
    return { ...item, blob: new Blob([bytes]) };
  }

  async uploadWaypoint(name, csv, etag = null) {
    const response = await this.request(`/api/waypoints/${encodeURIComponent(name)}`, {
      method: etag ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(etag ? { "If-Match": etag } : {}),
      },
      body: JSON.stringify({ text: csv }),
    });
    return response.json();
  }

  async uploadMap(map, etag = null) {
    const data = new FormData();
    data.append("yaml", new Blob([map.yamlText], { type: "text/plain" }), map.yamlName);
    data.append("image", map.imageBlob, map.imageName);
    const response = await this.request(
      `/api/maps/${encodeURIComponent(map.yamlName)}`,
      {
        method: etag ? "PUT" : "POST",
        headers: etag ? { "If-Match": etag } : {},
        body: data,
      },
    );
    return response.json();
  }
}

export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
