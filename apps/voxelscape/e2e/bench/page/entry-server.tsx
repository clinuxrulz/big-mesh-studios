import { renderToString } from "@solidjs/web";
import type { BenchReport } from "../report.ts";
import type { TraceSummary } from "../trace.ts";
import { App } from "./App.tsx";

/** The report's markup, as the generator writes it into the document. */
export function render(report: BenchReport, traces: TraceSummary[]): string {
  return renderToString(() => <App report={report} traces={traces} />);
}
