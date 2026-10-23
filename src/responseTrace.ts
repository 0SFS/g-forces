import type { PilotResponseModel } from "./pilotResponse.ts";

/**
 * Deterministic replay of a load history through any pilot response model:
 * the same accepted-step trace for every candidate, and the events read from
 * their outputs by one set of definitions. Tests, the comparison and the
 * benchmark use it; so will a temporal preview.
 *
 * A protocol is a load against time, in straight segments. A trace samples it
 * once per accepted physics step at the step's midpoint and holds that load
 * over the step, as the flight holds the step's reading. A pulse whose edges
 * fall on step edges is then exact; one that does not loses or gains part of a
 * step, which is what a coarse physics rate does to a short load.
 *
 * A published protocol often depends on the pilot: the load is held until
 * consciousness is lost, then taken off at a set rate. A staged protocol says
 * so: each stage may end at an event, and the next starts from the load held
 * then.
 */

export interface LoadSegment {
  /** How long the segment lasts, in seconds. Zero with `toG` is a jump. */
  seconds?: number;
  /** The load at its end, in g, reached in a straight line from the load before. Omitted, the load holds. */
  toG?: number;
  /** Instead of `seconds`, with `toG`: how fast the load moves there, in g per second. */
  gPerSecond?: number;
}

export interface LoadProtocol {
  id: string;
  label: string;
  /** The load, in g, before the first segment. */
  startG: number;
  segments: readonly LoadSegment[];
}

/** How long `segment` lasts when it starts at `fromG`. */
function segmentSeconds(segment: LoadSegment, fromG: number): number {
  if (segment.gPerSecond !== undefined && segment.toG !== undefined) return Math.abs(segment.toG - fromG) / segment.gPerSecond;
  return segment.seconds ?? 0;
}

export function protocolSeconds(protocol: LoadProtocol): number {
  let g = protocol.startG;
  let total = 0;
  for (const segment of protocol.segments) {
    total += segmentSeconds(segment, g);
    g = segment.toG ?? g;
  }
  return total;
}

/** The protocol's load at `seconds`; before the start and after the end it holds the nearest end's load. */
export function loadAt(protocol: LoadProtocol, seconds: number): number {
  let g = protocol.startG;
  let start = 0;
  for (const segment of protocol.segments) {
    const to = segment.toG ?? g;
    const length = segmentSeconds(segment, g);
    if (seconds < start + length) {
      return seconds <= start ? g : g + (to - g) * (seconds - start) / length;
    }
    start += length;
    g = to;
  }
  return g;
}

/**
 * One load per accepted step at `hz`: the protocol at each step's midpoint,
 * `phaseSeconds` later. The trace covers the protocol's whole steps.
 */
export function sampleLoads(protocol: LoadProtocol, hz: number, phaseSeconds = 0): Float64Array {
  const steps = Math.round(protocolSeconds(protocol) * hz);
  const loads = new Float64Array(steps);
  for (let step = 0; step < steps; step += 1) loads[step] = loadAt(protocol, (step + 0.5) / hz + phaseSeconds);
  return loads;
}

/** Joins protocols end to end; each starts from the load the one before it ends at. */
export function chain(id: string, label: string, ...parts: readonly LoadProtocol[]): LoadProtocol {
  const segments: LoadSegment[] = [];
  let g = parts[0]?.startG ?? 1;
  for (const part of parts) {
    if (part.startG !== g) segments.push({ seconds: 0, toG: part.startG });
    segments.push(...part.segments);
    g = part.segments.reduce((at, segment) => segment.toG ?? at, part.startG);
  }
  return { id, label, startG: parts[0]?.startG ?? 1, segments };
}

export type ResponseEventKind = "symptoms" | "field-clear" | "vision-lost" | "vision-returned" | "unconscious" | "conscious";

export interface ResponseEvent {
  kind: ResponseEventKind;
  /** The end of the first step whose output shows it, in simulated seconds from the trace's start. */
  seconds: number;
  /** The load held over that step. */
  g: number;
}

/**
 * The event definitions, shared by every model. Symptoms: peripheral loss
 * reaches 10%; the field is clear again once it is back under 2%, and symptoms
 * may then be counted again. Sight lost: central loss reaches 95%; returned:
 * back under 5%. Consciousness: the model's own flag.
 */
export const EVENT_LEVELS = { symptoms: 0.1, symptomsClear: 0.02, visionLost: 0.95, visionReturned: 0.05 } as const;

export interface ReplayRecord {
  seconds: Float64Array;
  g: Float64Array;
  peripheralLoss: Float64Array;
  centralLoss: Float64Array;
  redout: Float64Array;
  conscious: Uint8Array;
}

export interface ReplayResult {
  events: ResponseEvent[];
  /** The model's state at the end, by name. */
  final: Record<string, number>;
  /** Every `recordEvery`th step's output, when asked for. */
  record: ReplayRecord | null;
}

export interface ReplayOptions {
  /** Record the output every this many steps; 0 records nothing. */
  recordEvery?: number;
  /** Leave the model as it is instead of resetting it first: for a trace that continues an earlier one. */
  keepState?: boolean;
}

/** Reads the events from a model's output after each step, by the definitions above. */
class EventReader {
  readonly events: ResponseEvent[] = [];
  readonly #out: PilotResponseModel["output"];
  #symptomsArmed: boolean;
  #sightLost: boolean;
  #conscious: boolean;

  constructor(out: PilotResponseModel["output"]) {
    this.#out = out;
    this.#symptomsArmed = out.peripheralLoss <= EVENT_LEVELS.symptomsClear;
    this.#sightLost = out.centralLoss >= EVENT_LEVELS.visionLost;
    this.#conscious = out.conscious;
  }

  /** Reads the step that ended at `seconds` with `g` held; true when it showed an event of `kind`. */
  read(seconds: number, g: number, kind?: ResponseEventKind): boolean {
    const out = this.#out;
    const before = this.events.length;
    if (this.#symptomsArmed && out.peripheralLoss >= EVENT_LEVELS.symptoms) {
      this.events.push({ kind: "symptoms", seconds, g });
      this.#symptomsArmed = false;
    } else if (!this.#symptomsArmed && out.peripheralLoss <= EVENT_LEVELS.symptomsClear) {
      this.events.push({ kind: "field-clear", seconds, g });
      this.#symptomsArmed = true;
    }
    if (!this.#sightLost && out.centralLoss >= EVENT_LEVELS.visionLost) {
      this.events.push({ kind: "vision-lost", seconds, g });
      this.#sightLost = true;
    } else if (this.#sightLost && out.centralLoss <= EVENT_LEVELS.visionReturned) {
      this.events.push({ kind: "vision-returned", seconds, g });
      this.#sightLost = false;
    }
    if (out.conscious !== this.#conscious) {
      this.#conscious = out.conscious;
      this.events.push({ kind: out.conscious ? "conscious" : "unconscious", seconds, g });
    }
    for (let index = before; index < this.events.length; index += 1) if (this.events[index]!.kind === kind) return true;
    return false;
  }
}

/** Steps `model` through `loads`, one accepted step of `stepSeconds` each, and reads the events from its output. */
export function replay(
  model: PilotResponseModel,
  loads: ArrayLike<number>,
  stepSeconds: number,
  options: ReplayOptions = {},
): ReplayResult {
  if (!options.keepState) model.reset();
  const out = model.output;
  const every = Math.max(0, Math.floor(options.recordEvery ?? 0));
  const size = every > 0 ? Math.ceil(loads.length / every) : 0;
  const record: ReplayRecord | null = every > 0 ? {
    seconds: new Float64Array(size), g: new Float64Array(size), peripheralLoss: new Float64Array(size),
    centralLoss: new Float64Array(size), redout: new Float64Array(size), conscious: new Uint8Array(size),
  } : null;
  const reader = new EventReader(out);
  for (let step = 0; step < loads.length; step += 1) {
    const g = loads[step]!;
    model.step(g, stepSeconds);
    const seconds = (step + 1) * stepSeconds;
    reader.read(seconds, g);
    if (record && step % every === 0) {
      const at = step / every;
      record.seconds[at] = seconds;
      record.g[at] = g;
      record.peripheralLoss[at] = out.peripheralLoss;
      record.centralLoss[at] = out.centralLoss;
      record.redout[at] = out.redout;
      record.conscious[at] = out.conscious ? 1 : 0;
    }
  }
  return { events: reader.events, final: model.diagnostics(), record };
}

export interface ProtocolStage {
  segments: readonly LoadSegment[];
  /** Ends the stage at the first step that shows this event; the next stage starts from the load held then. */
  until?: ResponseEventKind;
}

/** A protocol whose stages may end at the pilot's events, as published protocols do. */
export interface StagedProtocol {
  id: string;
  label: string;
  startG: number;
  stages: readonly ProtocolStage[];
}

/**
 * Replays a staged protocol from rest at `hz`, sampling each stage as
 * `sampleLoads` samples a protocol, from the step it starts at. A stage that
 * waits for an event that never comes runs to the end of its segments.
 */
export function replayStages(model: PilotResponseModel, protocol: StagedProtocol, hz: number): ReplayResult {
  model.reset();
  const reader = new EventReader(model.output);
  const stepSeconds = 1 / hz;
  let step = 0;
  let g = protocol.startG;
  for (const stage of protocol.stages) {
    const part: LoadProtocol = { id: protocol.id, label: protocol.label, startG: g, segments: stage.segments };
    const steps = Math.round(protocolSeconds(part) * hz);
    let ended = false;
    for (let index = 0; index < steps && !ended; index += 1) {
      const held = loadAt(part, (index + 0.5) * stepSeconds);
      model.step(held, stepSeconds);
      step += 1;
      ended = reader.read(step * stepSeconds, held, stage.until);
      if (ended) g = held;
    }
    if (!ended) g = loadAt(part, Number.POSITIVE_INFINITY);
  }
  return { events: reader.events, final: model.diagnostics(), record: null };
}

/** The first event of `kind` at or after `afterSeconds`, or null. */
export function firstEvent(result: ReplayResult, kind: ResponseEventKind, afterSeconds = 0): ResponseEvent | null {
  return result.events.find(event => event.kind === kind && event.seconds >= afterSeconds) ?? null;
}

// The synthetic families of docs/g-response-comparison.md. Amplitudes and
// durations define inputs; they are not measured tolerances.

const hold = (seconds: number): LoadSegment => ({ seconds });
const jump = (toG: number): LoadSegment => ({ seconds: 0, toG });
const ramp = (toG: number, seconds: number): LoadSegment => ({ seconds, toG });

export const PROTOCOLS = {
  rest: (seconds = 120): LoadProtocol => ({ id: `rest-${seconds}`, label: `+1 g for ${seconds} s`, startG: 1, segments: [hold(seconds)] }),
  /** +1 → +g for `seconds` → +1, starting at 1 s and followed by 30 s at rest. */
  pulse: (g: number, seconds: number): LoadProtocol => ({
    id: `pulse-${g}-${seconds}`, label: `+${g} g for ${seconds} s`, startG: 1,
    segments: [hold(1), jump(g), hold(seconds), jump(1), hold(30)],
  }),
  /** From rest, +g held for `seconds`, then +1 for 30 s. */
  sustained: (g: number, seconds = 60): LoadProtocol => ({
    id: `sustained-${g}`, label: `+${g} g held ${seconds} s`, startG: 1,
    segments: [hold(1), jump(g), hold(seconds), jump(1), hold(30)],
  }),
  /** +1 → +toG at `rate` g/s, held for `holdSeconds`, then back to +1 at 2 g/s and 30 s at rest. */
  ramp: (rate: number, toG = 9, holdSeconds = 30): LoadProtocol => ({
    id: `ramp-${rate}`, label: `+1 → +${toG} g at ${rate} g/s, held ${holdSeconds} s`, startG: 1,
    segments: [hold(1), ramp(toG, (toG - 1) / rate), hold(holdSeconds), ramp(1, (toG - 1) / 2), hold(30)],
  }),
  /** +g for `pullSeconds`, +1 for `restSeconds`, `pulls` times, then 30 s at rest. */
  repeated: (restSeconds: number, g = 6, pullSeconds = 5, pulls = 4): LoadProtocol => ({
    id: `repeated-${restSeconds}`, label: `+${g} g ${pullSeconds} s, +1 g ${restSeconds} s, ×${pulls}`, startG: 1,
    segments: [hold(1), ...Array.from({ length: pulls }, (_, index) => [
      jump(g), hold(pullSeconds), jump(1), hold(index === pulls - 1 ? 30 : restSeconds),
    ]).flat()],
  }),
  /** `beforeG` for `beforeSeconds`, then +g held for 20 s, then 30 s at rest. */
  pushPull: (beforeG: number, g = 6, beforeSeconds = 3): LoadProtocol => ({
    id: `push-pull-${beforeG}-${g}`, label: `${beforeG < 0 ? "−" : "+"}${Math.abs(beforeG)} g for ${beforeSeconds} s, then +${g} g`, startG: 1,
    segments: [hold(1), jump(beforeG), hold(beforeSeconds), jump(g), hold(20), jump(1), hold(30)],
  }),
  /** +g from rest for `holdSeconds`, then back to +1 over `unloadSeconds` and 40 s at rest. */
  unload: (unloadSeconds: number, g = 10, holdSeconds = 20): LoadProtocol => ({
    id: `unload-${unloadSeconds}`, label: `+${g} g ${holdSeconds} s, unloaded over ${unloadSeconds} s`, startG: 1,
    segments: [hold(1), jump(g), hold(holdSeconds), ramp(1, unloadSeconds), hold(40)],
  }),
  /** +g from rest for `holdSeconds`, +1 for `restSeconds`, then +`againG` for 10 s and 40 s at rest. */
  pullDuringRecovery: (restSeconds: number, againG = 7, g = 10, holdSeconds = 20): LoadProtocol => ({
    id: `again-${restSeconds}-${againG}`, label: `+${g} g ${holdSeconds} s, +1 g ${restSeconds} s, +${againG} g 10 s`,
    startG: 1, segments: [hold(1), jump(g), hold(holdSeconds), jump(1), hold(restSeconds), jump(againG), hold(10), jump(1), hold(40)],
  }),
} as const;

/** The protocols a temporal preview offers: Step, Ramp, Repeated pull, Push–pull and Unload. */
export const PREVIEW_PROTOCOLS: readonly LoadProtocol[] = [
  { ...PROTOCOLS.sustained(8, 20), id: "preview-step", label: "Step" },
  { ...PROTOCOLS.ramp(0.5, 9, 15), id: "preview-ramp", label: "Ramp" },
  { ...PROTOCOLS.repeated(5, 7, 6, 3), id: "preview-repeated", label: "Repeated pull" },
  { ...PROTOCOLS.pushPull(-1, 6), id: "preview-push-pull", label: "Push–pull" },
  { ...PROTOCOLS.unload(1, 10, 15), id: "preview-unload", label: "Unload" },
];
