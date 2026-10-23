import type { NumberRange } from "foss-earth/settings";
import { SETTLE_TIME_CONSTANTS, share } from "./gForce.ts";
import {
  advanceBalance, clamp01, createOutput, lagKeep, settleToward, smoothRamp, type PilotResponseModel,
} from "./pilotResponse.ts";

/**
 * Perfusion: reduced pressure, flow and reserve dynamics. A positive load
 * lowers the pressure at the eye and the brain by the height of blood above
 * the heart. Each site's flow follows its perfusion pressure, and each draws
 * on a reserve that covers a few seconds of demand and refills once flow
 * returns. Sight fails as the retinal reserves run out, the periphery first,
 * and consciousness as the brain's does. Nothing is a timer: the pilot comes
 * to once the brain's reserve has refilled and stayed refilled.
 *
 * The circulation answers a fall in pressure at the carotid sinus within
 * limits: the heart quickly, the vessels slowly. Straining raises the
 * pressure while the pilot is conscious, and a G-suit by a schedule of load,
 * each through the same heart-level pressure, so no protection is counted
 * twice. A push lowers the vessels' tone, which is slow to return, so the next
 * pull starts behind: the push–pull effect is that memory, not a penalty
 * added on top.
 *
 * Pressures are in mmHg, heights in cm, times in seconds. The load is the
 * scalar pilot load along the body's long axis (Gz), +1 in level flight; the
 * seat-back angle shortens each column by its cosine and no other axis is
 * modelled. Negative load closes a separate red level from the original
 * thresholds: redout physiology is poorly understood, and the hydrostatic
 * equation is not run backwards to invent it.
 *
 * Over one step the load is held. Pressure lags are exact for their held
 * targets; each reserve is exact for the mean of the flows at the start and
 * end of the step, a second-order update.
 */

export interface PerfusionProfile {
  /** Names the parameter set and its version, for saved settings and records. */
  id: string;
  /** Systolic pressure at heart level at +1 g, rested, in mmHg: it decides whether vessels open in each beat. */
  heartMmHg: number;
  /** Height of the eye above the heart along the body, in cm. */
  eyeCm: number;
  /** Height above the heart, in cm, of the brain's supply. */
  brainCm: number;
  /** Height of the carotid sinus above the heart, in cm: where the pressure reflex senses the load. */
  carotidCm: number;
  /** The seat back's tilt from upright, in degrees; each height counts by its cosine. */
  seatBackDeg: number;
  /** Pressure inside the eye, in mmHg: retinal vessels close below it. */
  intraocularMmHg: number;
  /** Further pressure the peripheral retina needs over the central, in mmHg. */
  peripheralRetinaMmHg: number;
  /** Pressure around the brain's vessels, in mmHg: below zero for the siphon of the veins draining it. */
  cerebralSurroundMmHg: number;
  /** Perfusion pressure, in mmHg, that gives the retina its full flow. */
  retinaFullFlowMmHg: number;
  /** Perfusion pressure, in mmHg, that gives the brain its full flow. */
  brainFullFlowMmHg: number;
  /** Seconds of demand a full retinal reserve covers without flow. */
  retinaReserveSeconds: number;
  /** Seconds of demand a full brain reserve covers without flow. */
  brainReserveSeconds: number;
  /** Extra flow a depleted reserve draws to refill, as a share of normal flow when empty. */
  refillGain: number;
  /** Heart rate and output: mmHg of pressure per mmHg of fall sensed, its limits, and its time constant. */
  cardiacGain: number;
  cardiacMmHg: NumberRange;
  cardiacSeconds: number;
  /** Vessel tone: as the heart, slower to build than to fall. */
  vascularGain: number;
  vascularMmHg: NumberRange;
  vascularRiseSeconds: number;
  vascularFallSeconds: number;
  /** Straining: mmHg added at heart level, the load at which the pilot starts, and how fast it builds. */
  strainMmHg: number;
  strainStartG: number;
  strainSeconds: number;
  /** G-suit: mmHg of heart-level pressure per g above the valve's opening load, its limit, and the inflation time constant. */
  suitMmHgPerG: number;
  suitStartG: number;
  suitMaxMmHg: number;
  suitSeconds: number;
  /** Depletion of the retinal reserves (1 - reserve) over which peripheral and central sight are lost. */
  peripheralDeficit: NumberRange;
  centralDeficit: NumberRange;
  /** Consciousness is lost when the brain's reserve is empty and returns once it is back above this… */
  wakeReserve: number;
  /** …and has stayed above it this many seconds. */
  wakeDwellSeconds: number;
  /** Negative loads, in g, at which the red level is full (`min`) and starts (`max`). */
  redout: NumberRange;
  redoutOnsetSeconds: number;
  redoutRecoverySeconds: number;
}

// Fitted to the relaxed and protection fixtures whose role is "fit" in
// validation/evidence/g-response/ (W13 onset rates, W14 offset rates, WF15
// retinal timing, C54 thresholds, E07 protection), within physiological
// ranges; the rest are held out. The heart, reflex and redout values are not
// fitted. Fit and results: docs/g-response-comparison.md. Relaxed: upright,
// no suit, no straining.
export const PERFUSION_RELAXED: PerfusionProfile = {
  id: "perfusion-relaxed@2",
  heartMmHg: 120,
  eyeCm: 30,
  brainCm: 36,
  carotidCm: 20,
  seatBackDeg: 0,
  intraocularMmHg: 21,
  peripheralRetinaMmHg: 4.2,
  cerebralSurroundMmHg: -11.5,
  retinaFullFlowMmHg: 60,
  brainFullFlowMmHg: 56,
  retinaReserveSeconds: 9,
  brainReserveSeconds: 8,
  refillGain: 2.1,
  cardiacGain: 0.6,
  cardiacMmHg: { min: -15, max: 20 },
  cardiacSeconds: 2,
  vascularGain: 0.6,
  vascularMmHg: { min: -15, max: 15 },
  vascularRiseSeconds: 7,
  vascularFallSeconds: 2,
  strainMmHg: 0,
  strainStartG: 3,
  strainSeconds: 0.5,
  suitMmHgPerG: 0,
  suitStartG: 1,
  suitMaxMmHg: 0,
  suitSeconds: 0.7,
  peripheralDeficit: { min: 0.46, max: 0.98 },
  centralDeficit: { min: 0.7, max: 1 },
  wakeReserve: 0.44,
  wakeDwellSeconds: 4,
  redout: { min: -3, max: -2 },
  redoutOnsetSeconds: 5,
  redoutRecoverySeconds: 2,
};

/**
 * A pilot in a G-suit who strains. The suit follows CGEM's schedule, rising
 * linearly from 1 g, but its gain is effective, not physical: sized to E07's
 * ~2.9 g of protection, it is about 1.7 times CGEM's 72 mmHg, because the
 * reflex here answers the added pressure and the suit's lift of the heart is
 * not modelled. Straining is sized to bring both just past E07's 8.9 g.
 */
export const PERFUSION_PROTECTED: PerfusionProfile = {
  ...PERFUSION_RELAXED,
  id: "perfusion-protected@2",
  strainMmHg: 35,
  suitMmHgPerG: 15.2,
  suitMaxMmHg: 121,
};

/** A pilot in a G-suit who does not strain. */
export const PERFUSION_SUIT: PerfusionProfile = { ...PERFUSION_PROTECTED, id: "perfusion-suit@2", strainMmHg: 0 };

/** Pressure of a 1 cm column of blood (1060 kg/m³) under 1 g, in mmHg. */
export const MMHG_PER_CM_G = 1060 * 9.80665 * 0.01 / 133.322;

const CARDIAC = 0;
const VASCULAR = 1;
const STRAIN = 2;
const SUIT = 3;
const PERIPHERAL = 4;
const CENTRAL = 5;
const BRAIN = 6;
const RED = 7;
const DWELL = 8;
const UNCONSCIOUS = 9;
const SLOTS = 10;

/** The model's compiled constants: column pressures per g, after the seat's tilt. */
interface Columns {
  eye: number;
  brain: number;
  carotid: number;
}

export class PerfusionResponse implements PilotResponseModel {
  readonly kind = "perfusion" as const;
  readonly output = createOutput();
  readonly #state = new Float64Array(SLOTS);
  #profile: PerfusionProfile;
  #columns: Columns = { eye: 0, brain: 0, carotid: 0 };
  #keptSeconds = Number.NaN;
  #keepCardiac = 0;
  #keepVascularRise = 0;
  #keepVascularFall = 0;
  #keepStrain = 0;
  #keepSuit = 0;
  #keepRedOnset = 0;
  #keepRedRecovery = 0;
  // Flows at the start of a step, kept between the two halves of the update.
  #flowPeripheral = 1;
  #flowCentral = 1;
  #flowBrain = 1;

  constructor(profile: PerfusionProfile = PERFUSION_PROTECTED) {
    this.#profile = profile;
    this.#compile();
    this.reset();
  }

  get stateBytes(): number { return this.#state.byteLength; }

  get profile(): PerfusionProfile { return this.#profile; }

  /** New parameters, keeping every pressure, reserve and the pilot's consciousness. */
  configure(profile: PerfusionProfile): void {
    this.#profile = profile;
    this.#compile();
    this.#publish();
  }

  reset(): void {
    const s = this.#state;
    s.fill(0);
    s[PERIPHERAL] = 1;
    s[CENTRAL] = 1;
    s[BRAIN] = 1;
    this.#flowPeripheral = this.#flowCentral = this.#flowBrain = 1;
    this.#publish();
  }

  step(pilotG: number, simulatedSeconds: number): void {
    if (!(simulatedSeconds > 0)) return;
    const g = Number.isFinite(pilotG) ? pilotG : 1;
    const p = this.#profile;
    const s = this.#state;
    if (simulatedSeconds !== this.#keptSeconds) this.#keep(simulatedSeconds);

    // Flows at the start of the step.
    this.#flows(this.#heart(), g);
    const peripheralBefore = this.#flowPeripheral;
    const centralBefore = this.#flowCentral;
    const brainBefore = this.#flowBrain;

    // Straining and the suit follow the load alone, so they go first, and the
    // carotid sinus senses the pressure they leave: the reflex then answers
    // this step's protection, not the last step's.
    const strainTarget = s[UNCONSCIOUS] === 0 && g >= p.strainStartG ? 1 : 0;
    s[STRAIN] = strainTarget + (s[STRAIN]! - strainTarget) * this.#keepStrain;
    const suitTarget = Math.min(p.suitMaxMmHg, Math.max(0, (g - p.suitStartG) * p.suitMmHgPerG));
    s[SUIT] = suitTarget + (s[SUIT]! - suitTarget) * this.#keepSuit;
    const sensed = this.#columns.carotid * (g - 1) - (this.#heart() - p.heartMmHg);

    const cardiacTarget = clampRange(p.cardiacGain * sensed, p.cardiacMmHg);
    s[CARDIAC] = cardiacTarget + (s[CARDIAC]! - cardiacTarget) * this.#keepCardiac;
    const vascularTarget = clampRange(p.vascularGain * sensed, p.vascularMmHg);
    s[VASCULAR] = vascularTarget + (s[VASCULAR]! - vascularTarget)
      * (vascularTarget > s[VASCULAR]! ? this.#keepVascularRise : this.#keepVascularFall);

    this.#flows(this.#heart(), g);
    s[PERIPHERAL] = reserve(s[PERIPHERAL]!, 0.5 * (peripheralBefore + this.#flowPeripheral),
      p.retinaReserveSeconds, p.refillGain, simulatedSeconds);
    s[CENTRAL] = reserve(s[CENTRAL]!, 0.5 * (centralBefore + this.#flowCentral),
      p.retinaReserveSeconds, p.refillGain, simulatedSeconds);
    s[BRAIN] = reserve(s[BRAIN]!, 0.5 * (brainBefore + this.#flowBrain),
      p.brainReserveSeconds, p.refillGain, simulatedSeconds);

    if (s[UNCONSCIOUS] === 0) {
      if (s[BRAIN]! <= 0) { s[UNCONSCIOUS] = 1; s[DWELL] = 0; }
    } else if (s[BRAIN]! < p.wakeReserve) {
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
    const heart = this.#heart();
    return {
      heartMmHg: heart,
      cardiacMmHg: s[CARDIAC]!, vascularMmHg: s[VASCULAR]!, strain: s[STRAIN]!, suitMmHg: s[SUIT]!,
      peripheralReserve: s[PERIPHERAL]!, centralReserve: s[CENTRAL]!, brainReserve: s[BRAIN]!,
      peripheralFlow: this.#flowPeripheral, centralFlow: this.#flowCentral, brainFlow: this.#flowBrain,
      redout: s[RED]!, wakeDwellSeconds: s[DWELL]!, unconscious: s[UNCONSCIOUS]!,
    };
  }

  /** Pressure at heart level now, in mmHg. */
  #heart(): number {
    const p = this.#profile;
    const s = this.#state;
    return p.heartMmHg + s[CARDIAC]! + s[VASCULAR]! + s[STRAIN]! * p.strainMmHg + s[SUIT]!;
  }

  /** Each site's flow, as a share of full flow, for a heart-level pressure and load. */
  #flows(heart: number, g: number): void {
    const p = this.#profile;
    const eye = heart - this.#columns.eye * g - p.intraocularMmHg;
    this.#flowCentral = clamp01(eye / p.retinaFullFlowMmHg);
    this.#flowPeripheral = clamp01((eye - p.peripheralRetinaMmHg) / p.retinaFullFlowMmHg);
    this.#flowBrain = clamp01((heart - this.#columns.brain * g - p.cerebralSurroundMmHg) / p.brainFullFlowMmHg);
  }

  #compile(): void {
    const p = this.#profile;
    const perG = MMHG_PER_CM_G * Math.cos(p.seatBackDeg * Math.PI / 180);
    this.#columns = { eye: p.eyeCm * perG, brain: p.brainCm * perG, carotid: p.carotidCm * perG };
    this.#keptSeconds = Number.NaN;
  }

  #keep(seconds: number): void {
    const p = this.#profile;
    this.#keptSeconds = seconds;
    this.#keepCardiac = lagKeep(seconds, p.cardiacSeconds);
    this.#keepVascularRise = lagKeep(seconds, p.vascularRiseSeconds);
    this.#keepVascularFall = lagKeep(seconds, p.vascularFallSeconds);
    this.#keepStrain = lagKeep(seconds, p.strainSeconds);
    this.#keepSuit = lagKeep(seconds, p.suitSeconds);
    this.#keepRedOnset = lagKeep(seconds, p.redoutOnsetSeconds / SETTLE_TIME_CONSTANTS);
    this.#keepRedRecovery = lagKeep(seconds, p.redoutRecoverySeconds / SETTLE_TIME_CONSTANTS);
  }

  #publish(): void {
    const p = this.#profile;
    const s = this.#state;
    this.output.peripheralLoss = smoothRamp(1 - s[PERIPHERAL]!, p.peripheralDeficit.min, p.peripheralDeficit.max);
    this.output.centralLoss = smoothRamp(1 - s[CENTRAL]!, p.centralDeficit.min, p.centralDeficit.max);
    this.output.redout = s[RED]!;
    this.output.conscious = s[UNCONSCIOUS] === 0;
  }
}

function clampRange(value: number, range: NumberRange): number {
  return value <= range.min ? range.min : value >= range.max ? range.max : value;
}

/**
 * A reserve over a step at flow `flow` (share of full): demand drains it at
 * 1/capacity a second, and flow supplies (1 + gain × depletion)/capacity, so a
 * depleted reserve refills under full flow and a full one holds.
 */
function reserve(level: number, flow: number, capacitySeconds: number, gain: number, seconds: number): number {
  if (!(capacitySeconds > 0)) return flow * (1 + gain) >= 1 ? 1 : 0;
  const fill = (flow * (1 + gain) - 1) / capacitySeconds;
  const drain = flow * gain / capacitySeconds;
  return clamp01(advanceBalance(level, fill, drain, seconds));
}
