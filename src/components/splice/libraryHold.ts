/*
 * The Track Editor's hold on the library player, one for the whole app since only one trim write runs
 * at a time. Entering the editor captures and pauses the library; leaving restores it, or waits for a
 * write in flight to settle first. A waiting restore is dropped when the player moved since leaving
 * (another track, playing, or the play head moved), so newer playback wins; entering the editor again
 * takes it back. Pure over a player port, so the rules test without React.
 */

/** What the hold reads from and does to the player. */
export interface PlayerPort {
  read: () => { playing: boolean; trackId: number | null; positionSecs: number };
  pause: () => void;
  stop: () => void;
  /** Reseats the library's loaded track at `positionSecs`, playing when `play`. */
  restore: (positionSecs: number, play: boolean) => void;
}

/** The library as the editor found it. */
interface Capture {
  wasPlaying: boolean;
  hadTrack: boolean;
  trackId: number | null;
  positionSecs: number;
}

export interface LibraryHold {
  /**
   * A session became visible: take back a restore still waiting when the player is where the last
   * session left it, else capture the library afresh.
   */
  enter: () => void;
  /** The session was hidden or closed: stop a sounding preview, then restore now or after the write. */
  leave: () => void;
  /** A write replaced `trackId`'s file; a captured position on it no longer points at the same audio. */
  fileRewritten: (trackId: number) => void;
  /** Holds `work` until it settles. A newer write replaces an older one. */
  hold: (work: Promise<unknown>) => void;
  /** Whether a write is in flight now. */
  busy: () => boolean;
}

/** How far the play head may sit from where the session left it and still count as unmoved. */
const POSITION_SLACK_SECS = 0.5;

/** The player as the session left it with a write in flight. A stopped preview leaves no position. */
interface LeftOn {
  trackId: number | null;
  positionSecs: number | null;
}

export function createLibraryHold(port: PlayerPort): LibraryHold {
  let capture: Capture | null = null;
  let active = false;
  let pending: Promise<unknown> | null = null;
  // Non-null while a restore waits on the write.
  let leftOn: LeftOn | null = null;

  // Whether the player is still where the session left it: same track, silent, play head in place.
  const unmoved = () => {
    if (!leftOn) return false;
    const now = port.read();
    if (now.playing || now.trackId !== leftOn.trackId) return false;
    const left = leftOn.positionSecs;
    return left == null || Math.abs(now.positionSecs - left) <= POSITION_SLACK_SECS;
  };

  const restore = () => {
    const held = capture;
    capture = null;
    leftOn = null;
    if (held?.hadTrack) port.restore(held.positionSecs, held.wasPlaying);
  };

  const settle = (work: Promise<unknown>) => {
    if (pending !== work) return;
    pending = null;
    if (!leftOn || active) return;
    if (unmoved()) restore();
    else {
      capture = null;
      leftOn = null;
    }
  };

  return {
    enter: () => {
      const stayed = unmoved();
      const now = port.read();
      leftOn = null;
      if (!stayed) {
        capture = {
          wasPlaying: now.playing,
          hadTrack: now.trackId != null,
          trackId: now.trackId,
          positionSecs: now.positionSecs,
        };
      }
      if (now.playing) port.pause();
      active = true;
    },
    leave: () => {
      const now = port.read();
      const preview = now.playing && now.trackId == null;
      if (preview) port.stop();
      active = false;
      if (pending) leftOn = { trackId: now.trackId, positionSecs: preview ? null : now.positionSecs };
      else restore();
    },
    fileRewritten: (trackId) => {
      if (capture && capture.trackId === trackId) capture.positionSecs = 0;
    },
    hold: (work) => {
      pending = work;
      void work.then(
        () => settle(work),
        () => settle(work),
      );
    },
    busy: () => pending != null,
  };
}
