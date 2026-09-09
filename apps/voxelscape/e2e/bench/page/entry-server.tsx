import { renderToString } from "@solidjs/web";
import type { AbReport } from "../ab-report.ts";
import type { BenchReport } from "../report.ts";
import type { TraceSummary } from "../trace.ts";
import { Ab } from "./Ab.tsx";
import { App } from "./App.tsx";

/** The report's markup, as the generator writes it into the document. */
export function render(report: BenchReport, traces: TraceSummary[]): string {
  return renderToString(() => <App report={report} traces={traces} />);
}

/** One comparison's markup, as the generator writes it into the document. */
export function renderAb(report: AbReport): string {
  return renderToString(() => <Ab report={report} />);
}
