import { LazyStore } from "@tauri-apps/plugin-store";

export type FrictionOutcome = "ok" | "stepCap";

export type FrictionEntry = {
  ok: number;
  stepCap: number;
};

// ponytail: exponential decay instead of a real rolling time window — halving
// past a sample cap keeps recent behavior weighted higher without tracking
// per-event timestamps. Revisit if a model's rate needs to reflect "the last
// hour" rather than "the last ~DECAY_AT turns".
const DECAY_AT = 40;
// A model needs at least this many samples before friction can demote it —
// one bad turn shouldn't blacklist a model for the rest of the session.
const MIN_SAMPLES = 4;
const HIGH_FRICTION_RATE = 0.4;

/** Pure decision logic — no IO, so it's directly testable against plain
 *  FrictionEntry literals (see modelFriction.test.ts). */
export function nextFrictionEntry(
  cur: FrictionEntry | undefined,
  outcome: FrictionOutcome,
): FrictionEntry {
  const base = cur ?? { ok: 0, stepCap: 0 };
  const next = { ...base, [outcome]: base[outcome] + 1 };
  if (next.ok + next.stepCap > DECAY_AT) {
    next.ok = Math.floor(next.ok / 2);
    next.stepCap = Math.floor(next.stepCap / 2);
  }
  return next;
}

export function frictionRateOf(entry: FrictionEntry | undefined): number {
  if (!entry) return 0;
  const total = entry.ok + entry.stepCap;
  if (total < MIN_SAMPLES) return 0;
  return entry.stepCap / total;
}

export function isHighFrictionEntry(entry: FrictionEntry | undefined): boolean {
  return frictionRateOf(entry) >= HIGH_FRICTION_RATE;
}

const STORE_PATH = "cli-ck-model-friction.json";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });
const cache = new Map<string, FrictionEntry>();
let hydrated = false;

export async function hydrateModelFriction(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const entries = await store.entries<FrictionEntry>();
  for (const [modelId, entry] of entries) cache.set(modelId, entry);
}

export function recordFriction(
  modelId: string,
  outcome: FrictionOutcome,
): void {
  const next = nextFrictionEntry(cache.get(modelId), outcome);
  cache.set(modelId, next);
  void store.set(modelId, next);
}

/** Fraction of recent turns on this model that hit the step cap, or 0 with
 *  too few samples to judge. */
export function frictionRate(modelId: string): number {
  return frictionRateOf(cache.get(modelId));
}

export function isHighFriction(modelId: string): boolean {
  return isHighFrictionEntry(cache.get(modelId));
}
