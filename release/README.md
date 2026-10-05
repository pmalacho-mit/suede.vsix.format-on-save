# Format on Save, from the command line

Have the running editor (VS Code or VSCodium) format a file the way it is
configured to — by saving it, so format-on-save runs with whichever formatter
each language is set to use — and ask whether a file is open in the editor or
has unsaved changes there.

It exists for tools that edit files on disk, coding agents above all. A file
written from outside the editor never goes through a save in it, so
`editor.formatOnSave` never runs, and running a formatter yourself means
re-deriving what the editor would do: which formatter, which version, which
settings, which plugins. Here the editor does it, so the result is exactly what
pressing save would have given, and stays so when its configuration changes.

## Install

```sh
npm run install-extension      # from this folder: packages it and installs it into codium or code
```

It activates once the window has started and needs no reload after installing.
It is plain JavaScript with no dependencies, so there is nothing to build;
packaging fetches `@vscode/vsce` with `npx`. Run it again after a change.

## Use

```sh
node cli.mjs status <file or glob…>    # is each open in a tab, does it have unsaved changes, does it format on save
node cli.mjs format <file or glob…>    # save each through the editor, so format-on-save runs as configured
node cli.mjs window [folder]           # is the editor's window in front
```

Paths may be relative to where you run it. Needs Node 22 or later (22.14 for globs).

### Only what changed

**Format the files you changed, and nothing else.** Every file goes through a
full save in the editor, so a run costs time per file whether or not the file
needed formatting: with the editor in front, roughly 60 ms for a TypeScript
file and 110 ms for a Svelte one; with it in a browser tab in the background,
a second or more each, and minutes once the tab has been hidden a while (see
Limits). A whole tree of a few hundred files is minutes of saves to change a
handful. Name the files you changed instead.

With git, the files that differ from the last commit — staged or not — and
the new ones not yet added, which is what `git status` lists, less those
deleted:

```sh
{ git diff --name-only --relative --diff-filter=d HEAD; git ls-files --others --exclude-standard; } \
  | grep -E '\.(ts|js|mjs|cjs|mts|svelte)$' \
  | xargs -r -d '\n' node <path>/cli.mjs format
```

Both lists are of the current folder down, relative to it, so run it from the
repository's root to cover all of it, or from a subfolder for just that. The
`grep` keeps the languages that format on save; widen it to taste. With
nothing changed, `xargs -r` runs nothing.

### A batch at once

Should you need one — the first time a repository is formatted, say:

```sh
node cli.mjs format 'src/**/*.{ts,svelte}' --exclude 'src/generated/**'
```

Quote a glob so the shell leaves it alone; the command line expands it, from
where you run it. It matches files only, leaves out dotfiles unless the pattern
names them, and always leaves out `node_modules`. `--exclude <glob>` leaves out
more, and can be given more than once. An argument that is an existing file is
taken as it is, so `app/[id]/page.tsx` means that file. A file that more than
one argument names is handled once.

A file with unsaved changes in the editor is skipped, as is one that does not
format on save: it is left as it was, the rest of the batch goes on, and its
result says `"skipped": true`. `format` also sums the batch up on stderr, naming
whatever was skipped or failed and why:

```text
formatted 41 (6 changed)
skipped (unsaved-changes): src/lib/Counter.svelte
failed (cannot-open): src/assets/logo.ts
```

### Output

The output is a JSON array, one result per file, in the order given:

```json
[
  {
    "file": "/workspace/src/lib/Counter.svelte",
    "open": true,
    "dirty": false,
    "formatOnSave": true,
    "formatOnSaveMode": "file",
    "ok": true,
    "changed": true
  }
]
```

| Field              | What it is                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`             | the absolute path                                                                                                                              |
| `open`             | whether the file is open in an editor tab                                                                                                      |
| `dirty`            | whether the editor holds unsaved changes to it                                                                                                 |
| `formatOnSave`     | whether `editor.formatOnSave` is on for it, language-specific settings first                                                                   |
| `formatOnSaveMode` | `editor.formatOnSaveMode`: `file`, or `modifications` / `modificationsIfAvailable`, which format only the lines source control sees as changed |
| `ok`               | `format` only: whether it was saved                                                                                                            |
| `changed`          | `format` only: whether formatting changed its text                                                                                             |
| `skipped`          | `format` only: left alone on purpose (`unsaved-changes`, `format-on-save-off`)                                                                 |
| `error`            | why a file could not be handled, below                                                                                                         |
| `message`          | the same, in a sentence to show the user                                                                                                       |
| `pattern`          | in place of `file`, for a glob that matched nothing                                                                                            |

| `error`              | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `unsaved-changes`    | skipped: the file has unsaved changes in the editor; saving would save them too. Ask the user first.  |
| `format-on-save-off` | skipped: `editor.formatOnSave` is off for this file, so a save would not format it                    |
| `stale`              | the editor had not picked up the latest change to the file on disk within 3 seconds; try again        |
| `no-formatter`       | no formatter for the file's language answered within 10 seconds, so saving did not format it          |
| `timeout`            | the editor did not finish with the file within 30 seconds (see Limits); the save may still land later |
| `not-found`          | there is no such file                                                                                 |
| `no-match`           | a glob matched no file                                                                                |
| `cannot-open`        | the editor cannot open it as text: a directory, a binary file, one too large                          |
| `read-only`          | the editor would not edit it                                                                          |
| `save-failed`        | the editor did not save it                                                                            |
| `failed`             | anything else went wrong with it; `message` says what                                                 |
| `no-editor`          | no editor window has a folder holding the file open (or the one that did has gone)                    |

The exit code sums it up: `0` when every file was fine, `3` when some were
only skipped, `1` when one failed, `2` when no editor could be reached for one,
and `64` for a usage error.

### Is the editor in front?

```sh
node cli.mjs window        # → { "focused": true, "active": true }
```

The window that has the folder open (the current one by default) answers
whether it is focused, and whether the user has interacted with it recently
(`active`, VS Code 1.89 and later; `null` before). It exits `0` when focused,
`1` when not, and `2` when no editor could be reached. An editor in a browser
tab that is not in front is throttled, so formatting there is slow (see
Limits): check first, and leave the formatting to the user when it is not.

## For agents

Check before editing a file, and format after:

1. `status` the files you are about to edit. If one is `dirty`, the user has
   unsaved work in it: editing the file on disk would leave the editor holding
   a copy that disagrees with it. Stop and tell the user.
2. Edit.
3. `window`: if the editor is not focused, formatting would crawl. Tell the
   user which files to format, and leave it to them.
4. `format` the files you edited, by name, and only those: never a glob over
   a tree to catch them (see Only what changed). On
   `unsaved-changes`, the user started editing in the meantime; tell them
   rather than retry. On `stale`, retry once. On `no-editor`, the editor is
   not running here: leave the file as it is.

As a Claude Code hook, in `.claude/settings.json`, formatting every file
Claude edits:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path // empty' | xargs -r -d '\\n' node \"$CLAUDE_PROJECT_DIR/suede.vsix.format-on-save/cli.mjs\" format >/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

## How it works

Each window listens on a Unix socket for each of its workspace folders
(including ones added later), at
`$TMPDIR/vscode-format-on-save-<uid>/<first 16 hex of sha1(folder path)>.sock`.
Only the user can use that directory: the extension will not listen in it, nor
the command line connect, if someone else made it or can write to it. The command line walks up from a file's directory,
hashing each one, until it finds a socket, so with several windows open it
reaches the one whose folder holds the file. Anything that can speak HTTP over
a Unix socket can do the same:

```sh
curl -s --unix-socket "$SOCKET" -d '{"files":["/workspace/src/a.ts"]}' http://editor/format
```

Formatting a file:

1. Refuse it if it has unsaved changes, or if it does not format on save.
2. Load it — in memory only; a file that was not open stays without a tab.
3. Wait, up to 3 seconds, until the editor's copy matches the file on disk. The
   editor reloads a changed file on its own schedule, and saving before it has
   would write its older copy back over the change.
4. Skip it if it gained unsaved changes while the editor caught up.
5. Give it a change that leaves its text as it was, since the editor only
   saves a document with changes: a character replaced with itself, or, where
   the editor does not count that as a change, two edits that cancel out.
6. Before the first file of a language, make sure its formatter is there. A
   formatter's extension may only start once a document of its language opens
   (Svelte's does), and a save before it has registered would be saved
   unformatted. So: start `editor.defaultFormatter`'s extension, and wait until
   a formatter has edits for the file. The editor gives none both when no
   formatter is registered and when the file is already formatted, so for an
   already formatted file it asks with blank lines added at the end, which any
   formatter takes out, and takes them out again after.
7. Save it. The editor runs its save participants, format-on-save among them,
   exactly as for a save from the keyboard. A file no formatter answered for
   is saved too, its text as it was, so that it is not left with changes to
   save.

Up to 8 files are handled at once, across requests too: their saves overlap in
the editor, which is where the time goes. One file is never handled twice at
once. Each has 30 seconds; one that runs out gives up its place to the rest,
but stays locked until its save lands.

## Limits

- Linux and macOS only: Windows has no Unix sockets for Node to listen on.
- The editor must be running, with the file's folder open in a window.
- The save happens in the editor's window. An editor in a browser tab (a
  VS Code or VSCodium server) is throttled while the tab is in the background:
  a save that takes a fraction of a second in front takes about a second
  behind, and minutes once the tab has been hidden for a while. Past 30
  seconds a file fails with `timeout`, its message saying when the window is
  not focused; keep the tab in front, or the editor in a window of its own, for
  a batch. A save that timed out may still land when the tab wakes up.
- The editor and the command line must agree on `$TMPDIR` (`/tmp` if unset).
  A sandbox that gives the command line a different one hides the editor from
  it.
- Paths are compared as given: a file reached through a symbolic link to the
  folder, rather than the folder's own path, finds no editor.
- A file in an encoding other than UTF-8 never matches the editor's copy, so
  it is always `stale`.
- For a file open in a tab, the save lands in its undo history: undo steps back
  through the formatting, then through the edits that left the text as it was.
- Two windows with the same folder open: the one that started last answers.
  Once it closes, neither does until the other is reloaded.
- A formatter that fails leaves the file saved unformatted, as a save from the
  keyboard would; `changed` is then `false`.
- Each file goes through a full save in the editor. A file that was not open
  stays loaded in memory for a time, and other extensions see it open: one
  that does something whenever a file of its language opens (runs its tests,
  say) does it for every file in a batch.
- Untrusted workspaces are not supported: it saves files when asked to.
