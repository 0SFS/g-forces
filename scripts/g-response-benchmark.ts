#!/usr/bin/env node
/**
 * What each pilot response model costs, measured in Node: CPU per accepted
 * physics step and per simulated second at 30, 60 and 120 Hz, and memory per
 * pilot.
 *
 * Every candidate replays the same deterministic load trace: high loads, both
 * signs, a slow ramp, repeated pulls, loss of consciousness and recovery, and
 * rest. The steps are grouped into frames with a catch-up burst of the rate's
 * most steps (2, 3 or 6) every 20th frame, as the flight groups them. Rounds
 * interleave the candidates, rotating their order, after untimed warmup; each
 * step's output is folded into a checksum so no work can be skipped. A
 * "no model" loop over the same trace measures the harness itself.
 *
 * The CPU figures are batch medians and spreads, normalised per step: a batch
 * median is not a per-step worst case. Chunks of 256 steps are timed as a
 * coarse sample of the tail. Memory is the heap growth per live instance with
 * a shared profile, next to each model's numeric state. This measures the pure
 * solvers only; the native load read and the flight's adapter are measured in
 * the browser, by fly's frame profiler.
 *
 * Usage: node --expose-gc scripts/g-response-benchmark.ts [--rounds=30] [--out=build/g-response]
 * Output: <out>/benchmark-<local time>.json, and a table on stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALERT_PILOT, stepPilot, type PilotState } from "../src/gForce.ts";
import { CurveResponse, curveProfile } from "../src/curveResponse.ts";
import { EXPOSURE_PROTECTED, ExposureResponse } from "../src/exposureResponse.ts";
import { PERFUSION_PROTECTED, PerfusionResponse } from "../src/perfusionResponse.ts";
import type { PilotResponseModel } from "../src/pilotResponse.ts";
import { chain, PROTOCOLS, protocolSeconds, sampleLoads } from "../src/responseTrace.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name: string, fallback: string) =>
  process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const rounds = Number(arg("rounds", "30"));
const out = path.resolve(root, arg("out", "build/g-response"));
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Run with node --expose-gc, so memory can be measured.");

const SETTINGS = { blackout: { min: 5, max: 9 }, redout: { min: -3, max: -2 }, onsetSeconds: 5, recoverySeconds: 2 };
const PASS_OUT = { meanSeconds: 11.9, spreadSeconds: 4 };
const RATES = [30, 60, 120] as const;
const BURST = { 30: 2, 60: 3, 120: 6 } as const;
const WARMUP_ROUNDS = 5;
const CHUNK = 256;

const trace = chain("benchmark", "Benchmark trace",
  PROTOCOLS.rest(10), PROTOCOLS.ramp(0.5, 9, 10), PROTOCOLS.pushPull(-2.5, 7), PROTOCOLS.repeated(2, 8, 5, 4),
  PROTOCOLS.unload(3, 11, 20), PROTOCOLS.pulse(9, 0.25), PROTOCOLS.ramp(0.1, 7, 20), PROTOCOLS.rest(30));

interface Candidate {
  name: string;
  /** Numeric state per pilot, in bytes. */
  stateBytes: number;
  create: () => PilotResponseModel | null;
}

/** The original pilot step, which returns a new state each call: the baseline Curve replaces. */
class LegacyPilot implements PilotResponseModel {
  readonly kind = "curve" as const;
  readonly output = { peripheralLoss: 0, centralLoss: 0, redout: 0, conscious: true };
  readonly stateBytes = 24;
  #pilot: PilotState = ALERT_PILOT;
  step(g: number, seconds: number): void {
    this.#pilot = stepPilot(this.#pilot, g, seconds, SETTINGS, PASS_OUT);
    this.output.centralLoss = this.#pilot.vision.blackout;
    this.output.redout = this.#pilot.vision.redout;
    this.output.conscious = this.#pilot.secondsOut === 0;
  }
  reset(): void { this.#pilot = ALERT_PILOT; }
  diagnostics(): Record<string, number> { return {}; }
}

const CANDIDATES: Candidate[] = [
  { name: "No model (harness)", stateBytes: 0, create: () => null },
  { name: "Original stepPilot", stateBytes: 24, create: () => new LegacyPilot() },
  { name: "Curve", stateBytes: 24, create: () => new CurveResponse(curveProfile(SETTINGS), PASS_OUT) },
  { name: "Exposure", stateBytes: 0, create: () => new ExposureResponse(EXPOSURE_PROTECTED) },
  { name: "Perfusion", stateBytes: 0, create: () => new PerfusionResponse(PERFUSION_PROTECTED) },
];
for (const candidate of CANDIDATES) candidate.stateBytes = candidate.create()?.stateBytes ?? 0;

let checksum = 0;

/** One timed pass over the trace; returns its seconds, and fills `chunks` with each chunk's seconds. */
function pass(model: PilotResponseModel | null, loads: Float64Array, hz: number, chunks: number[] | null): number {
  const dt = 1 / hz;
  const burst = BURST[hz as keyof typeof BURST];
  let sum = 0;
  model?.reset();
  const output = model?.output;
  const start = performance.now();
  let chunkStart = start;
  let step = 0;
  for (let frame = 0; step < loads.length; frame += 1) {
    const end = Math.min(loads.length, step + (frame % 20 === 19 ? burst : 1));
    for (; step < end; step += 1) {
      const g = loads[step]!;
      if (model) {
        model.step(g, dt);
        sum += output!.peripheralLoss + output!.centralLoss + output!.redout + (output!.conscious ? 1 : 0);
      } else {
        sum += g;
      }
      if (chunks && (step + 1) % CHUNK === 0) {
        const now = performance.now();
        chunks.push((now - chunkStart) / 1000);
        chunkStart = now;
      }
    }
  }
  const seconds = (performance.now() - start) / 1000;
  checksum += sum;
  return seconds;
}

const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low]! + (sorted[Math.ceil(at)]! - sorted[low]!) * (at - low);
};

interface RateResult {
  hz: number;
  steps: number;
  /** Nanoseconds per step: batch median, 10th and 90th percentiles across rounds. */
  stepNs: { median: number; p10: number; p90: number };
  /** Nanoseconds per step in the slowest 1% of 256-step chunks, from separate rounds. */
  chunkP99Ns: number;
  /** Microseconds of CPU per simulated second, from the median. */
  perSimulatedSecondUs: number;
}

const results = CANDIDATES.map(candidate => ({ name: candidate.name, stateBytes: candidate.stateBytes, rates: [] as RateResult[],
  heapBytesPerPilot: 0 }));

for (const hz of RATES) {
  const loads = sampleLoads(trace, hz);
  const models = CANDIDATES.map(candidate => candidate.create());
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) models.forEach(model => pass(model, loads, hz, null));
  const batches = CANDIDATES.map(() => [] as number[]);
  const chunks = CANDIDATES.map(() => [] as number[]);
  for (let round = 0; round < rounds; round += 1) {
    for (let turn = 0; turn < CANDIDATES.length; turn += 1) {
      const index = (round + turn) % CANDIDATES.length;
      // Every fifth round samples chunks instead, so the timing calls stay out of the batch figures.
      if (round % 5 === 4) pass(models[index]!, loads, hz, chunks[index]!);
      else batches[index]!.push(pass(models[index]!, loads, hz, null) / loads.length);
    }
  }
  CANDIDATES.forEach((_, index) => {
    const perStep = batches[index]!.map(seconds => seconds * 1e9);
    const median = quantile(perStep, 0.5);
    results[index]!.rates.push({
      hz, steps: loads.length,
      stepNs: { median, p10: quantile(perStep, 0.1), p90: quantile(perStep, 0.9) },
      chunkP99Ns: quantile(chunks[index]!, 0.99) * 1e9 / CHUNK,
      perSimulatedSecondUs: median * hz / 1000,
    });
  });
}

// Memory: heap growth per live pilot, with the profile shared, after each has stepped once.
const PILOTS = 2000;
CANDIDATES.forEach((candidate, index) => {
  if (!candidate.create()) return;
  gc();
  const before = process.memoryUsage().heapUsed;
  const pilots = Array.from({ length: PILOTS }, () => {
    const model = candidate.create()!;
    model.step(6, 1 / 60);
    return model;
  });
  gc();
  results[index]!.heapBytesPerPilot = Math.round((process.memoryUsage().heapUsed - before) / pilots.length);
});

const record = {
  measuredAt: new Date().toISOString(),
  runtime: `Node ${process.version}`,
  device: `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores, ${platform()} ${release()} ${arch()}`,
  trace: { id: trace.id, seconds: protocolSeconds(trace) },
  rounds, warmupRounds: WARMUP_ROUNDS, burst: BURST, checksum,
  candidates: results,
};
mkdirSync(out, { recursive: true });
const stamp = record.measuredAt.replace(/[:.]/g, "-");
const file = path.join(out, `benchmark-${stamp}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

const fixed = (value: number, digits = 0) => value.toFixed(digits);
console.log(`${record.runtime}; ${record.device}; ${rounds} rounds over a ${record.trace.seconds} s trace`);
console.log("candidate | state B | heap B/pilot | " + RATES.map(hz => `${hz} Hz ns/step median (p10–p90), chunk p99 | µs per sim s`).join(" | "));
for (const result of results) {
  console.log([result.name, result.stateBytes, result.heapBytesPerPilot,
    ...result.rates.map(rate => `${fixed(rate.stepNs.median)} (${fixed(rate.stepNs.p10)}–${fixed(rate.stepNs.p90)}), ${fixed(rate.chunkP99Ns)} | ${fixed(rate.perSimulatedSecondUs, 1)}`),
  ].join(" | "));
}
console.log(`checksum ${checksum}`);
console.log(`wrote ${path.relative(root, file)}`);
