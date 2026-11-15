/*
 * Opens and closes the quick finder for the shell. Each open measures the sidebar search pill once: a
 * pill wholly on screen is the origin the finder's field flies from, whether the pill or Ctrl+K opened
 * it. Each close hands focus back to the pill or to what held focus before Ctrl+K, unless a pick went
 * somewhere new. The finder can open only over a library: never on the player-only standalone surface,
 * nor before a library holds any track.
 */

// -- Framework Imports --
import { useCallback, useLayoutEffect, useRef, useState } from "react";

// -- Unit Imports --
import { originOnScreen } from "../finder/useFinderMotion";
import { focusAfterClose } from "../finder/finderMorph";
import type { CloseReason } from "../finder/finderMorph";
import type { FinderScope } from "../finder/useFinderModel";

export interface Opening {
  origin: HTMLElement | null;
  returnFocus: HTMLElement | null;
  scope: FinderScope | null;
}

/** What an open knows about its surroundings. `door` is the control that asked for a scoped open. */
export interface OpenContext {
  pill: HTMLElement | null;
  // The element holding focus before the open, when it is a real control.
  held: HTMLElement | null;
  fromPill: boolean;
  door?: HTMLElement | null;
  scope?: FinderScope | null;
}

/**
 * The opening for one open. The origin is the pill when it is wholly on screen. A dismissal returns
 * focus to the door that asked, else the pill, else whatever held focus before Ctrl+K.
 */
export function openingFor(ctx: OpenContext, onScreen: (el: HTMLElement) => boolean = originOnScreen): Opening {
  const { pill, held, fromPill, door = null, scope = null } = ctx;
  return {
    origin: pill != null && onScreen(pill) ? pill : null,
    returnFocus: door ?? (fromPill ? pill : held),
    scope,
  };
}

export function useFinderLaunch({ tracks, standalone, sidebarExpanded }: { tracks: number; standalone: boolean; sidebarExpanded: boolean }) {
  const enabled = tracks > 0 && (!standalone || sidebarExpanded);
  const [opening, setOpening] = useState<Opening | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<HTMLElement | null>(null);

  const open = useCallback((fromPill: boolean, door?: HTMLElement | null, scope?: FinderScope) => {
    const active = document.activeElement;
    const held = active instanceof HTMLElement && active !== document.body ? active : null;
    const next = openingFor({ pill: pillRef.current, held, fromPill, door, scope });
    setOpening((current) => current ?? next);
  }, []);

  const onClose = useCallback(
    (reason: CloseReason) => {
      pendingFocus.current = focusAfterClose(reason, opening?.returnFocus ?? null);
      setOpening(null);
    },
    [opening],
  );

  // Focus moves once the pill is shown again, before the frame paints.
  useLayoutEffect(() => {
    if (opening != null || pendingFocus.current == null) return;
    pendingFocus.current.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [opening]);

  return {
    enabled,
    openFromKeys: () => open(false),
    openScoped: (door: HTMLElement | null, scope: FinderScope) => open(false, door, scope),
    pill: enabled ? { open: opening != null, onOpen: () => open(true), pillRef } : null,
    finder: opening ? { origin: opening.origin, onClose, initialScope: opening.scope } : null,
  };
}
