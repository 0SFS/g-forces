#!/usr/bin/env node
/**
 * The pilot response models side by side: the same accepted load traces
 * through each, and the events read from their outputs by one set of
 * definitions (src/responseTrace.ts).
 *
 * Two parts. The synthetic families of docs/g-response-comparison.md test
 * mechanisms, not physiology: they show which history each model keeps. The
 * evidence fixtures in validation/evidence/g-response/ reconstruct published
 * protocols; each is scored against its observed outcome, in seconds and, where
 * the source gives a spread, in standard deviations. A fixture marked
 * unresolved is listed but not scored, and a model that never shows the event
 * is counted as a miss, not given an error.
 *
 * Usage: node scripts/g-response-compare.ts [--hz=60] [--out=build/g-response]
 * Output: <out>/compare-<local time>.json and .md, and the tables on stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CurveResponse, curveProfile } from "../src/curveResponse.ts";
import { EXPOSURE_PROTECTED, EXPOSURE_RELAXED, EXPOSURE_SUIT, ExposureResponse } from "../src/exposureResponse.ts";
import { PERFUSION_PROTECTED, PERFUSION_RELAXED, PERFUSION_SUIT, PerfusionResponse } from "../src/perfusionResponse.ts";
import type { PilotResponseModel } from "../src/pilotResponse.ts";
import { loadEvidence, scoreFixture, summarize, type Candidate } from "./g-response-evidence.ts";
import {
  firstEvent, PROTOCOLS, replay, sampleLoads, type LoadProtocol, type ReplayResult, type ResponseEventKind,
} from "../src/responseTrace.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name: string, fallback: string) =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hz = Number(arg("hz", "60"));
const out = path.resolve(root, arg("out", "build/g-response"));

type Protection = "relaxed" | "protected";

const CURVE_SETTINGS = { blackout: { min: 5, max: 9 }, redout: { min: -3, max: -2 }, onsetSeconds: 5, recoverySeconds: 2 };
/** Every candidate, by the protection its parameters describe. Curve has one setting for both. */
const CANDIDATES: readonly { name: string; create: (protection: Protection) => PilotResponseModel }[] = [
  // The original defaults, passing out included, at its mean time and no spread so runs repeat.
  { name: "Curve", create: () => new CurveResponse(curveProfile(CURVE_SETTINGS), { meanSeconds: 11.9, spreadSeconds: 0 }) },
  { name: "Exposure", create: protection => new ExposureResponse(protection === "relaxed" ? EXPOSURE_RELAXED : EXPOSURE_PROTECTED) },
  { name: "Perfusion", create: protection => new PerfusionResponse(protection === "relaxed" ? PERFUSION_RELAXED : PERFUSION_PROTECTED) },
];

/** The candidates for the evidence, with a suit-only pilot. */
const EVIDENCE_CANDIDATES: readonly Candidate[] = [
  { name: "Curve", create: () => CANDIDATES[0]!.create("protected") },
  { name: "Exposure", create: pilot => new ExposureResponse(pilot === "relaxed" ? EXPOSURE_RELAXED
    : pilot === "suit" ? EXPOSURE_SUIT : EXPOSURE_PROTECTED) },
  { name: "Perfusion", create: pilot => new PerfusionResponse(pilot === "relaxed" ? PERFUSION_RELAXED
    : pilot === "suit" ? PERFUSION_SUIT : PERFUSION_PROTECTED) },
];

const run = (model: PilotResponseModel, protocol: LoadProtocol): ReplayResult =>
  replay(model, sampleLoads(protocol, hz), 1 / hz);

// Synthetic families: the load is applied at 1 s in each, so times below are from that.
const ONSET = 1;
const FAMILIES: readonly { family: string; protocol: LoadProtocol }[] = [
  ...[0.05, 0.25, 1].map(seconds => ({ family: "Brief pulse", protocol: PROTOCOLS.pulse(9, seconds) })),
  ...[4, 6, 9, 12].map(g => ({ family: "Sustained", protocol: PROTOCOLS.sustained(g, 60) })),
  ...[0.1, 0.5, 3].map(rate => ({ family: "Ramp to +9", protocol: PROTOCOLS.ramp(rate, 9, 30) })),
  ...[1, 5, 20].map(rest => ({ family: "Repeated +6", protocol: PROTOCOLS.repeated(rest, 6, 5, 4) })),
  ...[1, -1].map(before => ({ family: "Push–pull", protocol: PROTOCOLS.pushPull(before, 6, 3) })),
  ...[1, -1].map(before => ({ family: "Push–pull", protocol: PROTOCOLS.pushPull(before, 4.5, 3) })),
  ...[0.5, 9].map(seconds => ({ family: "Unload after LOC", protocol: PROTOCOLS.unload(seconds) })),
  ...[4, 30].map(rest => ({ family: "Pull during recovery", protocol: PROTOCOLS.pullDuringRecovery(rest, 9) })),
];
const SHOWN: readonly ResponseEventKind[] = ["symptoms", "vision-lost", "unconscious", "conscious", "vision-returned", "field-clear"];

const at = (result: ReplayResult, kind: ResponseEventKind) => {
  const event = firstEvent(result, kind);
  return event ? (event.seconds - ONSET).toFixed(1) : "–";
};

interface Row { family: string; protocol: string; profile: Protection; cells: Record<string, string> }
const rows: Row[] = [];
for (const { family, protocol } of FAMILIES) {
  for (const profile of ["relaxed", "protected"] as const) {
    const cells: Record<string, string> = {};
    for (const candidate of CANDIDATES) {
      if (candidate.name === "Curve" && profile === "relaxed") continue;
      const result = run(candidate.create(profile), protocol);
      cells[candidate.name] = SHOWN.map(kind => at(result, kind)).join(" / ");
    }
    rows.push({ family, protocol: protocol.label, profile, cells });
  }
}

// Evidence fixtures.
const evidence = loadEvidence();
const scored = evidence.filter(fixture => fixture.role !== "unresolved");
const scores = scored.flatMap(fixture => EVIDENCE_CANDIDATES.map(candidate => scoreFixture(fixture, candidate, hz)));
const summaries = EVIDENCE_CANDIDATES.flatMap(candidate => (["fit", "holdout"] as const).map(role => summarize(scores, candidate.name, role)));

const names = CANDIDATES.map(candidate => candidate.name);
const lines: string[] = [];
lines.push(`# Pilot response comparison at ${hz} Hz`, "");
lines.push(`Seconds from the load's onset to: ${SHOWN.join(" / ")}; – means never.`, "");
lines.push(`| Family | Protocol | Pilot | ${names.join(" | ")} |`, `| --- | --- | --- | ${names.map(() => "---").join(" | ")} |`);
for (const row of rows) lines.push(`| ${row.family} | ${row.protocol} | ${row.profile} | ${names.map(name => row.cells[name] ?? "").join(" | ")} |`);
lines.push("");
const show = (value: number | null | undefined, unit: string) => value === null || value === undefined ? "never" : `${value.toFixed(unit === "g" ? 2 : 1)}`;
lines.push("## Evidence fixtures", "");
lines.push("Model value, and model minus observed (in the source's standard deviations where it gives one). A mixed-protection fixture shows relaxed–protected and whether the observed mean lies between them.", "");
lines.push(`| Fixture | Role | Family | Event | Observed | ${names.join(" | ")} |`, `| --- | --- | --- | --- | --- | ${names.map(() => "---").join(" | ")} |`);
for (const fixture of scored) {
  const outcome = fixture.outcome!;
  const unit = outcome.measure === "threshold" ? "g" : "s";
  const cells = names.map(name => {
    const score = scores.find(each => each.fixture === fixture && each.model === name)!;
    if (fixture.pilot === "mixed") return `${show(score.value, unit)}–${show(score.protectedValue, unit)} ${score.bracketed ? "✓" : "✗"}`;
    if (score.value === null) return "missed";
    return `${show(score.value, unit)} (${score.error! >= 0 ? "+" : ""}${score.error!.toFixed(unit === "g" ? 2 : 1)}${score.z === null ? "" : `, ${score.z.toFixed(2)} sd`})`;
  });
  const observed = `${outcome.bound === "lower" ? "≥ " : ""}${outcome.mean}${outcome.sd ? ` ± ${outcome.sd}` : ""} ${unit}`;
  lines.push(`| ${fixture.id} | ${fixture.role} | ${fixture.family} | ${outcome.event} | ${observed} | ${cells.join(" | ")} |`);
}
lines.push("", "Balanced error: the mean over families of each family's mean |error| in standard deviations.", "");
lines.push("| Model | Role | Scored | Misses | Brackets met | Balanced error, sd | By family |", "| --- | --- | --- | --- | --- | --- | --- |");
for (const summary of summaries) {
  const families = Object.entries(summary.families).map(([family, entry]) =>
    `${family}: ${entry.meanAbsZ === null ? `${entry.meanAbsError?.toFixed(2) ?? "–"} ${entry.unit}` : `${entry.meanAbsZ.toFixed(2)} sd`}${entry.misses ? `, ${entry.misses} missed` : ""}`).join("; ");
  lines.push(`| ${summary.model} | ${summary.role} | ${summary.scored} | ${summary.misses} | ${summary.bracketsMet}/${summary.brackets} | ${summary.balancedZ?.toFixed(2) ?? "–"} | ${families} |`);
}
lines.push("", "Not scored:", "");
for (const fixture of evidence.filter(each => each.role === "unresolved")) lines.push(`- ${fixture.id}: ${fixture.reason}`);
const text = lines.join("\n");
console.log(text);
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(path.join(out, `compare-${stamp}.md`), `${text}\n`);
writeFileSync(path.join(out, `compare-${stamp}.json`), `${JSON.stringify({ hz, rows, scores: scores.map(score => ({ ...score, fixture: score.fixture.id })), summaries }, null, 2)}\n`);
