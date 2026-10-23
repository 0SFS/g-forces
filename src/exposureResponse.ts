import type { NumberRange } from "foss-earth/settings";
import { SETTLE_TIME_CONSTANTS, share } from "./gForce.ts";
import {
  advanceBalance, clamp01, createOutput, lagKeep, settleToward, smoothRamp, type PilotResponseModel,
} from "./pilotResponse.ts";

/**
 * Exposure: bounded depletion and recovery. Two debts, one for the retina and
 * one for consciousness, fill while the effective load is above what the
 * pilot bears and are repaid below it. A debt carries over between pulls, so
 * a second pull before recovery impairs the pilot sooner, and filling is
 * bounded, so the time to lose consciousness from rest never falls below a
 * finite buffer however high the load.
 *
 * The effective load is the load less the pilot's protection and
 * compensation, plus a penalty for a recent load below +1 g (push–pull).
 * Compensation builds over seconds under a positive load, so a slow ramp is
 * borne better than a sudden pull. Straining is protection only while
 * conscious. Negative load closes a separate red level, from the original
 * thresholds: it is the least supported part of the model.
 *
 * This is a simulator reduction fitted to outcomes, not an equation from the
 * cited studies, and nothing in it is a blood pressure. Each debt follows
 *
 *   dD/dt = fill(x) - drain(x) * D,  fill = x / buffer,  drain = (1 - x) / recovery
 *
 * where x is how far the effective load lies across the debt's range, 0 to 1.
 * Over one step the load is held, so the update is exact for the debts;
 * compensation and push–pull memory change during the step and enter at their
 * mean, which is why convergence is measured rather than assumed.
 */

export interface ExposureProfile {
  /** Names the parameter set and its version, for saved settings and records. */
  id: string;
  /** Effective load, in g, at which retinal debt starts to fill (`min`), and at which filling is fastest and repayment stops (`max`). */
  retinaG: NumberRange;
  /** As `retinaG`, for consciousness. */
  brainG: NumberRange;
  /** Seconds a rested retina lasts at the fastest filling. */
  retinaBufferSeconds: number;
  /** Seconds a rested brain lasts at the fastest filling: the shortest time to lose consciousness. */
  brainBufferSeconds: number;
  /** Time constant, in seconds, of repaying retinal debt at rest. */
  retinaRecoverySeconds: number;
  /** Time constant, in seconds, of repaying consciousness debt at rest. */
  brainRecoverySeconds: number;
  /** Load, in g, borne by equipment such as a G-suit. */
  suitG: number;
  /** Load, in g, borne by straining, while conscious. */
  strainG: number;
  /** Load, in g, borne once the circulation has fully responded. */
  compensationG: number;
  /** The load, in g, at which compensation is fully called on; it starts above +1 g. */
  compensationFullG: number;
  /** Time constant, in seconds, of compensation building. */
  compensationRiseSeconds: number;
  /** Time constant, in seconds, of compensation falling away. */
  compensationFallSeconds: number;
  /** Load, in g, the pilot loses on the next pull after a full push. */
  pushPullG: number;
  /** The load, in g, below which the push–pull memory fills completely; it starts below +1 g. */
  pushPullFullG: number;
  /** Time constant, in seconds, of the memory filling under a push. */
  pushPullRiseSeconds: number;
  /** Time constant, in seconds, of the memory fading. */
  pushPullDecaySeconds: number;
  /** Retinal debt over which peripheral sight is lost. */
  peripheralDebt: NumberRange;
  /** Retinal debt over which central sight is lost. */
  centralDebt: NumberRange;
  /** Consciousness is lost at a debt of 1 and returns once the debt is back below this… */
  wakeDebt: number;
  /** …and has stayed below it, without rising, this many seconds: a pull during recovery holds the pilot out. */
  wakeDwellSeconds: number;
  /** Negative loads, in g, at which the red level is full (`min`) and starts (`max`). */
  redout: NumberRange;
  /** Seconds for the red level to follow a load that stays on, to within 5%. */
  redoutOnsetSeconds: number;
  /** Seconds for the red level to clear, to within 5%. */
  redoutRecoverySeconds: number;
}

// Fitted to the relaxed and protection fixtures whose role is "fit" in
// validation/evidence/g-response/ (W13 onset rates, W14 offset rates, WF15
// retinal timing, C54 thresholds, E07 protection); the rest are held out. The
// compensation and push–pull terms have no usable data yet and keep their
// mechanism-test values. Fit and results: docs/g-response-comparison.md.
// Relaxed: no suit, no straining.
export const EXPOSURE_RELAXED: ExposureProfile = {
  id: "exposure-relaxed@2",
  retinaG: { min: 2.3, max: 4.4 },
  brainG: { min: 3.25, max: 5.1 },
  retinaBufferSeconds: 9,
  brainBufferSeconds: 7.9,
  retinaRecoverySeconds: 4.1,
  brainRecoverySeconds: 2.8,
  suitG: 0,
  strainG: 0,
  compensationG: 0.8,
  compensationFullG: 4,
  compensationRiseSeconds: 6,
  compensationFallSeconds: 10,
  pushPullG: 1,
  pushPullFullG: -1,
  pushPullRiseSeconds: 1.5,
  pushPullDecaySeconds: 8,
  peripheralDebt: { min: 0.45, max: 0.99 },
  centralDebt: { min: 0.79, max: 1 },
  wakeDebt: 0.64,
  wakeDwellSeconds: 5.1,
  redout: { min: -3, max: -2 },
  redoutOnsetSeconds: 5,
  redoutRecoverySeconds: 2,
};

/**
 * A pilot in a G-suit who strains. The suit is sized to E07's ~2.9 g of
 * protection over the relaxed threshold, and straining to bring suit and
 * straining together just past E07's 8.9 g, where its runs stopped.
 */
export const EXPOSURE_PROTECTED: ExposureProfile = {
  ...EXPOSURE_RELAXED,
  id: "exposure-protected@2",
  suitG: 2.9,
  strainG: 1.9,
};

/** A pilot in a G-suit who does not strain. */
export const EXPOSURE_SUIT: ExposureProfile = { ...EXPOSURE_PROTECTED, id: "exposure-suit@2", strainG: 0 };

// State slots, in one Float64Array so its size is what it says.
const COMPENSATION = 0;
const PUSH_PULL = 1;
const RETINA = 2;
const BRAIN = 3;
const RED = 4;
const DWELL = 5;
const UNCONSCIOUS = 6;
const SLOTS = 7;

export class ExposureResponse implements PilotResponseModel {
  readonly kind = "exposure" as const;
  readonly output = createOutput();
  readonly #state = new Float64Array(SLOTS);
  #profile: ExposureProfile;
  // Lag factors for the last step length.
  #keptSeconds = Number.NaN;
  #keepCompensationRise = 0;
  #keepCompensationFall = 0;
  #keepPushPullRise = 0;
  #keepPushPullDecay = 0;
  #keepRedOnset = 0;
  #keepRedRecovery = 0;

  constructor(profile: ExposureProfile = EXPOSURE_PROTECTED) {
    this.#profile = profile;
  }

  get stateBytes(): number { return this.#state.byteLength; }

  get profile(): ExposureProfile { return this.#profile; }

  /** New parameters, keeping every debt, memory and the pilot's consciousness. */
  configure(profile: ExposureProfile): void {
    this.#profile = profile;
    this.#keptSeconds = Number.NaN;
    this.#publish();
  }

  reset(): void {
    this.#state.fill(0);
    this.#publish();
  }

  step(pilotG: number, simulatedSeconds: number): void {
    if (!(simulatedSeconds > 0)) return;
    const g = Number.isFinite(pilotG) ? pilotG : 1;
    const p = this.#profile;
    const s = this.#state;
    if (simulatedSeconds !== this.#keptSeconds) this.#keep(simulatedSeconds);

    const compensationBefore = s[COMPENSATION]!;
    const compensationTarget = share(g, 1, p.compensationFullG);
    s[COMPENSATION] = compensationTarget + (compensationBefore - compensationTarget)
      * (compensationTarget > compensationBefore ? this.#keepCompensationRise : this.#keepCompensationFall);
    const pushPullBefore = s[PUSH_PULL]!;
    const pushPullTarget = share(-g, -1, -p.pushPullFullG);
    s[PUSH_PULL] = pushPullTarget + (pushPullBefore - pushPullTarget)
      * (pushPullTarget > pushPullBefore ? this.#keepPushPullRise : this.#keepPushPullDecay);

    const conscious = s[UNCONSCIOUS] === 0;
    const effectiveG = g - p.suitG - (conscious ? p.strainG : 0)
      - p.compensationG * 0.5 * (compensationBefore + s[COMPENSATION]!)
      + p.pushPullG * 0.5 * (pushPullBefore + s[PUSH_PULL]!);
    s[RETINA] = debt(s[RETINA]!, share(effectiveG, p.retinaG.min, p.retinaG.max),
      p.retinaBufferSeconds, p.retinaRecoverySeconds, simulatedSeconds);
    const brainBefore = s[BRAIN]!;
    s[BRAIN] = debt(s[BRAIN]!, share(effectiveG, p.brainG.min, p.brainG.max),
      p.brainBufferSeconds, p.brainRecoverySeconds, simulatedSeconds);

    if (conscious) {
      if (s[BRAIN]! >= 1) { s[UNCONSCIOUS] = 1; s[DWELL] = 0; }
    } else if (s[BRAIN]! > p.wakeDebt || s[BRAIN]! > brainBefore) {
      s[DWELL] = 0;
    } else {
      s[DWELL] = s[DWELL]! + simulatedSeconds;
      if (s[DWELL]! >= p.wakeDwellSeconds) { s[UNCONSCIOUS] = 0; s[DWELL] = 0; }
    }

    const redTarget = share(-g, -p.redout.max, -p.redout.min);
    s[RED] = settleToward(s[RED]!, redTarget, redTarget > s[RED]! ? this.#keepRedOnset : this.#keepRedRecovery);
    this.#publish();
  }

  diagnostics(): Record<string, number> {
    const s = this.#state;
    return {
      compensation: s[COMPENSATION]!, pushPull: s[PUSH_PULL]!, retinaDebt: s[RETINA]!, brainDebt: s[BRAIN]!,
      redout: s[RED]!, wakeDwellSeconds: s[DWELL]!, unconscious: s[UNCONSCIOUS]!,
    };
  }

  #keep(seconds: number): void {
    const p = this.#profile;
    this.#keptSeconds = seconds;
    this.#keepCompensationRise = lagKeep(seconds, p.compensationRiseSeconds);
    this.#keepCompensationFall = lagKeep(seconds, p.compensationFallSeconds);
    this.#keepPushPullRise = lagKeep(seconds, p.pushPullRiseSeconds);
    this.#keepPushPullDecay = lagKeep(seconds, p.pushPullDecaySeconds);
    this.#keepRedOnset = lagKeep(seconds, p.redoutOnsetSeconds / SETTLE_TIME_CONSTANTS);
    this.#keepRedRecovery = lagKeep(seconds, p.redoutRecoverySeconds / SETTLE_TIME_CONSTANTS);
  }

  #publish(): void {
    const p = this.#profile;
    const s = this.#state;
    this.output.peripheralLoss = smoothRamp(s[RETINA]!, p.peripheralDebt.min, p.peripheralDebt.max);
    this.output.centralLoss = smoothRamp(s[RETINA]!, p.centralDebt.min, p.centralDebt.max);
    this.output.redout = s[RED]!;
    this.output.conscious = s[UNCONSCIOUS] === 0;
  }
}

/** One debt over a step at stress `x`: fills at x / buffer, drains at (1 - x) / recovery times the debt. */
function debt(d: number, x: number, bufferSeconds: number, recoverySeconds: number, seconds: number): number {
  const fill = bufferSeconds > 0 ? x / bufferSeconds : x > 0 ? Number.POSITIVE_INFINITY : 0;
  if (fill === Number.POSITIVE_INFINITY) return 1;
  const drain = recoverySeconds > 0 ? (1 - x) / recoverySeconds : 0;
  return clamp01(advanceBalance(d, fill, drain, seconds));
}
