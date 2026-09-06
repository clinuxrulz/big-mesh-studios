# Place scripts are TypeScript modules, compiled and bundled before loading

A place creator writes one or more script files, and the interpreter (ADR 0027)
runs a single global-scope file. This decision picks the language the files are
written in and the compiler that turns them into that file, so that authoring
and running agree with each other and with the determinism contract (ADR 0026,
ADR 0027).

## TypeScript, compiled with the same TypeScript the editor diagnoses with

Place scripts are TypeScript modules. The panel's language server worker already
runs `typescript` for diagnostics, so authoring diagnostics and runtime output
come from the same compiler at the same version, and script authors get types
(`declare const engine`, a typed `bmsTick`) without the editor maintaining a
compiler of its own.

Each file is transpiled with `ts.transpileModule` — per-file transpile only, no
type-check — under pinned options: `target: ES2019`, `module: CommonJS`,
`esModuleInterop: true`, `isolatedModules: true`, `skipLibCheck: true`. CommonJS
output keeps working inside the interpreter without an ES module loader.

No legacy global-script path survives. The interpreter runs only bundles, and a
bundle is built only from modules; an old draft whose script is global-style
code refuses to load with a "must export bmsTick" message. Nothing in the
product loads such scripts today, so the refusal costs nothing.

## A single-file bundle keeps the interpreter's source boundary

The interpreter loads one global-scope file. Rather than teach it module
loading, the host bundles the project's files into that one file before the
interpreter sees it:

- The entry point is the first file named in the manifest's `scripts`, so
  execution starts at the script the author listed first, whatever tab the
  editor has open.
- Every module is compiled to a function body in a `var __modules` table. A
  `__require` shim runs a body, caches its `exports`, and resolves the compiled
  `require` calls through a specifier table embedded in the bundle.
- The entry's module runs last and its `bmsTick` export becomes
  `globalThis.bmsTick`, the global the interpreter's stepping loop calls.

Two peers build byte-identical bundles: module order and ids come from the
files sorted by path, options are pinned as above, and the specifier table is
serialized from the resolved targets. Resolving an import never reaches the
network or the page — imports may only name project files — so a bundle built
from the same files is always the same text.

## Considered options

- **Compile with Babel or SWC.** Rejected: a second compiler means authoring
  and runtime can disagree about a construct, and the editor's worker already
  has TypeScript loaded.
- **Type-check at load.** Rejected: the interpreter runs on every peer, and a
  type-check passing here but failing there would make load success a machine
  property, not a source property. `transpileModule` skips checking by design;
  the editor's own diagnostics are all the checking a load gets.
- **Load each script file separately with a runtime module loader.** Rejected:
  a loader is bespoke interpreter surface (ADR 0027's source boundary) that two
  peers would have to agree on byte for byte. Bundling moves all that work into
  the trusted host, deterministically, before the guest runs.

## Consequences

- `typescript` is a runtime dependency of the world app, since bundling happens
  on the trusted side at load.
- The interpreter's global-scope ES2020 code path is unchanged; the bundle is
  valid global code and steps through the same `bmsTick` call.
- An import specifier like `./map.js` also resolves to the sibling `map.ts`, so
  authors can type the extension they know; bare, absolute, parent, and
  protocol specifiers are rejected with a load error naming file and specifier.
- Keep an eye on bundle size and load time as authoritative compilation runs on
  every load; editor and world stay honest because they compile in one place.
