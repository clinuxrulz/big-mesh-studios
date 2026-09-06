// The place script compiler and bundler: TypeScript is compiled to JavaScript
// and the project's script files are bundled into one global-scope file, the
// only form the sandbox interpreter accepts (ADR 0027). Every compile round is
// deterministic — pinned compiler options, module ids in sorted-file order, and
// a specifier table resolved once — so two peers that run the same files and
// the same entry produce the same bundle and converge (ADR 0026). The bundle's
// entry module must export `bmsTick`; the bundle installs it as the global the
// sandbox steps. Nothing here touches the interpreter: it turns a project into
// the string a `ScriptSandbox.load` can evaluate.
import type * as TS from "typescript";
import { loadTypeScript } from "@big-mesh-studios/code-mirror/typescript-cdn";

/** A place script that could not be compiled or bundled, in words a creator can act on. */
export class PlaceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceBundleError";
  }
}

/** The TypeScript compiler, loaded only when a script is first bundled. */
const typescript = (): Promise<typeof TS> => loadTypeScript();

/** The compiler options a bundle is pinned to, so output never drifts between runs. */
const compilerOptions = (ts: typeof TS): TS.CompilerOptions => ({
  target: ts.ScriptTarget.ES2019,
  module: ts.ModuleKind.CommonJS,
  // The default-`import` interop the editor's language service also assumes,
  // so the same source reads the same in the panel and at load.
  esModuleInterop: true,
  // Each file is compiled on its own; a type that the compiler would otherwise
  // decide is checked by never producing it.
  isolatedModules: true,
  skipLibCheck: true,
});

/**
 * Compiles one script file to CommonJS. The `.js`/`.ts` split does not change
 * the compiled form — both go through the same compiler with the same options —
 * so a project written in either language bundles identically.
 */
const transpileFile = async (
  ts: typeof TS,
  path: string,
  source: string,
): Promise<string> => {
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: compilerOptions(ts),
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new PlaceBundleError(
      errors
        .map((diagnostic) => describeDiagnostic(ts, path, source, diagnostic))
        .join("\n"),
    );
  }
  return result.outputText;
};

/** One diagnostic as `path:line:col — TS###: message`, pointing at the source a creator wrote. */
const describeDiagnostic = (
  ts: typeof TS,
  path: string,
  source: string,
  diagnostic: TS.Diagnostic,
): string => {
  const position =
    diagnostic.start === undefined
      ? { line: 0, character: 0 }
      : ts.getLineAndCharacterOfPosition(
          ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false),
          diagnostic.start,
        );
  const code = diagnostic.code;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  return `${path}:${position.line + 1}:${position.character + 1} — TS${code}: ${message}`;
};

/** Every module specifier `path` statically imports, in the order it writes them. */
const specifiersOf = (
  ts: typeof TS,
  path: string,
  source: string,
): string[] => {
  const specifiers: string[] = [];
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly
    ) {
      specifiers.push((statement.moduleSpecifier as TS.StringLiteral).text);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (statement.moduleSpecifier !== undefined) {
        specifiers.push((statement.moduleSpecifier as TS.StringLiteral).text);
      }
    }
  }
  return specifiers;
};

/**
 * The project file `specifier` names, or null when it names none. Imports may
 * only reach this place's own script files: a bare name, a `./`, or an
 * extensionless or `.js`-ending name all resolve against the flat set of
 * project files, in a fixed order so a bundle never depends on map iteration.
 */
const resolveSpecifier = (
  files: Set<string>,
  specifier: string,
): string | null => {
  if (
    specifier.includes("://") ||
    specifier.startsWith("/") ||
    specifier.includes("..")
  ) {
    return null;
  }
  const base = specifier.replace(/^\.\//, "");
  // A `.js` suffix also names the sibling `.ts` file, the way the NodeNext
  // resolvers authors likely saw this import behave.
  const asTypeScript = base.endsWith(".js")
    ? `${base.slice(0, -3)}.ts`
    : `${base}.ts`;
  for (const candidate of [
    base,
    asTypeScript,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]) {
    if (files.has(candidate)) {
      return candidate;
    }
  }
  return null;
};

/** One module in the bundle: its compiled code, its name, and how its specifiers resolve. */
interface BundledModule {
  path: string;
  code: string;
  requires: Record<string, number>;
}

/**
 * Compiles and bundles a place project into one global-scope script. Each file
 * becomes a CommonJS module evaluated through `require`, with ids assigned in
 * sorted-file order so the output is byte-for-byte reproducible. The bundle
 * runs the entry module and installs the `bmsTick` its exports carry as the
 * global the sandbox steps; an entry that exports none fails at load.
 */
export const bundlePlaceProject = async (
  files: Record<string, string>,
  entry: string,
): Promise<string> => {
  const ts = await typescript();
  if (files[entry] === undefined) {
    throw new PlaceBundleError(
      `the entry script "${entry}" is not a file of this project`,
    );
  }
  const paths = Object.keys(files).sort();
  const ids = new Map(paths.map((path, index) => [path, index]));

  const modules: BundledModule[] = [];
  for (const path of paths) {
    const source = files[path];
    const code = await transpileFile(ts, path, source);
    const requires: Record<string, number> = {};
    for (const specifier of specifiersOf(ts, path, source)) {
      const target = resolveSpecifier(new Set(paths), specifier);
      if (target === null) {
        throw new PlaceBundleError(
          `${path} imports "${specifier}" — imports may only come from this place's own script files`,
        );
      }
      requires[specifier] = ids.get(target)!;
    }
    modules.push({ path, code, requires });
  }

  const entryId = ids.get(entry)!;
  return outputFor(modules, entry, entryId);
};

/** Renders the module table, the `require` shim, and the entry handoff as one script. */
const outputFor = (
  modules: BundledModule[],
  entry: string,
  entryId: number,
): string => {
  const table = modules.map(({ path, code, requires }) => ({
    path,
    code,
    requires,
  }));
  return `var __modules = ${JSON.stringify(table)};
var __cache = [];
function __require(id) {
  var cached = __cache[id];
  if (cached !== undefined) {
    return cached.exports;
  }
  var slot = __modules[id];
  var module = { exports: {} };
  __cache[id] = module;
  new Function("module", "exports", "require", slot.code)(module, module.exports, function (specifier) {
    var target = slot.requires[specifier];
    if (target === undefined) {
      throw new Error("cannot resolve import \\"" + specifier + "\\" from \\"" + slot.path + "\\"");
    }
    return __require(target);
  });
  return module.exports;
}
(function () {
  var entry = __require(${entryId});
  globalThis.bmsTick = typeof entry.bmsTick === "function" ? entry.bmsTick : undefined;
  if (typeof globalThis.bmsTick !== "function") {
    throw new Error('the entry script "${entry}" must export a bmsTick function');
  }
})();
`;
};
