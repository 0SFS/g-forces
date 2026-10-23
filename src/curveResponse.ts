import {
  drawSecondsOut, SETTLE_TIME_CONSTANTS, SETTLED, share, type GVisionSettings, type PassOutSettings,
} from "./gForce.ts";
import { createOutput, splitClosure, type PilotResponseModel } from "./pilotResponse.ts";

/**
 * Curve: the original vignette, with an editable shape. Each vignette settles
 * where the load puts it between two thresholds and follows with a first-order
 * lag, faster to clear than to close. The shape between the thresholds is a
 * power: 1 is the original straight line, below 1 closes early, above 1 late.
 *
 * It has no memory of earlier loads beyond the two levels, and no separate
 * consciousness: it is kept as the control the other models are compared
 * with. Passing out is the original rule, kept for compatibility, not as
 * physiology: the pilot goes out when the black level reaches 1, which a lag
 * only does by snapping to its target, and stays out for a time drawn at
 * random.
 *
 * With both exponents 1 it steps exactly as `stepPilot` in gForce.ts.
 */

export interface CurveProfile extends GVisionSettings {
  /** The shape of the blackout between its thresholds: 1 is linear. */
  blackoutExponent: number;
  /** The shape of the redout between its thresholds: 1 is linear. */
  redoutExponent: number;
}

/** Exponents the editor offers: a quarter rises early and four late; both ends stay exact. */
export const CURVE_EXPONENT_BOUNDS = { min: 0.25, max: 4 } as const;

export function curveProfile(settings: GVisionSettings, blackoutExponent = 1, redoutExponent = 1): CurveProfile {
  return { ...settings, blackoutExponent, redoutExponent };
}

function shape(level: number, exponent: number): number {
  return exponent === 1 || level === 0 || level === 1 ? level : level ** exponent;
}

export class CurveResponse implements PilotResponseModel {
  readonly kind = "curve" as const;
  readonly output = createOutput();
  /** The two levels and the time left out. */
  readonly stateBytes = 3 * 8;
  #profile: CurveProfile;
  #passOut: PassOutSettings | null;
  readonly #random: () => number;
  #blackout = 0;
  #redout = 0;
  #secondsOut = 0;
  // The lag over the last step length, kept: a fixed step pays for its exponentials once.
  #keptSeconds = Number.NaN;
  #keepOnset = 0;
  #keepRecovery = 0;

  constructor(profile: CurveProfile, passOut: PassOutSettings | null = null, random: () => number = Math.random) {
    this.#profile = profile;
    this.#passOut = passOut;
    this.#random = random;
  }

  /**
   * New settings, keeping the levels and the time out. Passing out turned off
   * wakes a pilot who is out, with sight returning from where it is.
   */
  configure(profile: CurveProfile, passOut: PassOutSettings | null): void {
    this.#profile = profile;
    this.#passOut = passOut;
    this.#keptSeconds = Number.NaN;
    if (!passOut) this.#secondsOut = 0;
    this.#publish();
  }

  reset(): void {
    this.#blackout = 0;
    this.#redout = 0;
    this.#secondsOut = 0;
    this.#publish();
  }

  step(pilotG: number, simulatedSeconds: number): void {
    if (!(simulatedSeconds > 0)) return;
    if (this.#secondsOut >= simulatedSeconds) {
      this.#secondsOut -= simulatedSeconds;
      this.#publish();
      return;
    }
    const seconds = simulatedSeconds - this.#secondsOut;
    const g = Number.isFinite(pilotG) ? pilotG : 1;
    const profile = this.#profile;
    if (seconds !== this.#keptSeconds) {
      this.#keptSeconds = seconds;
      this.#keepOnset = profile.onsetSeconds > 0 ? Math.exp(-seconds * SETTLE_TIME_CONSTANTS / profile.onsetSeconds) : 0;
      this.#keepRecovery = profile.recoverySeconds > 0
        ? Math.exp(-seconds * SETTLE_TIME_CONSTANTS / profile.recoverySeconds) : 0;
    }
    this.#blackout = this.#follow(this.#blackout,
      shape(share(g, profile.blackout.min, profile.blackout.max), profile.blackoutExponent));
    this.#redout = this.#follow(this.#redout,
      shape(share(-g, -profile.redout.max, -profile.redout.min), profile.redoutExponent));
    this.#secondsOut = this.#passOut && this.#blackout >= 1 ? drawSecondsOut(this.#passOut, this.#random) : 0;
    this.#publish();
  }

  diagnostics(): Record<string, number> {
    return { blackout: this.#blackout, redout: this.#redout, secondsOut: this.#secondsOut };
  }

  #follow(level: number, target: number): number {
    const onset = target > level;
    if ((onset ? this.#profile.onsetSeconds : this.#profile.recoverySeconds) <= 0) return target;
    const next = target + (level - target) * (onset ? this.#keepOnset : this.#keepRecovery);
    return Math.abs(next - target) < SETTLED ? target : next;
  }

  #publish(): void {
    splitClosure(this.#blackout, this.output);
    this.output.redout = this.#redout;
    this.output.conscious = this.#secondsOut === 0;
  }
}
