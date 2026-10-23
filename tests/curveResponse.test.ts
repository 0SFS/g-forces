import { describe, expect, it } from "vitest";
import { ALERT_PILOT, stepPilot, type GVisionSettings, type PassOutSettings, type PilotState } from "../src/gForce";
import { CurveResponse, curveProfile } from "../src/curveResponse";
import { visionClosure } from "../src/pilotResponse";

const SETTINGS: GVisionSettings = {
  blackout: { min: 5, max: 9 },
  redout: { min: -3, max: -2 },
  onsetSeconds: 5,
  recoverySeconds: 2,
};
const PASS_OUT: PassOutSettings = { meanSeconds: 11.9, spreadSeconds: 4 };

/** A small seeded generator (mulberry32), so both sides draw the same numbers. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A load that pulls hard, pushes, holds and rests: 90 s at 120 Hz. */
const mixedLoad = (step: number): number => {
  const t = step / 120;
  if (t < 20) return 1 + 9 * Math.min(1, t / 3);
  if (t < 25) return -2.6;
  if (t < 40) return 1 + 6 * Math.abs(Math.sin(t));
  if (t < 60) return 9.5;
  return 1;
};

describe("Curve", () => {
  it("steps exactly as the original pilot with a linear shape, passing out included", () => {
    const random = seeded(3);
    const legacyRandom = seeded(3);
    const model = new CurveResponse(curveProfile(SETTINGS), PASS_OUT, random);
    let legacy: PilotState = ALERT_PILOT;
    let outs = 0;
    for (let step = 0; step < 90 * 120; step += 1) {
      const g = mixedLoad(step);
      model.step(g, 1 / 120);
      const wasOut = legacy.secondsOut > 0;
      legacy = stepPilot(legacy, g, 1 / 120, SETTINGS, PASS_OUT, legacyRandom);
      if (!wasOut && legacy.secondsOut > 0) outs += 1;
      const state = model.diagnostics();
      expect(state.blackout).toBe(legacy.vision.blackout);
      expect(state.redout).toBe(legacy.vision.redout);
      expect(state.secondsOut).toBe(legacy.secondsOut);
      expect(model.output.conscious).toBe(legacy.secondsOut === 0);
      expect(visionClosure(model.output.peripheralLoss, model.output.centralLoss)).toBeCloseTo(legacy.vision.blackout, 12);
    }
    expect(outs).toBeGreaterThan(0);
  });

  it("keeps its ends exact and bends between them: below 1 closes early, above 1 late", () => {
    const settled = (exponent: number, g: number) => {
      const model = new CurveResponse({ ...curveProfile(SETTINGS, exponent), onsetSeconds: 0 });
      model.step(g, 1 / 60);
      return model.diagnostics().blackout;
    };
    expect(settled(0.5, 7)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(settled(2, 7)).toBeCloseTo(0.25, 12);
    for (const exponent of [0.25, 0.5, 2, 4]) {
      expect(settled(exponent, 5)).toBe(0);
      expect(settled(exponent, 9)).toBe(1);
      expect(settled(exponent, 12)).toBe(1);
    }
    const redout = new CurveResponse({ ...curveProfile(SETTINGS, 1, 2), onsetSeconds: 0 });
    redout.step(-2.5, 1 / 60);
    expect(redout.output.redout).toBeCloseTo(0.25, 12);
  });

  it("still closes at once at a threshold whose ends are the same load", () => {
    const model = new CurveResponse({ ...curveProfile({ ...SETTINGS, blackout: { min: 6, max: 6 } }, 3), onsetSeconds: 0 });
    model.step(5.99, 1 / 60);
    expect(model.diagnostics().blackout).toBe(0);
    model.step(6, 1 / 60);
    expect(model.diagnostics().blackout).toBe(1);
  });

  it("wakes a pilot who is out when passing out is turned off, and keeps the levels through a change of settings", () => {
    const model = new CurveResponse(curveProfile(SETTINGS), { meanSeconds: 10, spreadSeconds: 0 });
    for (let step = 0; step < 20 * 60; step += 1) model.step(10, 1 / 60);
    expect(model.output.conscious).toBe(false);
    model.configure(curveProfile({ ...SETTINGS, recoverySeconds: 4 }), { meanSeconds: 10, spreadSeconds: 0 });
    expect(model.output.conscious).toBe(false);
    model.configure(curveProfile(SETTINGS), null);
    expect(model.output.conscious).toBe(true);
    expect(model.diagnostics().blackout).toBe(1);
  });
});
