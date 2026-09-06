# The place script editor, read from a console command

A place is a world a creator makes in the editor and everyone else joins; the
world already loads a place's script and runs it (ADR 0026), and publishes
places from zips. What a creator has no way to do yet is author that zip — the
script is written by hand and the zip assembled elsewhere. This decision adds
an in-game editor for place projects: a CodeMirror panel that `/place:editor`
opens, that keeps its drafts itself, and that runs and publishes through the
seams the world already has.

## The draft is the editor's own state; the world's doors stay the same

A `PlaceProject` is the manifest at the top of a place zip plus every script
file it names. The editor owns drafts of that project — opened from the last
session, created fresh, or read back from an already-published place — and the
draft is the only thing it owns. Running a script goes to the same script host
`/script:demo` uses, publishing goes to the same atproto publisher
`/place:publish` uses, and a publish writes the zip through the same
`writePlaceZip` the file picker round-trips. Nothing about how a place is made
runs inside the editor, so the two ways in — the panel and the console — cannot
drift apart, and the boundary the interpreter and the publisher already enforce
stays the whole of what a created place has to survive.

## IndexedDB holds the draft between sessions

The draft is written to IndexedDB, debounced, so closing the panel (even by the
console command that would otherwise race a pending save) never loses the last
change. A save as the panel unmounts covers that, and one persistence handle
for the app means a debounced save started before a close finishes anyway. The
reload path is the one place persistence shows; a place opened from a publish
is cached in the module, so the panel also knows it without asking twice.

## The editor is loaded only when it is opened

The world that never opens the panel should not download CodeMirror, the
language services, or the worker they talk to. `/place:editor` resolves the
panel as a lazy import, so the bundle is requested on first open, not at boot.

## Editing in the DOM keeps the world's input rules

CodeMirror is a contenteditable field, and the console and the player already
skip their global key handling when an editable target is focused, so typing in
the editor neither moves the player nor feeds the console. Escape closes the
panel except when focus is inside it.

## Considered options

- **A full external editor page.** Rejected: the loop that matters is
  write-script-then-see-it-in-the-world, and a separate page breaks it — a page
  reload would rebuild the world just to test a change. The panel sits over the
  living world, and Run hands the source to the host the sample script already
  uses.
- **Editing the place zip's manifest by hand.** Rejected: the manifest is not
  a document; it is derived from the append-only facts the place's rules fold
  over, and its editing UI is the fields for the facts it holds.
- **Storing the draft in the place record.** Rejected: a draft is not a fact
  about the place — it is the unpublished working copy — and writing it to
  atproto would publish intent that has not settled. IndexedDB keeps it on the
  author's device until a publish makes it real.

## Consequences

- The editor imports the host's script console lazily, so an editing session
  loads the interpreter once, not per open.
- A place opened for editing and republished under the same name updates the
  already-published place; the address it had before still joins its world,
  because the world is the seed and the spawn, not the zip.
- CodeMirror fields are measured per tab, so switching files costs a
  re-measure of the newly visible pane rather than a rebuild.
