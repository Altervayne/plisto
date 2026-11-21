/*
 * The candidate form: a factory over the kit, the way the built-in kinds are written. Programs listed
 * up front compile before the factory runs; any other program compiles the first time a draw asks.
 */

// -- Type Imports --
import type { Candidate, Kit, ProgramSource } from "../../components/player/visualizers/gl/kit";
import type { Registration } from "../lifecycle";

export interface CandidateOptions {
  programs?: ProgramSource[];
}

export function candidateForm(factory: (kit: Kit) => Candidate, options: CandidateOptions = {}): Registration {
  const programs = options.programs ?? [];
  return () => ({ form: "gl", programs, factory });
}
