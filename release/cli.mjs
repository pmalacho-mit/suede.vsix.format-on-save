#!/usr/bin/env node
// Ask the running editor about files, or have it format them by saving them.
//
//   node cli.mjs status <file or glob…>   is each open in a tab, does it have unsaved changes, does it format on save
//   node cli.mjs format <file or glob…>   save each through the editor, so format-on-save runs as configured
//   node cli.mjs window [folder]          is the editor's window in front: { focused, active }; exits 0 when it
//                                         is focused, 1 when not (a browser tab behind is throttled), 2 with no editor
//
// Quote a glob ('src/**/*.ts') so the shell leaves it to this; `--exclude <glob>` leaves out what it
// matches, and node_modules is always left out. Prints a JSON array, one result per file in the
// order given, and for `format` a summary on stderr. Exits 0 when every file is fine, 3 when some
// were only skipped (`skipped: true`: "unsaved-changes", "format-on-save-off"), 1 when one failed
// (`error` says why), 2 when no editor window has a file's folder open, and 64 for a usage error.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// the same as the extension's
const SOCKETS = path.join(
  os.tmpdir(),
  `vscode-format-on-save-${process.getuid?.() ?? os.userInfo().username}`,
);

// the same as the extension's `socketFor`
const socketFor = (folder) =>
  path.join(
    SOCKETS,
    `${crypto.createHash("sha1").update(path.resolve(folder)).digest("hex").slice(0, 16)}.sock`,
  );

/** Whether `SOCKETS` is this user's alone: a socket in a directory others can write to could be anyone's. */
function ours() {
  const stats = fs.lstatSync(SOCKETS, { throwIfNoEntry: false });
  return (
    !!stats?.isDirectory() &&
    (!process.getuid ||
      (stats.uid === process.getuid() && !(stats.mode & 0o077)))
  );
}

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
    const request = http.request(
      { socketPath: socket, path: route, method: "POST" },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error(body);
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ files }));
  });

const USAGE =
  "usage: cli.mjs status|format [--exclude <glob>]… <file or glob>…\n       cli.mjs window [folder]";
const usage = (problem) => {
  console.error(problem ? `${problem}\n${USAGE}` : USAGE);
  process.exit(64);
};

const [command, ...rest] = process.argv.slice(2);

// the window that has `folder` (here by default) open: whether it is in front
if (command === "window") {
  const folder = path.resolve(rest[0] ?? ".");
  const socket = ours() && socketOf(path.join(folder, "_"));
  try {
    if (!socket) throw new Error(`no editor window has ${folder} open`);
    const state = await ask(socket, "/window", []);
    console.log(JSON.stringify(state, null, 2));
    process.exit(state.focused ? 0 : 1);
  } catch (error) {
    console.log(
      JSON.stringify(
        { error: "no-editor", message: String(error.message ?? error) },
        null,
        2,
      ),
    );
    process.exit(2);
  }
}

if (!["status", "format"].includes(command)) usage();
const inputs = [];
const exclude = ["**/node_modules/**"];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--") {
    inputs.push(...rest.slice(i + 1));
    break;
  }
  if (rest[i] === "--exclude") {
    if (i + 1 === rest.length) usage("--exclude needs a glob");
    exclude.push(rest[++i]);
  } else if (rest[i].startsWith("--exclude="))
    exclude.push(rest[i].slice("--exclude=".length));
  else inputs.push(rest[i]);
}
if (!inputs.length) usage();

// `**` does not reach into a dot-directory (.github/…), so a `**/…` exclude is tried on each tail of the path too
const excluded = (file) => {
  const parts = path.relative(process.cwd(), file).split(path.sep);
  return exclude.some((pattern) =>
    pattern.startsWith("**/")
      ? parts.some((_, i) =>
          path.matchesGlob(parts.slice(i).join("/"), pattern),
        )
      : path.matchesGlob(parts.join("/"), pattern),
  );
};

// one slot per file to ask about, or per glob that matched none; each gets its `result`
const slots = [];
const seen = new Set();
const GLOB = /[*?[\]{}]/;
for (const input of inputs) {
  let matches = [path.resolve(input)];
  // a file named like a glob (Next.js's `[id].tsx`) is that file
  if (GLOB.test(input) && !fs.existsSync(input)) {
    if (!fs.globSync)
      usage(
        `globs need Node 22.14 or later; let the shell expand ${input} instead`,
      );
    matches = fs
      .globSync(input, { exclude })
      .map((match) => path.resolve(match))
      .filter(
        (match) =>
          !excluded(match) &&
          fs.statSync(match, { throwIfNoEntry: false })?.isFile(),
      );
    if (!matches.length)
      slots.push({
        result: {
          pattern: input,
          ok: false,
          error: "no-match",
          message: `no file matches ${input}`,
        },
      });
  }
  for (const file of matches) {
    if (seen.has(file)) continue;
    seen.add(file);
    slots.push({ file });
  }
}

// files grouped by the window that answers for them
const bySocket = new Map();
const trusted = ours();
for (const slot of slots.filter((s) => !s.result)) {
  const socket = trusted && socketOf(slot.file);
  if (!socket)
    slot.result = {
      file: slot.file,
      ok: false,
      error: "no-editor",
      message:
        fs.existsSync(SOCKETS) && !trusted
          ? `${SOCKETS} is not a directory only you can use, so no editor in it can be trusted`
          : `no editor window has a folder holding ${slot.file} open`,
    };
  else bySocket.set(socket, [...(bySocket.get(socket) ?? []), slot]);
}
for (const [socket, group] of bySocket) {
  try {
    const answers = await ask(
      socket,
      `/${command}`,
      group.map((slot) => slot.file),
    );
    group.forEach((slot, i) => (slot.result = answers[i]));
  } catch (error) {
    // a socket left behind by a window that is gone
    for (const slot of group)
      slot.result = {
        file: slot.file,
        ok: false,
        error: "no-editor",
        message: String(error.message ?? error),
      };
  }
}
const results = slots.map((slot) => slot.result);

console.log(JSON.stringify(results, null, 2));
if (command === "format") {
  // what an agent or a person needs at a glance: what was skipped or failed, and why
  const formatted = results.filter((r) => r.ok);
  const lines = [
    `formatted ${formatted.length} (${formatted.filter((r) => r.changed).length} changed)`,
  ];
  const why = Map.groupBy(
    results.filter((r) => r.error),
    (r) => `${r.skipped ? "skipped" : "failed"} (${r.error})`,
  );
  for (const [reason, group] of why)
    lines.push(
      `${reason}: ${group.map((r) => (r.file ? path.relative(process.cwd(), r.file) : r.pattern)).join(", ")}`,
    );
  console.error(lines.join("\n"));
}
const failed = (r) => r.error && !r.skipped;
process.exit(
  results.some((r) => r.error === "no-editor")
    ? 2
    : results.some(failed)
      ? 1
      : results.some((r) => r.skipped)
        ? 3
        : 0,
);
