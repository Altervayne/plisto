/*
 * The compile gate in front of a GL kind's factory. The first call submits the kind's declared programs
 * and the stage's own; the factory runs only once all of them have finished. A program is never polled
 * in the frame that submitted it, because without the parallel-compile extension a poll blocks until the
 * link ends: the first poll comes a frame later, when the driver has had time to finish.
 */

// -- Local Imports --
import { ProgramPending } from "../components/player/visualizers/gl/kit";
import { SHARED_PROGRAMS } from "../components/player/visualizers/gl/shaders";

// -- Type Imports --
import type { VisErrorStage } from "./protocol";
import type { Candidate, Kit, ProgramSource } from "../components/player/visualizers/gl/kit";

/** A failure tagged with where the mount was when it failed. */
export class MountError extends Error {
  readonly stage: VisErrorStage;
  constructor(stage: VisErrorStage, message: string) {
    super(message);
    this.stage = stage;
  }
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The names the stage's own programs take; a declared program may not reuse one.
const STAGE_PROGRAMS = new Set(SHARED_PROGRAMS.map((p) => p.name));

export interface ProgramGate {
  factory: (kit: Kit) => Candidate;
  // Starts a new frame: what was submitted before it may now be polled.
  nextFrame: () => void;
  // Marks a submission in this frame, such as a draw that asked for a program it had not declared.
  hold: () => void;
  // Whether a draw must wait: something was submitted this frame, or a program is still compiling.
  blocked: () => boolean;
}

export function createGate(programs: ProgramSource[], factory: (kit: Kit) => Candidate): ProgramGate {
  let kit: Kit | null = null;
  let heldThisFrame = false;
  let last: Candidate | null = null;

  const waiting = (k: Kit): string[] => {
    try {
      return k.pending();
    } catch (e) {
      throw new MountError("compile", errorText(e));
    }
  };

  const submit = (k: Kit) => {
    const taken = programs.find((p) => STAGE_PROGRAMS.has(p.name));
    if (taken) throw new MountError("setup", `program name ${taken.name} belongs to the stage`);
    for (const p of [...SHARED_PROGRAMS, ...programs]) {
      try {
        k.program(p);
      } catch (e) {
        if (!(e instanceof ProgramPending)) throw new MountError("compile", errorText(e));
      }
    }
  };

  return {
    factory(k) {
      if (!kit) {
        kit = k;
        heldThisFrame = true;
        submit(k);
      }
      if (heldThisFrame) throw new ProgramPending(programs[0]?.name ?? SHARED_PROGRAMS[0].name);
      const left = waiting(k);
      if (left.length > 0) throw new ProgramPending(left[0]);
      // The renderer runs the factory again for a still or a reset; the instance before is let go first.
      last?.dispose();
      last = null;
      let made: Candidate;
      try {
        made = factory(k);
      } catch (e) {
        if (e instanceof ProgramPending) throw e;
        throw new MountError("setup", errorText(e));
      }
      const own = made.dispose;
      let disposed = false;
      made.dispose = () => {
        if (disposed) return;
        disposed = true;
        own.call(made);
      };
      last = made;
      return made;
    },
    nextFrame() {
      heldThisFrame = false;
    },
    hold() {
      heldThisFrame = true;
    },
    blocked: () => kit !== null && (heldThisFrame || waiting(kit).length > 0),
  };
}
