// Format a file the way the editor is configured to: by saving it, so
// format-on-save runs with whatever formatter each language is set to use.
// Each window listens on a Unix socket per workspace folder (see `socketFor`),
// which the command line beside this file finds from a file's path.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

// one directory per user, so no one else can plant or replace a socket in it
const SOCKETS = path.join(
  os.tmpdir(),
  `vscode-format-on-save-${process.getuid?.() ?? os.userInfo().username}`,
);

/** Where the window holding `folder` listens: the command line computes the same. */
const socketFor = (folder) =>
  path.join(
    SOCKETS,
    `${crypto.createHash("sha1").update(path.resolve(folder)).digest("hex").slice(0, 16)}.sock`,
  );

/** Make `SOCKETS`, and refuse it if it is not this user's alone (someone else made it first). */
function claimSockets() {
  fs.mkdirSync(SOCKETS, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(SOCKETS);
  if (
    !stats.isDirectory() ||
    (process.getuid && (stats.uid !== process.getuid() || stats.mode & 0o077))
  )
    throw new Error(
      `${SOCKETS} is not a directory only you can use; remove it and reload the window`,
    );
}

const same = (a, b) => path.resolve(a) === path.resolve(b);

const documentOf = (file) =>
  vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && same(d.uri.fsPath, file),
  );

const openInTab = (file) =>
  vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        same(tab.input.uri.fsPath, file),
    ),
  );

async function status(file) {
  const loaded = documentOf(file);
  const result = {
    file,
    open: openInTab(file),
    dirty: loaded?.isDirty ?? false,
  };
  if (!fs.existsSync(file))
    return { ...result, error: "not-found", message: `${file} does not exist` };
  let document = loaded;
  try {
    document ??= await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  } catch (error) {
    // a directory, a binary file, one too large to load
    return {
      ...result,
      error: "cannot-open",
      message: `the editor cannot open ${file} as text: ${error.message ?? error}`,
    };
  }
  const editor = vscode.workspace.getConfiguration("editor", document);
  return {
    ...result,
    formatOnSave: editor.get("formatOnSave", false),
    formatOnSaveMode: editor.get("formatOnSaveMode", "file"),
  };
}

// the editor drops a byte order mark and may hold other line endings than the file does
const plain = (text) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

// the editor reloads a file changed on disk on its own schedule; saving before it has would
// write its older copy back over the change
async function caughtUp(document, timeout = 3000) {
  for (
    const started = Date.now();
    Date.now() - started < timeout;
    await new Promise((r) => setTimeout(r, 50))
  )
    if (
      plain(document.getText()) ===
      plain(fs.readFileSync(document.uri.fsPath, "utf8"))
    )
      return true;
  return false;
}

const apply = (build) => {
  const edit = new vscode.WorkspaceEdit();
  build(edit);
  return vscode.workspace.applyEdit(edit);
};

const unsaved = (file) =>
  `skipped ${file}: it has unsaved changes in the editor, and saving it would save those too. Ask the user to save or discard them first.`;

async function format(file) {
  const found = await status(file);
  const fail = (error, message) => ({ ...found, ok: false, error, message });
  // nothing was done, on purpose: not a failure, but the caller should know
  const skip = (error, message) => ({ ...fail(error, message), skipped: true });
  if (found.error) return { ...found, ok: false };
  if (found.dirty) return skip("unsaved-changes", unsaved(file));
  if (!found.formatOnSave)
    return skip(
      "format-on-save-off",
      `skipped ${file}: editor.formatOnSave is off for it`,
    );
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(file),
  );
  if (!(await caughtUp(document)))
    return fail(
      "stale",
      `the editor has not picked up the latest change to ${file} on disk; try again`,
    );
  // the user may have started typing in it while it caught up
  if (document.isDirty) return skip("unsaved-changes", unsaved(file));
  const before = document.getText();
  // a save only happens for a document with changes: two edits that cancel out give it some
  const end = document.lineAt(document.lineCount - 1).range.end;
  if (
    !(await apply((e) => e.insert(document.uri, end, " "))) ||
    !(await apply((e) =>
      e.delete(document.uri, new vscode.Range(end, end.translate(0, 1))),
    ))
  )
    return fail(
      "read-only",
      `the editor would not edit ${file}; it may be read-only`,
    );
  if (!(await document.save()))
    return fail("save-failed", `the editor did not save ${file}`);
  return { ...found, ok: true, changed: document.getText() !== before };
}

const ROUTES = { "/status": status, "/format": format };

// one file at a time, across requests too: two callers formatting the same file at once would
// interleave their edits
let queue = Promise.resolve();
const inTurn = (task) => (queue = queue.then(task, task));

async function attempt(route, file) {
  try {
    return await route(file);
  } catch (error) {
    return {
      file,
      ok: false,
      error: "failed",
      message: `${file}: ${error.message ?? error}`,
    };
  }
}

async function handle(request, response) {
  const route = ROUTES[request.url];
  let body = "";
  for await (const chunk of request) body += chunk;
  const reply = (code, value) => {
    response.writeHead(code, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (!route)
    return reply(404, {
      error: `no route ${request.url}; try ${Object.keys(ROUTES).join(" or ")}`,
    });
  let files;
  try {
    ({ files } = JSON.parse(body || "{}"));
  } catch {
    return reply(400, { error: "the body is not JSON" });
  }
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string"))
    return reply(400, { error: 'expected {"files": ["/absolute/path", …]}' });
  reply(
    200,
    await inTurn(async () => {
      const results = [];
      for (const file of files)
        results.push(await attempt(route, path.resolve(file)));
      return results;
    }),
  );
}

function serve(socket) {
  const server = http.createServer(handle);
  let inode;
  server.on("error", (error) =>
    console.error(
      `format-on-save: cannot listen on ${socket}: ${error.message}`,
    ),
  );
  fs.rmSync(socket, { force: true }); // a window that closed without cleaning up, or this folder in another window
  server.listen(socket, () => {
    fs.chmodSync(socket, 0o600);
    inode = fs.statSync(socket).ino;
  });
  return new vscode.Disposable(() => {
    server.close();
    // only if it is still ours: a window opened on the same folder since has put its own there
    try {
      if (fs.statSync(socket).ino === inode) fs.rmSync(socket);
    } catch {}
  });
}

function activate(context) {
  try {
    claimSockets();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Format on Save (from the command line): ${error.message}`,
    );
    return;
  }
  const servers = new Map();
  const open = (folder) => {
    if (folder.uri.scheme === "file")
      servers.set(folder.uri.toString(), serve(socketFor(folder.uri.fsPath)));
  };
  const close = (folder) => {
    servers.get(folder.uri.toString())?.dispose();
    servers.delete(folder.uri.toString());
  };
  (vscode.workspace.workspaceFolders ?? []).forEach(open);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
      removed.forEach(close);
      added.forEach(open);
    }),
    new vscode.Disposable(() =>
      [...servers.values()].forEach((server) => server.dispose()),
    ),
  );
}

module.exports = { activate, deactivate() {} };
