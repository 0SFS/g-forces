/**
 * Scores pilot response models against the evidence fixtures in
 * validation/evidence/g-response/: each fixture's published protocol is
 * replayed through a model and the event it reports is compared with the
 * observed mean.
 *
 * A fixture names the pilot it describes: relaxed, protected (suit and
 * straining), suit alone, or mixed when the source pooled protection. A mixed
 * fixture is a bracket, not a target: the relaxed pilot should reach the event
 * no later than the observed mean, and the protected pilot no earlier. An
 * outcome that is a lower bound (a run stopped before the event) only counts a
 * model that falls short of it. A model that never shows the event is a miss,
 * never an error of zero. Errors are normalised by the source's standard
 * deviation where it gives one; the balanced error averages each family first,
 * so many easy fixtures cannot hide a failure in one family.
 *
 * Used by scripts/g-response-compare.ts, and by any parameter fit, which must
 * use only the fixtures whose role is "fit".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PilotResponseModel } from "../src/pilotResponse.ts";
import {
  firstEvent, PROTOCOLS, replay, replayStages, sampleLoads, type ResponseEventKind, type StagedProtocol,
} from "../src/responseTrace.ts";

export const EVIDENCE_DIR = fileURLToPath(new URL("../validation/evidence/g-response/", import.meta.url));

export type Pilot = "relaxed" | "protected" | "suit";

export interface Outcome {
  event: ResponseEventKind;
  /** "seconds" from `from` to the event (the default), or the "threshold": the lowest load held `holdSeconds` from rest that brings it. */
  measure?: "seconds" | "threshold";
  /** The protocol's start (the default), or the first event of this kind. */
  from?: "start" | ResponseEventKind;
  holdSeconds?: number;
  mean: number;
  sd?: number;
  n?: number;
  /** "lower": the observed value is at least `mean`, because the runs stopped first. */
  bound?: "lower";
}

export interface Fixture {
  id: string;
  family: string;
  role: "fit" | "holdout" | "unresolved";
  pilot?: Pilot | "mixed";
  locator?: string;
  protocol?: StagedProtocol;
  outcome?: Outcome;
  note?: string;
  reason?: string;
  /** The file it came from. */
  file: string;
}

export function loadEvidence(dir = EVIDENCE_DIR): Fixture[] {
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { files: string[] };
  return manifest.files.flatMap(file => {
    const source = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { fixtures: Omit<Fixture, "file">[] };
    return source.fixtures.map(fixture => ({
      ...fixture,
      file,
      protocol: fixture.protocol && { id: fixture.id, label: fixture.id, ...fixture.protocol },
    }));
  });
}

export interface Candidate {
  name: string;
  create: (pilot: Pilot) => PilotResponseModel;
}

const HIGHEST_THRESHOLD_G = 15;

/** What `model` reports for the fixture: seconds or g, or null when it never shows the event. */
export function measure(fixture: Fixture, create: () => PilotResponseModel, hz: number): number | null {
  const outcome = fixture.outcome!;
  if (outcome.measure === "threshold") {
    const hold = outcome.holdSeconds ?? 15;
    const shows = (g: number) =>
      firstEvent(replay(create(), sampleLoads(PROTOCOLS.sustained(g, hold), hz), 1 / hz), outcome.event) !== null;
    if (!shows(HIGHEST_THRESHOLD_G)) return null;
    let low = 1;
    let high = HIGHEST_THRESHOLD_G;
    while (high - low > 0.005) {
      const mid = (low + high) / 2;
      if (shows(mid)) high = mid;
      else low = mid;
    }
    return high;
  }
  const result = replayStages(create(), fixture.protocol!, hz);
  const from = outcome.from && outcome.from !== "start" ? firstEvent(result, outcome.from) : null;
  if (outcome.from && outcome.from !== "start" && !from) return null;
  const start = from?.seconds ?? 0;
  const event = result.events.find(each => each.kind === outcome.event && each.seconds > start) ?? null;
  return event ? event.seconds - start : null;
}

export interface Score {
  fixture: Fixture;
  model: string;
  /** The model's value: seconds or g. For a mixed fixture, the relaxed one. */
  value: number | null;
  /** For a mixed fixture, the protected pilot's value. */
  protectedValue?: number | null;
  /** Model minus observed; 0 for a lower bound that is met; null for a miss or a bracket. */
  error: number | null;
  /** `error` in the source's standard deviations, where it gives one. */
  z: number | null;
  /** For a mixed fixture: whether the observed mean lies between the relaxed and protected pilots. */
  bracketed?: boolean;
}

export function scoreFixture(fixture: Fixture, candidate: Candidate, hz: number): Score {
  const outcome = fixture.outcome!;
  if (fixture.pilot === "mixed") {
    const relaxed = measure(fixture, () => candidate.create("relaxed"), hz);
    const protectedValue = measure(fixture, () => candidate.create("protected"), hz);
    const bracketed = relaxed !== null && relaxed <= outcome.mean && (protectedValue === null || protectedValue >= outcome.mean);
    return { fixture, model: candidate.name, value: relaxed, protectedValue, error: null, z: null, bracketed };
  }
  const value = measure(fixture, () => candidate.create(fixture.pilot as Pilot), hz);
  if (value === null) return { fixture, model: candidate.name, value, error: null, z: null };
  const error = outcome.bound === "lower" ? Math.min(0, value - outcome.mean) : value - outcome.mean;
  return { fixture, model: candidate.name, value, error, z: outcome.sd ? error / outcome.sd : null };
}

export interface Summary {
  model: string;
  role: string;
  scored: number;
  misses: number;
  bracketsMet: number;
  brackets: number;
  /** Mean over families of each family's mean |z|; null when no fixture has a spread. */
  balancedZ: number | null;
  /** Each family's mean |z| (or mean |error| in its own unit when no fixture in it has a spread), and its misses. */
  families: Record<string, { meanAbsZ: number | null; meanAbsError: number | null; misses: number; unit: string }>;
}

export function summarize(scores: readonly Score[], model: string, role: string): Summary {
  const mine = scores.filter(score => score.model === model && score.fixture.role === role);
  const families: Summary["families"] = {};
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  for (const family of new Set(mine.map(score => score.fixture.family))) {
    const inFamily = mine.filter(score => score.fixture.family === family && score.fixture.pilot !== "mixed");
    if (!inFamily.length) continue;
    families[family] = {
      meanAbsZ: mean(inFamily.flatMap(score => score.z === null ? [] : [Math.abs(score.z)])),
      meanAbsError: mean(inFamily.flatMap(score => score.error === null ? [] : [Math.abs(score.error)])),
      misses: inFamily.filter(score => score.value === null).length,
      unit: inFamily[0]!.fixture.outcome!.measure === "threshold" ? "g" : "s",
    };
  }
  const brackets = mine.filter(score => score.fixture.pilot === "mixed");
  const zs = Object.values(families).flatMap(family => family.meanAbsZ === null ? [] : [family.meanAbsZ]);
  return {
    model, role,
    scored: mine.filter(score => score.error !== null).length,
    misses: mine.filter(score => score.fixture.pilot !== "mixed" && score.value === null).length,
    bracketsMet: brackets.filter(score => score.bracketed).length,
    brackets: brackets.length,
    balancedZ: mean(zs),
    families,
  };
}
