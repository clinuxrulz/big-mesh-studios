// Writes a benchmark report out as a page to look at. With no arguments it
// takes the most recent report in `e2e/.out`.
//
//   pnpm bench:html
//   pnpm bench:html e2e/.out/bench-abc1234-…json
//
// The page is Solid rendered to a file, the way the homepage is: the numbers
// have already happened, so nothing on the page reacts and nothing is sent to
// the browser to run. What a reader would otherwise hover for is carried by
// the marks themselves — every band and bar holds a title the browser shows —
// and by the table of figures under each scenario.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { outDir, outPath } from "../out-dir.ts";
import type { BenchReport } from "./report.ts";
import type { TraceSummary } from "./trace.ts";

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "page");
const BUILT_DIR = join(PAGE_DIR, ".ssr");
const BUILT = join(BUILT_DIR, "entry-server.js");

/** The most recently changed file anywhere under a directory. */
const newestChange = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".ssr") {
      continue;
    }
    const path = join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestChange(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
};

/**
 * Compiles the page for the server when its sources have moved on since the
 * last time. The page is written in Solid, which means its markup is compiled
 * rather than interpreted, so it cannot be loaded straight from source the way
 * the rest of the benchmark is.
 */
const buildPage = (): void => {
  if (existsSync(BUILT) && statSync(BUILT).mtimeMs > newestChange(PAGE_DIR)) {
    return;
  }
  execFileSync(
    "pnpm",
    [
      "exec",
      "vite",
      "build",
      "--config",
      join(PAGE_DIR, "vite.config.ts"),
      "--ssr",
      join(PAGE_DIR, "entry-server.tsx"),
      "--outDir",
      BUILT_DIR,
      "--logLevel",
      "warn",
    ],
    { cwd: join(PAGE_DIR, "..", "..", ".."), stdio: "inherit" },
  );
};

/**
 * Writes `report` out as a page beside it.
 *
 * @param report The run to draw.
 * @param traces What each traced scenario found, if the run was traced.
 * @param file Where to write the page.
 * @returns The path written.
 */
export const writeHtmlReport = async (
  report: BenchReport,
  traces: TraceSummary[],
  file: string,
): Promise<string> => {
  buildPage();
  const { render } = (await import(pathToFileURL(BUILT).href)) as {
    render: (report: BenchReport, traces: TraceSummary[]) => string;
  };
  const styles = readFileSync(join(PAGE_DIR, "styles.css"), "utf8");
  const document = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>voxelscape, measured — ${report.context.commit}</title>
    <style>
${styles.trimEnd()}
    </style>
  </head>
  <body>
${render(report, traces)}
  </body>
</html>
`;
  await writeFile(file, document);
  return file;
};

/**
 * The reports in the output directory, oldest first. A report's name carries
 * the commit before the moment it was written, so the names sort by commit
 * rather than by age; the file's own timestamp is what puts them in order.
 */
export const reportsByAge = (): string[] =>
  readdirSync(outDir())
    .filter((name) => name.startsWith("bench-") && name.endsWith(".json"))
    .map((name) => join(outDir(), name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

const main = async (): Promise<void> => {
  const reports = reportsByAge();
  const path = process.argv[2] ?? reports[reports.length - 1];
  if (path === undefined) {
    throw new Error(`no report to draw in ${outDir()}`);
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as BenchReport;
  const written = await writeHtmlReport(
    report,
    [],
    outPath(
      `${
        path
          .split("/")
          .pop()
          ?.replace(/\.json$/, "") ?? "bench"
      }.html`,
    ),
  );
  console.log(`drew ${path} as ${written}`);
};

// Only when run as a command; the benchmark imports `writeHtmlReport` instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
