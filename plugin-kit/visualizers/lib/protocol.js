// A generated copy of a Plisto source file; do not edit.
/*
 * The visualizer frame protocol, shared by the host and the runtime inside the frame. The host posts one
 * `plisto:vis-init` window message that transfers a MessagePort; every later message travels on that
 * port. Ticks are numbered and sent under a credit window: the frame acks the last tick it consumed, and
 * a host out of credit folds new ticks into one held tick. Folding sums `dt` and `nBeats`, keeps the
 * largest value of every one-frame signal event, and takes the latest of everything else, so no beat and
 * no time is lost to a slow frame. This module has no value imports, so it can be copied as plain script.
 */
/** The visualizer api number this protocol serves. */
export const VIS_API = 1;
/** The `type` of the window message that carries the port. */
export const VIS_INIT_TYPE = "plisto:vis-init";
/** Ticks the host may send before an ack. */
export const TICK_CREDITS = 2;
// -- Folding --
/** How each signal field folds while ticks wait for credit. A new field must be classified here. */
export const SIGNAL_FOLD = {
    bands: "latest",
    rms: "latest",
    peak: "latest",
    flux: "max",
    kick: "max",
    bass: "latest",
    mid: "latest",
    high: "latest",
    level: "latest",
    swell: "latest",
    bassMotion: "latest",
    midMotion: "latest",
    highMotion: "latest",
    beat: "max",
    drive: "latest",
    loudness: "latest",
    bassHit: "max",
    midHit: "max",
    highHit: "max",
    beatWeight: "max",
    surge: "max",
    cut: "max",
};
/** The one-frame event fields that keep their largest value across folded ticks. */
export const MAX_CARRY = Object.keys(SIGNAL_FOLD).filter((key) => SIGNAL_FOLD[key] === "max");
/** Folds `next` onto the held tick `held`: sums `dt` and `nBeats`, carries the events' max. */
export function foldTick(held, next) {
    const sig = { ...next.sig };
    for (const key of MAX_CARRY) {
        sig[key] = Math.max(held.sig[key], next.sig[key]);
    }
    return { ...next, sig, dt: held.dt + next.dt, nBeats: held.nBeats + next.nBeats };
}
export function createTickSender(send, credits = TICK_CREDITS) {
    let inFlight = [];
    let held = null;
    const push = (tick) => {
        inFlight.push(tick.seq);
        send(tick);
    };
    return {
        offer(tick) {
            if (held)
                held = foldTick(held, tick);
            else if (inFlight.length < credits)
                push(tick);
            else
                held = tick;
        },
        ack(seq) {
            inFlight = inFlight.filter((s) => s > seq);
            if (held && inFlight.length < credits) {
                const tick = held;
                held = null;
                push(tick);
            }
        },
        outstanding: () => inFlight.length,
        reset() {
            inFlight = [];
            held = null;
        },
    };
}
// -- Reading messages --
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** The init message, or null when `data` is not one. */
export function readInit(data) {
    if (!isObject(data) || data.plisto !== 1 || data.type !== VIS_INIT_TYPE)
        return null;
    if (!isCount(data.api) || typeof data.kind !== "string" || !isObject(data.context))
        return null;
    if (!isObject(data.composite) || !isObject(data.needs) || !Array.isArray(data.settingShapes))
        return null;
    if (typeof data.meter !== "boolean")
        return null;
    return data;
}
/** A host message, or null for anything malformed or unknown. */
export function readHostMessage(data) {
    if (!isObject(data))
        return null;
    switch (data.type) {
        case "tick":
            return isCount(data.seq) && isNum(data.t) && isNum(data.dt) && data.dt >= 0 && isObject(data.sig) && isCount(data.nBeats)
                ? data
                : null;
        case "update":
            return isObject(data.context) ? data : null;
        case "still":
            return isCount(data.id) ? data : null;
        case "meter":
            return typeof data.on === "boolean" ? { type: "meter", on: data.on } : null;
        case "dispose":
            return { type: "dispose" };
        default:
            return null;
    }
}
/** A frame message, or null for anything malformed or unknown. */
export function readFrameMessage(data) {
    if (!isObject(data))
        return null;
    switch (data.type) {
        case "ack":
            return isCount(data.seq) && (data.ms === null || isNum(data.ms)) ? data : null;
        case "ready":
            return typeof data.metered === "boolean" ? data : null;
        case "metered":
            return { type: "metered" };
        case "still":
            return isCount(data.id) && (data.error === undefined || typeof data.error === "string")
                ? data
                : null;
        case "lost":
            return { type: "lost" };
        case "flash":
            return isObject(data.reading) ? data : null;
        case "error":
            return typeof data.stage === "string" && typeof data.message === "string" ? data : null;
        case "log":
            return typeof data.level === "string" && typeof data.text === "string" ? data : null;
        default:
            return null;
    }
}
