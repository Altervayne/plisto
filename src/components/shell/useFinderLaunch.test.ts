// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { openingFor } from "./useFinderLaunch";
import { focusAfterClose } from "../finder/finderMorph";

const el = (name: string) => ({ name, isConnected: true }) as unknown as HTMLElement;
const onScreen = () => true;
const offScreen = () => false;

describe("openingFor", () => {
  it("opens unscoped from the keys, flying from a visible pill", () => {
    const pill = el("pill");
    const opening = openingFor({ pill, held: null, fromPill: false }, onScreen);
    expect(opening).toEqual({ origin: pill, returnFocus: null, scope: null });
  });

  it("opens scoped from a door: same origin rule, focus returns to the door", () => {
    const pill = el("pill");
    const door = el("door");
    const opening = openingFor({ pill, held: null, fromPill: false, door, scope: "settings" }, onScreen);
    expect(opening).toEqual({ origin: pill, returnFocus: door, scope: "settings" });
  });

  it("uses the card's own entrance when the pill is off screen", () => {
    const door = el("door");
    const opening = openingFor({ pill: el("pill"), held: null, fromPill: false, door, scope: "settings" }, offScreen);
    expect(opening.origin).toBeNull();
    expect(opening.scope).toBe("settings");
  });

  it("returns focus to the door on a dismissal, and to nobody after a pick", () => {
    const door = el("door");
    const opening = openingFor({ pill: null, held: null, fromPill: false, door, scope: "settings" }, onScreen);
    expect(focusAfterClose("dismiss", opening.returnFocus)).toBe(door);
    expect(focusAfterClose("navigate", opening.returnFocus)).toBeNull();
  });
});
