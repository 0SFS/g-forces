import { SETTLED } from "./gForce.ts";

/**
 * What a load does to the pilot, as one of several interchangeable models.
 *
 * Each model takes the load at the pilot's seat once per accepted physics
 * step, for that step's simulated duration, and keeps its own state. They are
 * alternatives, not effects to stack: Curve is the original vignette with an
 * editable shape, Exposure keeps a few debts that fill under load and drain at
 * rest, and Perfusion follows pressure, flow and reserves. Which of them earn a
 * place is decided by measurement, not by their size: see
 * docs/g-response-comparison.md.
 *
 * Every model fills the same output, which the flight reads after each step
 * and draws with the existing vignette. The output object is reused: read it,
 * do not keep it as a record of an earlier step.
 */

export type PilotResponseKind = "curve" | "exposure" | "perfusion";

export interface PilotResponseOutput {
  /** Sight lost at the edges of the view: 0 clear, 1 only the centre left. */
  peripheralLoss: number;
  /** Sight lost at the centre of the view: 1 is blackout. */
  centralLoss: number;
  /** The red vignette of a negative load: 0 clear, 1 the whole view. */
  redout: number;
  /** False while the model holds the pilot unconscious. The flight acts on it only when passing out is on. */
  conscious: boolean;
}

export interface PilotResponseModel {
  readonly kind: PilotResponseKind;
  /** A stable view of the latest step, updated in place. */
  readonly output: Readonly<PilotResponseOutput>;
  /** Bytes of numbers the model keeps per pilot and changes as it runs. */
  readonly stateBytes: number;
  /** Advances `simulatedSeconds` at the load `pilotG`: 1 in level flight. No time, no change. */
  step(pilotG: number, simulatedSeconds: number): void;
  /** A rested, conscious pilot with clear sight. */
  reset(): void;
  /** The model's state by name, for diagnostics and tests. Allocates: never call it per step. */
  diagnostics(): Record<string, number>;
}

export function createOutput(): PilotResponseOutput {
  return { peripheralLoss: 0, centralLoss: 0, redout: 0, conscious: true };
}

export function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** 0 below `from`, 1 above `to`, and a smoothstep between, so neither end shows a corner. `from === to` is a step. */
export function smoothRamp(value: number, from: number, to: number): number {
  if (from >= to) return value >= to ? 1 : 0;
  const x = clamp01((value - from) / (to - from));
  return x * x * (3 - 2 * x);
}

/**
 * The share of a lag left after `seconds` with time constant `tau`: a level
 * that follows a fixed target moves `target + (level - target) * keep`. No
 * time constant follows at once.
 */
export function lagKeep(seconds: number, tau: number): number {
  return tau > 0 ? Math.exp(-seconds / tau) : 0;
}

/** `level` after a step that keeps `keep` of its gap to `target`; closer than SETTLED it is the target, so a settled level stops changing. */
export function settleToward(level: number, target: number, keep: number): number {
  const next = target + (level - target) * keep;
  return Math.abs(next - target) < SETTLED ? target : next;
}

/**
 * A level `d` that fills at `fill` per second and drains at `drain` times
 * itself per second, both held over `seconds`: the exact solution, with
 * `expm1` so a small step loses nothing to rounding.
 */
export function advanceBalance(d: number, fill: number, drain: number, seconds: number): number {
  if (drain > 0) return d + (fill / drain - d) * -Math.expm1(-drain * seconds);
  return d + fill * seconds;
}

/**
 * How far the vignette closes for a loss of sight. The vignette's clear middle
 * reaches the centre of the view at 10/17 of its travel (gVisionOverlay.css:
 * an edge of 100% plus a 70% feather), so peripheral loss spends that share
 * and central loss the rest. Central loss without peripheral loss still closes
 * the edges first: a dim centre with clear edges is not drawn.
 */
export const PERIPHERAL_CLOSURE = 10 / 17;

export function visionClosure(peripheralLoss: number, centralLoss: number): number {
  const central = clamp01(centralLoss);
  return PERIPHERAL_CLOSURE * Math.max(clamp01(peripheralLoss), central) + (1 - PERIPHERAL_CLOSURE) * central;
}

/** The losses that `visionClosure` draws as `closure`: the inverse for a single closing level. */
export function splitClosure(closure: number, into: PilotResponseOutput): void {
  const level = clamp01(closure);
  into.peripheralLoss = level >= PERIPHERAL_CLOSURE ? 1 : level / PERIPHERAL_CLOSURE;
  into.centralLoss = level <= PERIPHERAL_CLOSURE ? 0 : (level - PERIPHERAL_CLOSURE) / (1 - PERIPHERAL_CLOSURE);
}
