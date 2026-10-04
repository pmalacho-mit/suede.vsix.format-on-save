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
node cli.mjs status <file…>    # is each open in a tab, does it have unsaved changes, does it format on save
node cli.mjs format <file…>    # save each through the editor, so format-on-save runs as configured
```

Paths may be relative to where you run it. The output is a JSON array, one
result per file, in the order given:

```json
[
  {
    "file": "/workspace/src/lib/Counter.svelte",
    "open": true,
    "dirty": false,
    "formatOnSave": true,
    "ok": true,
    "changed": true
  }
]
```

| Field          | What it is                                                                   |
| -------------- | ---------------------------------------------------------------------------- |
| `file`         | the absolute path                                                            |
| `open`         | whether the file is open in an editor tab                                    |
| `dirty`        | whether the editor holds unsaved changes to it                               |
| `formatOnSave` | whether `editor.formatOnSave` is on for it, language-specific settings first |
| `ok`           | `format` only: whether it was saved                                          |
| `changed`      | `format` only: whether formatting changed its text                           |
| `error`        | why a file could not be handled, below                                       |
| `message`      | the same, in a sentence to show the user                                     |

| `error`              | Meaning                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `unsaved-changes`    | the file has unsaved changes in the editor; saving would save them too. Nothing was done: ask the user first. |
| `stale`              | the editor had not picked up the latest change to the file on disk within 3 seconds; try again                |
| `format-on-save-off` | `editor.formatOnSave` is off for this file, so a save would not format it                                     |
| `not-found`          | there is no such file                                                                                         |
| `save-failed`        | the editor did not save it                                                                                    |
| `no-editor`          | no editor window has a folder holding the file open (or the one that did has gone)                            |

The exit code sums it up: `0` when every file was fine, `1` when one was not,
`2` when no editor could be reached for one, and `64` for a usage error.

## For agents

Check before editing a file, and format after:

1. `status` the files you are about to edit. If one is `dirty`, the user has
   unsaved work in it: editing the file on disk would leave the editor holding
   a copy that disagrees with it. Stop and tell the user.
2. Edit.
3. `format` what you edited. On `unsaved-changes`, the user started editing in
   the meantime; tell them rather than retry. On `stale`, retry once. On
   `no-editor`, the editor is not running here: leave the file as it is.

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
            "command": "jq -r '.tool_input.file_path // empty' | xargs -r -d '\\n' node \"$CLAUDE_PROJECT_DIR/.devcontainer/format-on-save/cli.mjs\" format >/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

## How it works

Each window listens on a Unix socket for each of its workspace folders, at
`$TMPDIR/vscode-format-on-save/<first 16 hex of sha1(folder path)>.sock`,
readable only by its owner. The command line walks up from a file's directory,
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
4. Make two edits that cancel out. The editor only saves a document with
   changes, so this gives it some without changing the text.
5. Save it. The editor runs its save participants, format-on-save among them,
   exactly as for a save from the keyboard.

## Limits

- The editor must be running, with the file's folder open in a window.
- For a file open in a tab, the save lands in its undo history: undo steps back
  through the formatting, then through the two edits that cancelled out.
- Two windows with the same folder open: the one that started last answers.
- A formatter that fails leaves the file saved unformatted, as a save from the
  keyboard would; `changed` is then `false`.
- Files are handled one at a time, each through a full save.
- Untrusted workspaces are not supported: it saves files when asked to.
