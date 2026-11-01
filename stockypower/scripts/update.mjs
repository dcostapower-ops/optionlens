// Updates this Stockypower folder to the latest version on GitHub, in place.
// Run by update.bat (or `npm run update`).
//
// Never touched: .env (your keys), setup.bat (may hold your keys),
// update.bat (it's running), node_modules.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { ROOT } from "./load-env.mjs";

const REPO = "dcostapower-ops/optionlens";
const BRANCH = process.env.STOCKYPOWER_BRANCH || "claude/gallant-curie-5wel00";
const URL_TGZ = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
const SUBDIR = "stockypower/";
const KEEP = new Set([".env", "setup.bat", "update.bat"]);

// Minimal tar reader (handles the pax / GNU long-name headers GitHub uses).
function* tarEntries(buf) {
  let off = 0;
  let nextName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = data.toString("utf8").match(/\d+ path=([^\n]*)\n/);
      if (m) nextName = m[1];
      continue;
    }
    if (type === "L") {
      nextName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "g") continue;
    if (nextName) {
      name = nextName;
      nextName = null;
    }
    yield { name, type, data };
  }
}

console.log(`Downloading the latest Stockypower from github.com/${REPO} (${BRANCH})…`);
const r = await fetch(URL_TGZ, { signal: AbortSignal.timeout(120_000) });
if (!r.ok) {
  console.error(`Download failed (HTTP ${r.status}). Check your internet connection and try again.`);
  process.exit(1);
}
const tar = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));

let updated = 0;
let kept = 0;
for (const e of tarEntries(tar)) {
  // Entries look like "optionlens-<branch>/stockypower/<path>".
  const slash = e.name.indexOf("/");
  const rel = slash === -1 ? "" : e.name.slice(slash + 1);
  if (!rel.startsWith(SUBDIR)) continue;
  const inner = rel.slice(SUBDIR.length).replace(/\/$/, "");
  if (!inner) continue;
  const parts = inner.split("/");
  if (parts.some((p) => p === ".." || p === "")) continue; // never write outside this folder
  if (parts[0] === "node_modules") continue;
  const dest = path.join(ROOT, ...parts);
  if (e.type === "5") {
    fs.mkdirSync(dest, { recursive: true });
    continue;
  }
  if (e.type !== "0" && e.type !== "\0") continue;
  if (parts.length === 1 && KEEP.has(parts[0]) && fs.existsSync(dest)) {
    kept++;
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Batch files must keep their Windows line endings; tar gives the exact bytes.
  fs.writeFileSync(dest, e.data);
  updated++;
}

if (!updated) {
  console.error("The download didn't contain Stockypower. Nothing was changed.");
  process.exit(1);
}
console.log(`Updated ${updated} files. Kept your .env and setup.bat as they were.`);

console.log("Installing packages…");
const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-fund", "--no-audit"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (npm.status !== 0) {
  console.error("npm install failed. See the message above.");
  process.exitCode = 1;
} else {
  console.log("Update complete.");
}
