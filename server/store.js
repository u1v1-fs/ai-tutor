// Tiny JSON-file persistence. One file per collection under data/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// DATA_DIR lets hosts mount a persistent disk elsewhere (e.g. Render/Railway).
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DATA = DATA_DIR;

function file(name) {
  // Guard against path traversal: a name may contain sub-paths like
  // "docs/abc" but must never escape DATA (e.g. via ".." or absolute paths).
  const target = path.join(DATA, `${name}.json`);
  const resolved = path.resolve(target);
  const dataRoot = path.resolve(DATA) + path.sep;
  if (resolved !== path.resolve(DATA) && !resolved.startsWith(dataRoot)) {
    throw new Error("Invalid storage name: " + name);
  }
  return resolved;
}

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

export function save(name, data) {
  const target = file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

export function docFile(id) {
  return path.join(DATA, "docs", `${id}.json`);
}
