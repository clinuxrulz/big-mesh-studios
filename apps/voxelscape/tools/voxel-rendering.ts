// Draws the path a voxel takes to the screen, out of the code that walks it.
//
//   pnpm rendering           # redraw docs/voxel-rendering.md
//   pnpm rendering --check   # fail if the drawing is stale or its arithmetic broke
//
// The area map (`pnpm architecture`) says the renderers talk to the world and
// leaves it there. This is the other question: what happens between a cell of a
// terrain function and a pixel. Every number in the drawing is read out of the
// module that decides it — the size of a block, what a vertex carries, what a
// frame is allowed to upload, the stages the probe times — so the drawing cannot
// claim a shape the code has stopped having.
//
// One of those readings is a check rather than a note. `VERTEX_UPLOAD_BYTES` is
// what the upload budget spends against, and the vertex attributes are what the
// mesher actually writes; if somebody adds an attribute and leaves the constant
// alone, every upload estimate is quietly wrong. So the attributes are summed
// and compared, and `--check` fails on the difference.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { areaOfImport, importsOf, readModules } from "./architecture.ts";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(APP_DIR, "src");
const DRAWING = join(APP_DIR, "docs", "voxel-rendering.md");

/**
 * How many bytes one component of a vertex format takes, read out of the
 * format's own name: `float32x3` is three of four, `unorm8x4` four of one. The
 * attributes are no longer all floats, so the width has to come from the
 * format rather than being assumed.
 */
const bytesAComponent = (format: string): number => {
  const bits = Number(format.split("x")[0].replace(/^[a-z]+/, ""));
  return bits / 8;
};

/**
 * The modules the path runs through, in the order it runs, each with what it
 * does in one line. The drawing checks that every one of them exists, so a
 * rename shows up here rather than rotting.
 */
const PATH: Array<{ module: string; does: string }> = [
  {
    module: "world/noise.ts",
    does: "answers the height and the flatness of any world column",
  },
  {
    module: "world/voxel-store.ts",
    does: "holds one block's voxels, border included, and fills them from the terrain",
  },
  {
    module: "world/cave-fill.ts",
    does: "carves the caves out of a filled column",
  },
  {
    module: "world/lava-fill.ts",
    does: "pours the lava that sits in the deep ones",
  },
  {
    module: "world/tree-fill.ts",
    does: "stands the trees on the surface it finds",
  },
  {
    module: "world/light-store.ts",
    does: "holds the two light channels shadowing those voxels",
  },
  {
    module: "world/sky-light.ts",
    does: "drops skylight down every column and spreads it sideways",
  },
  {
    module: "world/block-light.ts",
    does: "spreads the light emitters give off",
  },
  {
    module: "renderers/plane-merge.ts",
    does: "covers one plane of like faces with as few rectangles as it can",
  },
  {
    module: "renderers/superchunk.ts",
    does: "one superchunk's merged geometry: each member's run, and what the card holds of it",
  },
  {
    module: "renderers/mesh.ts",
    does: "sweeps a block for exposed faces and writes the quads they become",
  },
  {
    module: "renderers/vertex-format.ts",
    does: "what a vertex weighs, and which lane of it holds which of the small numbers",
  },
  {
    module: "renderers/growable.ts",
    does: "the typed arrays a mesh is accumulated into, and reused for the next block",
  },
  {
    module: "world/fill-mesh-worker.ts",
    does: "does all of the above for a batch of blocks, off the main thread",
  },
  {
    module: "world/fill-client.ts",
    does: "asks for blocks, lends the arrays they are filled into, and adopts what comes back",
  },
  {
    module: "renderers/mesh-client.ts",
    does: "asks for a mesh on its own, for a block whose voxels an edit changed",
  },
  {
    module: "renderers/atlas.ts",
    does: "the sheet of tiles a face's texture is cut from",
  },
  {
    module: "renderers/triangle-renderer.ts",
    does: "joins blocks into superchunks, uploads them, and draws them",
  },
  {
    module: "renderers/occlusion.ts",
    does: "decides which superchunks the last probe proved hidden",
  },
  {
    module: "render/create-render-loop.ts",
    does: "the frame: advance the world, then draw it",
  },
  {
    module: "render/perf-probe.ts",
    does: "times each stage of that frame and counts what moved",
  },
  {
    module: "render/adaptive.ts",
    does: "lowers the resolution when frames stop fitting",
  },
];

/** A constant the path is governed by, and where it is declared. */
interface Governing {
  name: string;
  file: string;
  /** What it says, as written. */
  value: string;
  /** The line above it, which is the codebase's own explanation. */
  says: string;
}

/** The constants worth printing, by the file that declares them. */
const GOVERNING: Record<string, readonly string[]> = {
  "world/level-data.ts": ["VOXEL_SIZE", "CHUNK_VOXELS"],
  "world/voxel-store.ts": ["VOXEL_PADDING"],
  "world/worker-pool.ts": ["MAX_WORKERS"],
  "world/fill-client.ts": ["MAX_FILLS_PER_WORKER", "MAX_SPARE_SETS"],
  "renderers/triangle-renderer.ts": [
    "SUPERCHUNK_SPAN",
    "MAX_UPLOAD_BYTES_PER_FRAME",
    "MAX_UPLOAD_STALL_FRAMES",
    "GEOMETRY_POOL_FRAMES",
    "DEFAULT_OCCLUSION_INTERVAL",
  ],
  "renderers/superchunk.ts": ["INDEX_UPLOAD_BYTES"],
  "renderers/vertex-format.ts": ["VERTEX_BYTES", "MAX_TILE_INDEX"],
  "renderers/mesh-client.ts": ["MAX_BUILDS_PER_DRAIN"],
};

/** The source of one module under `src`. */
const sourceOf = (module: string): string =>
  readFileSync(join(SRC_DIR, module), "utf8");

/** A parsed module, for the readers below. */
const treeOf = (module: string): ts.SourceFile =>
  ts.createSourceFile(
    module,
    sourceOf(module),
    ts.ScriptTarget.ESNext,
    true,
    module.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/**
 * The value and the sentence above each named constant of a module, read from
 * the declaration rather than from a search: the value as it is written, so
 * `2 * 1024 * 1024` reads as itself rather than as 2097152.
 */
export const constantsOf = (
  module: string,
  wanted: readonly string[],
): Governing[] => {
  const tree = treeOf(module);
  const text = tree.getFullText();
  const found: Governing[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const name = declaration.name.getText(tree);
        if (!wanted.includes(name) || declaration.initializer === undefined) {
          continue;
        }
        // The comment above the declaration is the codebase's own account of
        // what the number is for.
        const comments =
          ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
        const prose = comments
          .map((range) => text.slice(range.pos, range.end))
          .join(" ")
          .replace(/\/\*\*?/g, " ")
          .replace(/\*\//g, " ")
          .replace(/\/\//g, " ")
          .replace(/^\s*\*/gm, " ")
          .replace(/\s+/g, " ")
          .trim();
        // The first sentence of it, which is where this codebase puts what a
        // thing is; the rest is why, and belongs where it is written.
        const stop = prose.indexOf(". ");
        const says = stop === -1 ? prose : prose.slice(0, stop + 1);
        found.push({
          name,
          file: module,
          value: declaration.initializer.getText(tree),
          says,
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return found;
};

/** One attribute of the vertex format: its name, and how many numbers it holds. */
export interface Attribute {
  name: string;
  elements: number;
  /** The vertex format `setGeometryData` binds it as. */
  format: string;
}

/**
 * The attributes a mesh is uploaded with, read from the calls that set them in
 * `setGeometryData` — which is the only place they are named, so this is the
 * vertex format rather than a description of it.
 */
export const vertexAttributes = (): Attribute[] => {
  const module = "renderers/mesh.ts";
  const tree = treeOf(module);
  const attributes: Attribute[] = [];
  const walk = (node: ts.Node): void => {
    // `geometry.setAttribute("name", attrWithRange(array, elements, span,
    // "format", ...))` — the name comes from the outer call and the width from
    // the format the inner one names.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setAttribute" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ts.isCallExpression(node.arguments[1]) &&
      ts.isIdentifier(node.arguments[1].expression) &&
      node.arguments[1].expression.text === "attrWithRange"
    ) {
      const inner = node.arguments[1];
      const elements = inner.arguments[1];
      const format = inner.arguments[3];
      if (
        ts.isNumericLiteral(elements) &&
        format &&
        ts.isStringLiteral(format)
      ) {
        attributes.push({
          name: node.arguments[0].text,
          elements: Number(elements.text),
          format: format.text,
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return attributes;
};

/** The stages of a frame, in the order the probe times them. */
export const framePhases = (): string[] => {
  const tree = treeOf("render/perf-probe.ts");
  const phases: string[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === "Phase" &&
      node.initializer !== undefined
    ) {
      const literal = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          if (ts.isPropertyAssignment(property)) {
            phases.push(property.name.getText(tree));
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return phases;
};

/** One kind of message the world's workers speak, and which module declares it. */
export interface MessageKind {
  kind: string;
  module: string;
}

/**
 * The message kinds the fill and mesh protocols use, read from the `type:
 * "..."` field every request and result declares.
 */
export const messageKinds = (): MessageKind[] => {
  const modules = [
    "world/fill-worker.ts",
    "world/fill-mesh-worker.ts",
    "renderers/mesh.ts",
  ];
  const found = new Map<string, MessageKind>();
  for (const module of modules) {
    const tree = treeOf(module);
    const walk = (node: ts.Node): void => {
      if (
        ts.isPropertySignature(node) &&
        node.name.getText(tree) === "type" &&
        node.type !== undefined &&
        ts.isLiteralTypeNode(node.type) &&
        ts.isStringLiteral(node.type.literal)
      ) {
        const kind = node.type.literal.text;
        if (!found.has(kind)) {
          found.set(kind, { kind, module });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  return [...found.values()].sort((one, two) =>
    one.kind.localeCompare(two.kind),
  );
};

/** What one module of the path imports from another module of it. */
export interface PathEdge {
  from: string;
  to: string;
}

/**
 * The edges between the path's own modules, from their imports. Anything the
 * path reaches outside itself is left out: this is the shape of the pipeline,
 * not of the application around it.
 */
export const pathEdges = (): PathEdge[] => {
  const inPath = new Set(PATH.map((step) => step.module));
  const edges: PathEdge[] = [];
  for (const step of PATH) {
    const seen = new Set<string>();
    for (const specifier of importsOf(sourceOf(step.module), step.module)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      // A specifier carries no extension; the path's modules do.
      const area = areaOfImport(step.module, specifier);
      if (area === null) {
        continue;
      }
      const target = specifier.split("/").slice(-1)[0];
      const match = [...inPath].find(
        (module) => module === `${area}/${target}.ts`,
      );
      if (match !== undefined && match !== step.module && !seen.has(match)) {
        seen.add(match);
        edges.push({ from: step.module, to: match });
      }
    }
  }
  return edges;
};

/** A short name for a module, for a diagram node. */
const nodeOf = (module: string): string =>
  module.replace(/\.tsx?$/, "").replace(/[^A-Za-z0-9]/g, "_");

/** The commit the drawing was made from. */
const commit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: APP_DIR,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
};

/** Every number the drawing states, with where it came from. */
const governing = (): Governing[] =>
  Object.entries(GOVERNING).flatMap(([module, names]) =>
    constantsOf(module, names),
  );

export const drawingOf = (): string => {
  const attributes = vertexAttributes();
  const declared = governing();
  const constant = (name: string): string =>
    declared.find((entry) => entry.name === name)?.value ?? "?";
  const vertexBytes = attributes.reduce(
    (sum, attribute) =>
      sum + attribute.elements * bytesAComponent(attribute.format),
    0,
  );
  const lines: string[] = [
    "# How a voxel becomes a pixel",
    "",
    `Read out of the modules that do it at ${commit()} by \`pnpm rendering\`.`,
    "Every number below is the one the code declares, not a note about it.",
    "",
    "## The path",
    "",
    "```mermaid",
    "graph TD",
  ];
  for (const step of PATH) {
    lines.push(`  ${nodeOf(step.module)}["${step.module}<br/>${step.does}"]`);
  }
  for (const edge of pathEdges()) {
    lines.push(`  ${nodeOf(edge.from)} --> ${nodeOf(edge.to)}`);
  }
  lines.push("```", "");
  lines.push(
    "An arrow is an import, so it points from a module to one it reads —",
    "which is the reverse of the way the data flows.",
    "",
  );

  lines.push("## What a block is", "");
  lines.push("| | |", "| --- | --- |");
  const voxels = Number(constant("CHUNK_VOXELS"));
  const size = Number(constant("VOXEL_SIZE"));
  const padding = Number(constant("VOXEL_PADDING"));
  const span = Number(constant("SUPERCHUNK_SPAN"));
  const padded = (voxels + 2 * padding) ** 3;
  lines.push(`| voxels a block | ${voxels}³ |`);
  lines.push(`| world units a voxel | ${size} |`);
  lines.push(`| world units a block | ${voxels * size}³ |`);
  lines.push(
    `| border voxels a face | ${padding}, so a block's arrays are ${voxels + 2 * padding}³ = ${padded.toLocaleString()} long |`,
  );
  lines.push(
    `| bytes a block holds | ${(padded * 2).toLocaleString()}: a byte of voxel and a byte holding both light channels |`,
  );
  lines.push(
    `| blocks a superchunk | ${span}³, which is ${voxels * size * span} world units a side |`,
  );
  lines.push("");

  lines.push("## What a vertex carries", "");
  lines.push(
    "| attribute | format | numbers | bytes |",
    "| --- | --- | --- | --- |",
  );
  for (const attribute of attributes) {
    lines.push(
      `| \`${attribute.name}\` | \`${attribute.format}\` | ${attribute.elements} | ` +
        `${attribute.elements * bytesAComponent(attribute.format)} |`,
    );
  }
  lines.push(`| **total** | | **${vertexBytes}** |`);
  lines.push("");
  lines.push(
    `\`VERTEX_BYTES\` says ${constant("VERTEX_BYTES")}, which is what the frame's upload budget`,
    `spends against. An index costs ${constant("INDEX_UPLOAD_BYTES")} bytes on top, six to a quad.`,
    "",
  );

  lines.push("## The frame, in the order it is timed", "");
  lines.push(
    framePhases()
      .map((phase, at) => `${at + 1}. \`${phase}\``)
      .join("\n"),
  );
  lines.push("");
  lines.push(
    "`advance` holds every stage above it except the last two: what the probe",
    "reports as advance is the world's whole update, and `occlusion` and `draw`",
    "are the drawing that follows it.",
    "",
  );

  lines.push("## What the workers say to each other", "");
  lines.push("| message | declared in |", "| --- | --- |");
  for (const message of messageKinds()) {
    lines.push(`| \`${message.kind}\` | \`${message.module}\` |`);
  }
  lines.push("");

  lines.push("## The numbers that govern it", "");
  lines.push("| constant | value | where | what it is for |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of declared) {
    lines.push(
      `| \`${entry.name}\` | \`${entry.value}\` | \`${entry.file}\` | ${entry.says} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

/** What `--check` refuses to let drift. */
export const problemsWith = (drawing: string, held: string): string[] => {
  const problems: string[] = [];
  const shapeOf = (text: string): string =>
    text.replace(/^Read out of the modules.*$/m, "");
  if (shapeOf(held) !== shapeOf(drawing)) {
    problems.push(
      "docs/voxel-rendering.md is not what the modules say any more; run `pnpm rendering`",
    );
  }
  const attributes = vertexAttributes();
  const summed = attributes.reduce(
    (sum, attribute) =>
      sum + attribute.elements * bytesAComponent(attribute.format),
    0,
  );
  const declared = Number(
    constantsOf("renderers/vertex-format.ts", ["VERTEX_BYTES"])[0]?.value ??
      "0",
  );
  if (summed !== declared) {
    problems.push(
      `the vertex attributes come to ${summed} bytes and VERTEX_BYTES says ${declared}: ` +
        `every upload estimate and the frame's byte budget are off by the difference`,
    );
  }
  const known = new Set(readModules().map((module) => module.path));
  for (const step of PATH) {
    if (!known.has(step.module)) {
      problems.push(
        `${step.module} is in the path this draws but not in the sources; rename it in tools/voxel-rendering.ts`,
      );
    }
  }
  return problems;
};

/**
 * The drawing as Prettier would write it, which is how it is held on disk. The
 * repository formats everything it holds, so a drawing written any other way is
 * reformatted the next time the formatter runs and stops matching what this
 * draws — leaving `--check` failing until somebody redraws it, which puts it
 * straight back. Formatting here is what keeps the two agreeing.
 */
const formatted = async (drawing: string): Promise<string> =>
  format(drawing, { ...(await resolveConfig(DRAWING)), filepath: DRAWING });

const main = async (): Promise<void> => {
  const checking = process.argv.includes("--check");
  const drawing = await formatted(drawingOf());
  if (!checking) {
    writeFileSync(DRAWING, drawing);
    console.log(
      `drew ${PATH.length} modules of the path into ${relative(APP_DIR, DRAWING)}`,
    );
  }
  let held = "";
  try {
    held = readFileSync(DRAWING, "utf8");
  } catch {
    held = "";
  }
  const problems = problemsWith(drawing, held);
  // A fresh drawing is never stale, so only a check reads that one.
  const worth = checking
    ? problems
    : problems.filter((line) => !line.includes("run `pnpm rendering`"));
  if (worth.length > 0) {
    console.error(worth.map((line) => `  ${line}`).join("\n"));
    process.exit(1);
  }
  if (checking) {
    console.log(
      "the drawing matches the modules, and the vertex format adds up to what the budget spends",
    );
  }
};

if (
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("voxel-rendering.ts")
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
