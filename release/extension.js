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

const SOCKETS = path.join(os.tmpdir(), "vscode-format-on-save");

/** Where the window holding `folder` listens: the command line computes the same. */
const socketFor = (folder) =>
  path.join(SOCKETS, `${crypto.createHash("sha1").update(path.resolve(folder)).digest("hex").slice(0, 16)}.sock`);

const same = (a, b) => path.resolve(a) === path.resolve(b);

const documentOf = (file) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && same(d.uri.fsPath, file));

const openInTab = (file) =>
  vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && same(tab.input.uri.fsPath, file)),
  );

const formatsOnSave = (document) =>
  vscode.workspace.getConfiguration("editor", document).get("formatOnSave", false);

async function status(file) {
  const loaded = documentOf(file);
  const result = { file, open: openInTab(file), dirty: loaded?.isDirty ?? false };
  if (!fs.existsSync(file)) return { ...result, error: "not-found", message: `${file} does not exist` };
  const document = loaded ?? (await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  return { ...result, formatOnSave: formatsOnSave(document) };
}

const lf = (text) => text.replace(/\r\n/g, "\n");

// the editor reloads a file changed on disk on its own schedule; saving before it has would
// write its older copy back over the change
async function caughtUp(document, timeout = 3000) {
  for (const started = Date.now(); Date.now() - started < timeout; await new Promise((r) => setTimeout(r, 50)))
    if (lf(document.getText()) === lf(fs.readFileSync(document.uri.fsPath, "utf8"))) return true;
  return false;
}

const apply = (build) => {
  const edit = new vscode.WorkspaceEdit();
  build(edit);
  return vscode.workspace.applyEdit(edit);
};

async function format(file) {
  const found = await status(file);
  const fail = (error, message) => ({ ...found, ok: false, error, message });
  if (found.error) return { ...found, ok: false };
  if (found.dirty)
    return fail(
      "unsaved-changes",
      `${file} has unsaved changes in the editor; saving it would save those too. Ask the user to save or discard them first.`,
    );
  if (!found.formatOnSave) return fail("format-on-save-off", `editor.formatOnSave is off for ${file}`);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  if (!(await caughtUp(document)))
    return fail("stale", `the editor has not picked up the latest change to ${file} on disk; try again`);
  const before = document.getText();
  // a save only happens for a document with changes: two edits that cancel out give it some
  const end = document.lineAt(document.lineCount - 1).range.end;
  await apply((e) => e.insert(document.uri, end, " "));
  await apply((e) => e.delete(document.uri, new vscode.Range(end, end.translate(0, 1))));
  if (!(await document.save())) return fail("save-failed", `the editor did not save ${file}`);
  return { ...found, ok: true, changed: document.getText() !== before };
}

const ROUTES = { "/status": status, "/format": format };

function serve(socket) {
  const server = http.createServer(async (request, response) => {
    const route = ROUTES[request.url];
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = (code, value) => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (!route) return reply(404, { error: `no route ${request.url}; try ${Object.keys(ROUTES).join(" or ")}` });
    try {
      const { files } = JSON.parse(body || "{}");
      const results = [];
      // one at a time: each save goes through the editor's own queue anyway
      for (const file of files ?? []) results.push(await route(path.resolve(file)));
      reply(200, results);
    } catch (error) {
      reply(500, { error: String(error) });
    }
  });
  fs.mkdirSync(SOCKETS, { recursive: true });
  fs.rmSync(socket, { force: true }); // a window that closed without cleaning up, or this folder in another window
  server.listen(socket, () => fs.chmodSync(socket, 0o600));
  return new vscode.Disposable(() => {
    server.close();
    fs.rmSync(socket, { force: true });
  });
}

function activate(context) {
  for (const folder of vscode.workspace.workspaceFolders ?? [])
    context.subscriptions.push(serve(socketFor(folder.uri.fsPath)));
}

module.exports = { activate, deactivate() {} };
