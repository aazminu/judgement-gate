import type { AnalyticsSink } from "./types";

export const FALSE_POSITIVE_COMMAND = "/judgement-gate false-positive";

/**
 * Workers Analytics Engine row layout (keep docs/calibration.md in step):
 *   index1  owner/repo
 *   blob1   event: "evaluation" | "feedback" | "routing"
 *   blob2   owner/repo
 *   blob3   judgement id ("" for routing)
 *   blob4   mode: "shadow" | "enforce" (the routing mode for routing)
 *   blob5   outcome: "flagged" | "passed" | "cleared" | "degraded" | "false_positive" | "human" | "agent" | "unavailable"
 *   blob6   verdict reason ("" for feedback; routing reasons joined with "; ", at most 256 chars, for routing)
 *   blob7   commenter's author_association ("" for evaluation)
 *   double1 PR number
 *   double2 flagged (0/1)
 *   double3 probability (-1 when not applicable)
 *   double4 confidence (-1 when not applicable)
 *   double5 cleared by satisfied_by (0/1)
 *   double6 Jev latency in ms (-1 when not applicable)
 *   double7 degraded (0/1)
 * Only ids, numbers and enum-like strings: never PR title, body, diff or commenter identity.
 */
export interface AnalyticsEvent {
  event: "evaluation" | "feedback" | "routing";
  repo: string;
  pr: number;
  judgement: string;
  mode: string;
  outcome: "flagged" | "passed" | "cleared" | "degraded" | "false_positive" | "human" | "agent" | "unavailable";
  reason?: string;
  association?: string;
  probability?: number;
  confidence?: number;
  latencyMs?: number;
}

/** Best-effort: absent binding or a failing write must never affect the gate. */
export function record(sink: AnalyticsSink | undefined, e: AnalyticsEvent): void {
  if (!sink) return;
  try {
    sink.writeDataPoint({
      indexes: [e.repo],
      blobs: [e.event, e.repo, e.judgement, e.mode, e.outcome, e.reason ?? "", e.association ?? ""],
      doubles: [
        e.pr,
        e.outcome === "flagged" ? 1 : 0,
        e.probability ?? -1,
        e.confidence ?? -1,
        e.outcome === "cleared" ? 1 : 0,
        e.latencyMs ?? -1,
        e.outcome === "degraded" ? 1 : 0,
      ],
    });
  } catch (err) {
    console.error("judgement-gate analytics failed", err);
  }
}

const COMMAND = /^\s*\/judgement-gate\s+false-positive\s+([A-Za-z0-9_-]{1,64})\s*$/m;

/** Judgement id from a `/judgement-gate false-positive <id>` line, or null. */
export function parseFalsePositive(body: string): string | null {
  return COMMAND.exec(body)?.[1] ?? null;
}
