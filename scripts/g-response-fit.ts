#!/usr/bin/env node
/**
 * Fits the relaxed preset of Exposure or Perfusion to the evidence fixtures
 * whose role is "fit", and only those, then sizes the suit and straining to
 * E07's protection. The held-out fixtures never enter it.
 *
 * The relaxed fit is a bounded pattern search over the parameters listed
 * below, from the current preset: each step tries one parameter up and down,
 * keeps the first improvement, and halves every step once none improves. The
 * cost is the squared error in the source's standard deviations (or in its
 * unit where it gives none), 25 for a missed event, averaged within each
 * family and then over families, as the comparison scores them. Perfusion's
 * pressures are bounded to physiological ranges. Protection is then solved by
 * bisection on C54's symptom threshold: the suit to +2.9 g over the relaxed
 * pilot, then straining to 9.0 g, E07's suit and suit-with-straining runs.
 *
 * Usage: node scripts/g-response-fit.ts [exposure|perfusion] [--budget=1500]
 * Output: the fitted values on stdout, to be copied into the preset by hand
 * with a new version in its id. A run takes minutes: run it on a machine that
 * can spare them.
 */
import { EXPOSURE_RELAXED, ExposureResponse, type ExposureProfile } from "../src/exposureResponse.ts";
import { PERFUSION_RELAXED, PerfusionResponse, type PerfusionProfile } from "../src/perfusionResponse.ts";
import type { PilotResponseModel } from "../src/pilotResponse.ts";
import { loadEvidence, measure, type Fixture } from "./g-response-evidence.ts";

const HZ = 60;
const which = process.argv.slice(2).find(value => !value.startsWith("--")) ?? "exposure";
const BUDGET = Number(process.argv.find(value => value.startsWith("--budget="))?.slice("--budget=".length) ?? "1500");
const fixtures = loadEvidence().filter(fixture => fixture.role === "fit");
const relaxedFixtures = fixtures.filter(fixture => fixture.pilot === "relaxed");

interface Param<P> { name: string; get: (p: P) => number; set: (p: P, v: number) => P; lo: number; hi: number; step: number }

function objective(create: () => PilotResponseModel, set: readonly Fixture[]): { cost: number; detail: string[] } {
  const families = new Map<string, number[]>();
  const detail: string[] = [];
  for (const fixture of set) {
    const outcome = fixture.outcome!;
    const value = measure(fixture, create, HZ);
    const scale = outcome.sd ?? 1;
    let term: number;
    if (value === null) term = 25;
    else {
      const error = outcome.bound === "lower" ? Math.min(0, value - outcome.mean) : value - outcome.mean;
      term = (error / scale) ** 2;
    }
    detail.push(`${fixture.id}: ${value?.toFixed(2) ?? "missed"} vs ${outcome.mean}`);
    (families.get(fixture.family) ?? families.set(fixture.family, []).get(fixture.family)!).push(term);
  }
  let cost = 0;
  for (const terms of families.values()) cost += terms.reduce((a, b) => a + b, 0) / terms.length;
  return { cost: cost / families.size, detail };
}

function search<P>(start: P, params: Param<P>[], create: (p: P) => PilotResponseModel, set: readonly Fixture[], budget = BUDGET): P {
  let best = start;
  let bestCost = objective(() => create(best), set).cost;
  const steps = params.map(param => param.step);
  let evaluations = 0;
  console.log(`start cost ${bestCost.toFixed(4)}`);
  while (evaluations < budget && steps.some((step, index) => step > params[index]!.step / 64)) {
    let improved = false;
    params.forEach((param, index) => {
      for (const sign of [1, -1]) {
        const value = Math.min(param.hi, Math.max(param.lo, param.get(best) + sign * steps[index]!));
        if (value === param.get(best)) continue;
        const trial = param.set(best, value);
        const cost = objective(() => create(trial), set).cost;
        evaluations += 1;
        if (cost < bestCost - 1e-9) { best = trial; bestCost = cost; improved = true; break; }
      }
    });
    if (!improved) for (let index = 0; index < steps.length; index += 1) steps[index]! /= 2;
  }
  console.log(`end cost ${bestCost.toFixed(4)} after ${evaluations} evaluations`);
  return best;
}

/** The parameter value at which `threshold(value)` crosses `target`, by bisection; `threshold` rises with value. */
function solve(threshold: (value: number) => number | null, target: number, lo: number, hi: number): number {
  for (let index = 0; index < 30; index += 1) {
    const mid = (lo + hi) / 2;
    const at = threshold(mid) ?? Number.POSITIVE_INFINITY;
    if (at < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const symptomsThreshold = fixtures.find(fixture => fixture.id === "c54-pll")!;

if (which === "exposure") {
  type P = ExposureProfile;
  const params: Param<P>[] = [
    { name: "retinaG.min", get: p => p.retinaG.min, set: (p, v) => ({ ...p, retinaG: { min: v, max: v + p.retinaG.max - p.retinaG.min } }), lo: 2, hi: 5, step: 0.4 },
    { name: "retinaG.span", get: p => p.retinaG.max - p.retinaG.min, set: (p, v) => ({ ...p, retinaG: { min: p.retinaG.min, max: p.retinaG.min + v } }), lo: 0.5, hi: 5, step: 0.4 },
    { name: "brainG.min", get: p => p.brainG.min, set: (p, v) => ({ ...p, brainG: { min: v, max: v + p.brainG.max - p.brainG.min } }), lo: 2.5, hi: 6, step: 0.4 },
    { name: "brainG.span", get: p => p.brainG.max - p.brainG.min, set: (p, v) => ({ ...p, brainG: { min: p.brainG.min, max: p.brainG.min + v } }), lo: 0.5, hi: 5, step: 0.4 },
    { name: "retinaBufferSeconds", get: p => p.retinaBufferSeconds, set: (p, v) => ({ ...p, retinaBufferSeconds: v }), lo: 3, hi: 15, step: 1 },
    { name: "brainBufferSeconds", get: p => p.brainBufferSeconds, set: (p, v) => ({ ...p, brainBufferSeconds: v }), lo: 3, hi: 15, step: 1 },
    { name: "retinaRecoverySeconds", get: p => p.retinaRecoverySeconds, set: (p, v) => ({ ...p, retinaRecoverySeconds: v }), lo: 1, hi: 15, step: 1 },
    { name: "brainRecoverySeconds", get: p => p.brainRecoverySeconds, set: (p, v) => ({ ...p, brainRecoverySeconds: v }), lo: 1, hi: 15, step: 1 },
    { name: "peripheralDebt.min", get: p => p.peripheralDebt.min, set: (p, v) => ({ ...p, peripheralDebt: { min: v, max: Math.min(1, v + p.peripheralDebt.max - p.peripheralDebt.min) } }), lo: 0.1, hi: 0.8, step: 0.1 },
    { name: "peripheralDebt.span", get: p => p.peripheralDebt.max - p.peripheralDebt.min, set: (p, v) => ({ ...p, peripheralDebt: { min: p.peripheralDebt.min, max: Math.min(1, p.peripheralDebt.min + v) } }), lo: 0.1, hi: 0.8, step: 0.1 },
    { name: "centralDebt.min", get: p => p.centralDebt.min, set: (p, v) => ({ ...p, centralDebt: { min: v, max: 1 } }), lo: 0.4, hi: 0.95, step: 0.1 },
    { name: "wakeDebt", get: p => p.wakeDebt, set: (p, v) => ({ ...p, wakeDebt: v }), lo: 0.1, hi: 0.9, step: 0.1 },
    { name: "wakeDwellSeconds", get: p => p.wakeDwellSeconds, set: (p, v) => ({ ...p, wakeDwellSeconds: v }), lo: 0, hi: 8, step: 1 },
  ];
  const relaxed = search(EXPOSURE_RELAXED, params, p => new ExposureResponse(p), relaxedFixtures);
  const fitted = objective(() => new ExposureResponse(relaxed), relaxedFixtures);
  console.log(fitted.detail.join("\n"));
  for (const param of params) console.log(`${param.name} = ${round(param.get(relaxed), 3)}`);
  const relaxedPll = measure(symptomsThreshold, () => new ExposureResponse(relaxed), HZ)!;
  const suitG = solve(v => measure(symptomsThreshold, () => new ExposureResponse({ ...relaxed, suitG: v }), HZ), relaxedPll + 2.9, 0, 6);
  const strainG = solve(v => measure(symptomsThreshold, () => new ExposureResponse({ ...relaxed, suitG: round(suitG), strainG: v }), HZ), 9.0, 0, 6);
  console.log(`relaxed PLL ${relaxedPll.toFixed(2)}; suitG = ${round(suitG)}; strainG = ${round(strainG)}`);
} else {
  type P = PerfusionProfile;
  const params: Param<P>[] = [
    { name: "retinaReserveSeconds", get: p => p.retinaReserveSeconds, set: (p, v) => ({ ...p, retinaReserveSeconds: v }), lo: 3, hi: 15, step: 1 },
    { name: "brainReserveSeconds", get: p => p.brainReserveSeconds, set: (p, v) => ({ ...p, brainReserveSeconds: v }), lo: 3, hi: 15, step: 1 },
    { name: "refillGain", get: p => p.refillGain, set: (p, v) => ({ ...p, refillGain: v }), lo: 0, hi: 6, step: 0.5 },
    { name: "wakeReserve", get: p => p.wakeReserve, set: (p, v) => ({ ...p, wakeReserve: v }), lo: 0.1, hi: 0.9, step: 0.1 },
    { name: "wakeDwellSeconds", get: p => p.wakeDwellSeconds, set: (p, v) => ({ ...p, wakeDwellSeconds: v }), lo: 0, hi: 8, step: 1 },
    { name: "intraocularMmHg", get: p => p.intraocularMmHg, set: (p, v) => ({ ...p, intraocularMmHg: v }), lo: 12, hi: 21, step: 2 },
    { name: "retinaFullFlowMmHg", get: p => p.retinaFullFlowMmHg, set: (p, v) => ({ ...p, retinaFullFlowMmHg: v }), lo: 10, hi: 60, step: 5 },
    { name: "brainFullFlowMmHg", get: p => p.brainFullFlowMmHg, set: (p, v) => ({ ...p, brainFullFlowMmHg: v }), lo: 10, hi: 60, step: 5 },
    { name: "brainCm", get: p => p.brainCm, set: (p, v) => ({ ...p, brainCm: v }), lo: 25, hi: 40, step: 2 },
    { name: "peripheralRetinaMmHg", get: p => p.peripheralRetinaMmHg, set: (p, v) => ({ ...p, peripheralRetinaMmHg: v }), lo: 0, hi: 30, step: 3 },
    { name: "cerebralSurroundMmHg", get: p => p.cerebralSurroundMmHg, set: (p, v) => ({ ...p, cerebralSurroundMmHg: v }), lo: -25, hi: 0, step: 4 },
    { name: "peripheralDeficit.min", get: p => p.peripheralDeficit.min, set: (p, v) => ({ ...p, peripheralDeficit: { min: v, max: Math.min(1, v + p.peripheralDeficit.max - p.peripheralDeficit.min) } }), lo: 0.1, hi: 0.8, step: 0.1 },
    { name: "peripheralDeficit.span", get: p => p.peripheralDeficit.max - p.peripheralDeficit.min, set: (p, v) => ({ ...p, peripheralDeficit: { min: p.peripheralDeficit.min, max: Math.min(1, p.peripheralDeficit.min + v) } }), lo: 0.1, hi: 0.8, step: 0.1 },
    { name: "centralDeficit.min", get: p => p.centralDeficit.min, set: (p, v) => ({ ...p, centralDeficit: { min: v, max: 1 } }), lo: 0.4, hi: 0.95, step: 0.1 },
  ];
  const relaxed = search(PERFUSION_RELAXED, params, p => new PerfusionResponse(p), relaxedFixtures);
  const fitted = objective(() => new PerfusionResponse(relaxed), relaxedFixtures);
  console.log(fitted.detail.join("\n"));
  for (const param of params) console.log(`${param.name} = ${round(param.get(relaxed), 3)}`);
  const relaxedPll = measure(symptomsThreshold, () => new PerfusionResponse(relaxed), HZ)!;
  const cgem = { suitStartG: 1, suitMmHgPerG: 9, suitMaxMmHg: 72 };
  const cgemPll = measure(symptomsThreshold, () => new PerfusionResponse({ ...relaxed, ...cgem }), HZ);
  // Effective suit: the same 1 g opening and linear schedule, its gain solved for E07's ~2.9 g; no cap below 9 g.
  const perG = solve(v => measure(symptomsThreshold, () => new PerfusionResponse({ ...relaxed, suitStartG: 1, suitMaxMmHg: 8 * v, suitMmHgPerG: v }), HZ), relaxedPll + 2.9, 0, 40);
  const suit = { suitStartG: 1, suitMmHgPerG: round(perG, 1), suitMaxMmHg: round(8 * perG, 0) };
  const strain = solve(v => measure(symptomsThreshold, () => new PerfusionResponse({ ...relaxed, ...suit, strainMmHg: v }), HZ), 9.0, 0, 200);
  console.log(`relaxed PLL ${relaxedPll.toFixed(2)}; CGEM suit PLL ${cgemPll?.toFixed(2)} (+${((cgemPll ?? 0) - relaxedPll).toFixed(2)} g)`);
  console.log(`effective suit ${JSON.stringify(suit)}; strainMmHg = ${round(strain, 1)}`);
}
