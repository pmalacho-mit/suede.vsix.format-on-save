#!/usr/bin/env node
// Ask the running editor about files, or have it format them by saving them.
//
//   node cli.mjs status <file…>   is each open in a tab, does it have unsaved changes, does it format on save
//   node cli.mjs format <file…>   save each through the editor, so format-on-save runs as configured
//
// Prints a JSON array, one result per file. Exits 0 when every file is fine, 1 when one is not
// (`error` says why: "unsaved-changes", "stale", "format-on-save-off", "not-found", "save-failed"),
// and 2 when no editor window has the file's folder open.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const SOCKETS = path.join(os.tmpdir(), "vscode-format-on-save");

// the same as the extension's `socketFor`
const socketFor = (folder) =>
  path.join(SOCKETS, `${crypto.createHash("sha1").update(path.resolve(folder)).digest("hex").slice(0, 16)}.sock`);

/** The socket of the window whose workspace folder holds `file`: the nearest one above it. */
function socketOf(file) {
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    const socket = socketFor(dir);
    if (fs.existsSync(socket)) return socket;
    if (path.dirname(dir) === dir) return null;
  }
}

const ask = (socket, route, files) =>
  new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: route, method: "POST" }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => (response.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(body))));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ files }));
  });

const [command, ...files] = process.argv.slice(2);
if (!["status", "format"].includes(command) || !files.length) {
  console.error("usage: cli.mjs status|format <file…>");
  process.exit(64);
}

// files grouped by the window that answers for them
const bySocket = new Map();
const results = [];
for (const file of files.map((f) => path.resolve(f))) {
  const socket = socketOf(file);
  if (!socket) results.push({ file, ok: false, error: "no-editor", message: `no editor window has a folder holding ${file} open` });
  else bySocket.set(socket, [...(bySocket.get(socket) ?? []), file]);
}
for (const [socket, group] of bySocket) {
  try {
    results.push(...(await ask(socket, `/${command}`, group)));
  } catch (error) {
    // a socket left behind by a window that is gone
    for (const file of group) results.push({ file, ok: false, error: "no-editor", message: String(error.message ?? error) });
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = (r) => r.ok === false || (command === "status" && r.error);
process.exit(results.some((r) => r.error === "no-editor") ? 2 : results.some(failed) ? 1 : 0);
