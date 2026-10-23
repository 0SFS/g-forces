import { describe, expect, it } from "vitest";
import { CurveResponse, curveProfile } from "../src/curveResponse";
import { EXPOSURE_PROTECTED, EXPOSURE_RELAXED, ExposureResponse } from "../src/exposureResponse";
import { PERFUSION_PROTECTED, PERFUSION_RELAXED, PerfusionResponse } from "../src/perfusionResponse";
import { visionClosure, type PilotResponseModel } from "../src/pilotResponse";
import {
  chain, firstEvent, PROTOCOLS, replay, sampleLoads, type LoadProtocol, type ResponseEventKind,
} from "../src/responseTrace";

/**
 * What every pilot response model must do, whatever it represents: the
 * software invariants and the history dependence the comparison relies on.
 * These are synthetic mechanism checks, not physiological validation.
 */

const CURVE_SETTINGS = { blackout: { min: 5, max: 9 }, redout: { min: -3, max: -2 }, onsetSeconds: 5, recoverySeconds: 2 };

const CANDIDATES: readonly (readonly [string, () => PilotResponseModel])[] = [
  ["Curve", () => new CurveResponse(curveProfile(CURVE_SETTINGS), { meanSeconds: 11.9, spreadSeconds: 0 })],
  ["Exposure, protected", () => new ExposureResponse(EXPOSURE_PROTECTED)],
  ["Exposure, relaxed", () => new ExposureResponse(EXPOSURE_RELAXED)],
  ["Perfusion, protected", () => new PerfusionResponse(PERFUSION_PROTECTED)],
  ["Perfusion, relaxed", () => new PerfusionResponse(PERFUSION_RELAXED)],
];
const STATEFUL = CANDIDATES.filter(([name]) => name !== "Curve");

const HZ = 60;
const run = (model: PilotResponseModel, protocol: LoadProtocol, hz = HZ) =>
  replay(model, sampleLoads(protocol, hz), 1 / hz);

/** The lowest load held `seconds` from rest that brings an event of `kind`, to 0.01 g. */
const threshold = (create: () => PilotResponseModel, kind: ResponseEventKind, seconds = 15) => {
  let low = 1;
  let high = 20;
  while (high - low > 0.01) {
    const mid = (low + high) / 2;
    if (firstEvent(run(create(), PROTOCOLS.sustained(mid, seconds)), kind)) high = mid;
    else low = mid;
  }
  return high;
};

/** A load that never settles: pulls, pushes and rests, 120 s. */
const restless: LoadProtocol = chain("restless", "Restless", PROTOCOLS.ramp(3, 11, 12), PROTOCOLS.pushPull(-2.5, 8),
  PROTOCOLS.repeated(1, 9, 3, 3));

describe.each(CANDIDATES)("%s", (_name, create) => {
  it("starts rested: clear sight and conscious", () => {
    const model = create();
    expect(model.output).toEqual({ peripheralLoss: 0, centralLoss: 0, redout: 0, conscious: true });
  });

  it("does not change while no simulated time passes", () => {
    const model = create();
    for (let step = 0; step < 300; step += 1) model.step(9, 1 / HZ);
    const before = model.diagnostics();
    const output = { ...model.output };
    for (const seconds of [0, -1, Number.NaN]) model.step(12, seconds);
    expect(model.diagnostics()).toEqual(before);
    expect(model.output).toEqual(output);
  });

  it("keeps every output finite and between its ends under any load, including no reading", () => {
    const model = create();
    const loads = sampleLoads(restless, HZ);
    loads[100] = Number.NaN;
    loads[200] = Number.POSITIVE_INFINITY;
    for (const g of loads) {
      model.step(g, 1 / HZ);
      for (const value of [model.output.peripheralLoss, model.output.centralLoss, model.output.redout]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      for (const value of Object.values(model.diagnostics())) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("stays clear at rest, and recovers to clear and conscious from an impaired start", () => {
    expect(run(create(), PROTOCOLS.rest()).events).toEqual([]);
    const model = create();
    run(model, PROTOCOLS.sustained(12, 20));
    replay(model, sampleLoads(PROTOCOLS.rest(120), HZ), 1 / HZ, { keepState: true });
    expect(model.output).toEqual({ peripheralLoss: 0, centralLoss: 0, redout: 0, conscious: true });
  });

  it("is the same however the accepted steps are grouped into frames", () => {
    const loads = sampleLoads(restless, HZ);
    const whole = create();
    replay(whole, loads, 1 / HZ);
    const framed = create();
    framed.reset();
    for (let start = 0, frame = 0; start < loads.length; frame += 1) {
      const size = [1, 2, 3, 6][frame % 4]!;
      replay(framed, loads.subarray(start, start + size), 1 / HZ, { keepState: true });
      start += size;
    }
    expect(framed.diagnostics()).toEqual(whole.diagnostics());
  });

  it("resets to rested", () => {
    const model = create();
    run(model, restless);
    model.reset();
    expect(model.output).toEqual({ peripheralLoss: 0, centralLoss: 0, redout: 0, conscious: true });
    expect(model.diagnostics()).toEqual(create().diagnostics());
  });

  it("ignores a load that lasts a twentieth of a second, such as a touchdown", () => {
    const result = run(create(), PROTOCOLS.pulse(9, 0.05));
    expect(result.events).toEqual([]);
  });

  it("closes red under a push and clears afterwards", () => {
    const model = create();
    run(model, { id: "push", label: "push", startG: 1, segments: [{ seconds: 0, toG: -3 }, { seconds: 6 }] });
    expect(model.output.redout).toBeGreaterThan(0.9);
    replay(model, sampleLoads(PROTOCOLS.rest(10), HZ), 1 / HZ, { keepState: true });
    expect(model.output.redout).toBe(0);
  });
});

describe.each(STATEFUL)("%s, which keeps the history of the load", (name, create) => {
  it("keeps state within its budget: 128 bytes for Exposure, 256 for Perfusion", () => {
    const model = create();
    expect(model.stateBytes).toBeLessThanOrEqual(model.kind === "exposure" ? 128 : 256);
  });

  it("takes a finite time to lose consciousness from rest, however high the load", () => {
    const at = (g: number) => firstEvent(run(create(), PROTOCOLS.sustained(g, 40)), "unconscious")?.seconds ?? Infinity;
    const extreme = at(20);
    expect(extreme).toBeGreaterThan(1 + 4);
    expect(extreme).toBeLessThan(1 + 15);
    // A load past what supply can meet has no faster way to empty the reserve.
    expect(at(15) - extreme).toBeLessThan(0.5);
  });

  it("is worse on a pull before it has recovered from the last", () => {
    // Pulls of 4 s, 3 g above what this pilot bears for 15 s.
    const g = threshold(create, "symptoms") + 3;
    const first = run(create(), PROTOCOLS.repeated(1, g, 4, 2));
    const rested = run(create(), PROTOCOLS.repeated(30, g, 4, 2));
    const peakAfter = (result: ReturnType<typeof run>, from: number, to: number) => {
      let peak = 0;
      const record = result.record!;
      for (let index = 0; index < record.seconds.length; index += 1) {
        const seconds = record.seconds[index]!;
        if (seconds > from && seconds <= to) {
          peak = Math.max(peak, visionClosure(record.peripheralLoss[index]!, record.centralLoss[index]!));
        }
      }
      return peak;
    };
    const recorded = (model: PilotResponseModel, protocol: LoadProtocol) =>
      replay(model, sampleLoads(protocol, HZ), 1 / HZ, { recordEvery: 1 });
    const close = recorded(create(), PROTOCOLS.repeated(1, g, 4, 2));
    const apart = recorded(create(), PROTOCOLS.repeated(30, g, 4, 2));
    // The second pull starts at 1 + 4 + 1 s, or 1 + 4 + 30 s.
    expect(peakAfter(close, 6, 10)).toBeGreaterThan(peakAfter(apart, 35, 39) + 0.02);
    expect(first.events.length).toBeGreaterThanOrEqual(rested.events.length);
  });

  // Gradual-onset tolerance runs above rapid-onset tolerance: the reflexes have
  // time to act. Burton's suited pilots bore a gradual onset 0.7–1.1 g better
  // (CGEM-R Table I). Perfusion's protected pilot falls short, a known gap
  // (docs/g-response-comparison.md): its effective suit pressure is sensed at
  // the carotid sinus and leaves the reflex little to do. Marked to fail until fixed.
  (name === "Perfusion, protected" ? it.fails : it)("shows symptoms at a higher load on a slow ramp than on a sudden pull, through compensation", () => {
    // The ramp's symptoms are read at the load they appear.
    const sudden = threshold(create, "symptoms");
    const slow = firstEvent(run(create(), PROTOCOLS.ramp(0.1, 14, 0)), "symptoms");
    expect(slow).not.toBeNull();
    expect(slow!.g).toBeGreaterThan(sudden + 0.3);
  });

  it("comes to later when the load comes off slowly, and only once the load allows", () => {
    // From +14 g, past what any of the pilots bears.
    const quick = firstEvent(run(create(), PROTOCOLS.unload(0.5, 14)), "conscious");
    const slow = firstEvent(run(create(), PROTOCOLS.unload(9, 14)), "conscious");
    expect(quick).not.toBeNull();
    expect(slow).not.toBeNull();
    expect(slow!.seconds).toBeGreaterThan(quick!.seconds + 1);
    // A pull during recovery holds the pilot out: no timer wakes them.
    const again = run(create(), PROTOCOLS.pullDuringRecovery(4, 12, 14));
    const awake = firstEvent(again, "conscious");
    expect(awake === null || awake.seconds > 1 + 20 + 4 + 10).toBe(true);
  });

  it("keeps its debts and the pilot's consciousness through a change of parameters", () => {
    const model = create();
    run(model, { id: "out", label: "out", startG: 1, segments: [{ seconds: 0, toG: 12 }, { seconds: 15 }] });
    const before = model.diagnostics();
    if (model instanceof ExposureResponse) model.configure({ ...model.profile, wakeDwellSeconds: 9 });
    if (model instanceof PerfusionResponse) model.configure({ ...model.profile, wakeDwellSeconds: 9 });
    expect(model.diagnostics()).toEqual(before);
    expect(model.output.conscious).toBe(false);
  });

  it("converges: at 30, 60 and 120 Hz it stays within 0.005 closure and one step of events of a 1 ms solution", () => {
    for (const hz of [30, 60, 120]) {
      const loads = sampleLoads(restless, hz);
      const coarse = replay(create(), loads, 1 / hz, { recordEvery: 1 });
      // The same held loads, each step cut into substeps of about a millisecond.
      const substeps = Math.round(1000 / hz);
      const fineLoads = new Float64Array(loads.length * substeps);
      for (let index = 0; index < fineLoads.length; index += 1) fineLoads[index] = loads[Math.floor(index / substeps)]!;
      const reference = replay(create(), fineLoads, 1 / (hz * substeps), { recordEvery: 1 });
      expect(coarse.events.map(event => event.kind)).toEqual(reference.events.map(event => event.kind));
      coarse.events.forEach((event, index) => {
        expect(Math.abs(event.seconds - reference.events[index]!.seconds)).toBeLessThanOrEqual(1 / hz + 1e-9);
      });
      let worst = 0;
      for (let index = 0; index < loads.length; index += 1) {
        const end = (index + 1) * substeps - 1;
        worst = Math.max(worst, Math.abs(
          visionClosure(coarse.record!.peripheralLoss[index]!, coarse.record!.centralLoss[index]!)
          - visionClosure(reference.record!.peripheralLoss[end]!, reference.record!.centralLoss[end]!)));
      }
      expect(worst).toBeLessThanOrEqual(0.005);
    }
  });
});

describe("protection and geometry", () => {
  it("lets a protected pilot bear a load that puts a relaxed one out", () => {
    for (const [relaxed, protectedPilot] of [
      [new ExposureResponse(EXPOSURE_RELAXED), new ExposureResponse(EXPOSURE_PROTECTED)],
      [new PerfusionResponse(PERFUSION_RELAXED), new PerfusionResponse(PERFUSION_PROTECTED)],
    ] as const) {
      expect(firstEvent(run(relaxed, PROTOCOLS.sustained(7, 30)), "unconscious")).not.toBeNull();
      expect(firstEvent(run(protectedPilot, PROTOCOLS.sustained(7, 30)), "unconscious")).toBeNull();
    }
  });

  it("bears more in a reclined seat, through the shorter column alone", () => {
    const upright = threshold(() => new PerfusionResponse(PERFUSION_RELAXED), "symptoms");
    const reclined = threshold(() => new PerfusionResponse({ ...PERFUSION_RELAXED, seatBackDeg: 30 }), "symptoms");
    expect(reclined).toBeGreaterThan(upright + 0.2);
  });
});
