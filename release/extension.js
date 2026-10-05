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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a language's formatter may come from an extension that only starts once a document of that
// language opens (Svelte's does); a save before it has registered is saved unformatted. So before a
// language's first save: start its default formatter, and wait until some formatter answers. Files
// of one language formatted at once share the wait; one that found none lets the next try again.
const readiness = new Map();
function formatterReady(document) {
  const language = document.languageId;
  if (!readiness.has(language))
    readiness.set(
      language,
      awaitFormatter(document).then((found) => {
        if (!found) readiness.delete(language);
        return found;
      }),
    );
  return readiness.get(language);
}

// whether a formatter has edits for the document: the editor gives none both when no formatter is
// registered and when the one that is has nothing to change
const formats = async (document) =>
  !!(
    await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      document.uri,
      { tabSize: 2, insertSpaces: true },
    )
  )?.length;

// called with the document already changed for its save, so that the blank lines added here, which
// any formatter takes out, and taken out again, leave its text as it was and it still to be saved
async function awaitFormatter(document, timeout = 10000) {
  const id = vscode.workspace
    .getConfiguration("editor", document)
    .get("defaultFormatter");
  if (id) await vscode.extensions.getExtension(id)?.activate();
  for (
    const started = Date.now();
    Date.now() - started < timeout;
    await sleep(100)
  ) {
    if (await formats(document)) return true;
    // a document already formatted gets no edits from a formatter that is there: ask about one
    // with blank lines at its end
    const end = document.lineAt(document.lineCount - 1).range.end;
    if (!(await apply((e) => e.insert(document.uri, end, "\n\n\n"))))
      return false;
    try {
      if (await formats(document)) return true;
    } finally {
      await apply((e) =>
        e.delete(
          document.uri,
          new vscode.Range(end, new vscode.Position(end.line + 3, 0)),
        ),
      );
    }
  }
  return false;
}

const apply = (build) => {
  const edit = new vscode.WorkspaceEdit();
  build(edit);
  return vscode.workspace.applyEdit(edit);
};

// a save only happens for a document with changes: give it some without changing its text. One
// edit, a character replaced with itself, where the editor counts that as a change; else two that
// cancel out. False when the editor would not edit it.
async function makeDirty(document) {
  for (let line = document.lineCount - 1; line >= 0; line--) {
    const { range, text } = document.lineAt(line);
    if (!text) continue;
    const last = new vscode.Range(range.end.translate(0, -1), range.end);
    if (!(await apply((e) => e.replace(document.uri, last, text.slice(-1)))))
      return false;
    if (document.isDirty) return true;
    break;
  }
  const end = document.lineAt(document.lineCount - 1).range.end;
  return (
    (await apply((e) => e.insert(document.uri, end, " "))) &&
    (await apply((e) =>
      e.delete(document.uri, new vscode.Range(end, end.translate(0, 1))),
    ))
  );
}

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
  if (!(await makeDirty(document)))
    return fail(
      "read-only",
      `the editor would not edit ${file}; it may be read-only`,
    );
  const ready = await formatterReady(document);
  // saved either way, its text as it was if nothing formats it: it is not left with changes to save
  if (!(await document.save()))
    return fail("save-failed", `the editor did not save ${file}`);
  const changed = document.getText() !== before;
  if (!ready && !changed)
    return fail(
      "no-formatter",
      `no formatter for ${document.languageId} answered within 10 seconds, so saving did not format ${file}; check editor.defaultFormatter and that its extension is installed`,
    );
  return { ...found, ok: true, changed };
}

const ROUTES = { "/status": status, "/format": format };

/** Whether the editor's window is in front: a browser tab in the background is throttled. */
const windowState = () => ({
  focused: vscode.window.state.focused,
  // whether the user has interacted with it recently (VS Code 1.89 and later)
  active: vscode.window.state.active ?? null,
});

// at most this many files at once, across requests: their saves overlap in the editor, which is
// where the time goes; one file's never do, since two at once would interleave their edits
const CONCURRENCY = 8;
let running = 0;
const waiting = [];
async function acquire() {
  while (running >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  running++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    running--;
    waiting.shift()?.();
  };
}
const locks = new Map();

// a save runs in the editor's window; a browser tab in the background is throttled, down to a
// timer a minute, so a save there can take minutes. Past this a file fails and gives up its place,
// so the rest go on; the file itself stays locked until its save lands, if it ever does.
const FILE_TIMEOUT = 30000;

const timedOut = (file) => ({
  file,
  ok: false,
  error: "timeout",
  message: `the editor did not finish with ${file} within ${FILE_TIMEOUT / 1000} seconds${
    vscode.window.state.focused
      ? ""
      : "; its window is not focused, and an editor in a browser tab in the background is throttled: bring it to the front and try again"
  }`,
});

async function attempt(route, file) {
  let timer;
  let release;
  const work = (locks.get(file) ?? Promise.resolve()).then(async () => {
    release = await acquire();
    try {
      return await route(file);
    } finally {
      release();
    }
  });
  const settled = work.catch(() => {});
  locks.set(file, settled);
  settled.then(() => locks.get(file) === settled && locks.delete(file));
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          release?.();
          resolve(timedOut(file));
        }, FILE_TIMEOUT);
      }),
    ]);
  } catch (error) {
    return {
      file,
      ok: false,
      error: "failed",
      message: `${file}: ${error.message ?? error}`,
    };
  } finally {
    clearTimeout(timer);
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
  if (request.url === "/window") return reply(200, windowState());
  if (!route)
    return reply(404, {
      error: `no route ${request.url}; try ${[...Object.keys(ROUTES), "/window"].join(", ")}`,
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
    await Promise.all(files.map((file) => attempt(route, path.resolve(file)))),
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
