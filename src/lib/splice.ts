/*
 * The frontend splice helpers: the cut gate, the filename projection twinned from the backend's
 * segment_stem, the per-format frame snap, and the timecode display. Kept in step with the backend's
 * Format::from_source and segment_stem (src-tauri/src/splice/mod.rs) and safe_component
 * (src-tauri/src/export/derive.rs) - WAV, FLAC, MP3, AAC m4a, and Ogg/Opus today.
 */

/** The source containers the cutter can slice without a re-encode. */
export type SpliceFormat = "wav" | "flac" | "mp3" | "m4a" | "opus";

/**
 * The source extensions the splicer accepts, lowercased and no leading dot, each mapped to its cut
 * format. m4b (AAC audiobooks) rides the same m4a cutter, twinning the backend's from_source.
 */
const EXT_TO_FORMAT: Record<string, SpliceFormat> = {
  wav: "wav",
  flac: "flac",
  mp3: "mp3",
  m4a: "m4a",
  m4b: "m4a",
  opus: "opus",
};

/** The dotless, lowercased extension of a path or a bare extension. */
function extOf(pathOrExt: string): string {
  const dot = pathOrExt.lastIndexOf(".");
  const ext = dot >= 0 ? pathOrExt.slice(dot + 1) : pathOrExt;
  return ext.toLowerCase();
}

/** Whether a source path or bare extension names a container the splicer can cut. */
export function canSplice(pathOrExt: string): boolean {
  return extOf(pathOrExt) in EXT_TO_FORMAT;
}

/** The splice format of a path or bare extension, or null when its container has no cutter. */
export function spliceFormat(pathOrExt: string): SpliceFormat | null {
  return EXT_TO_FORMAT[extOf(pathOrExt)] ?? null;
}

// -- Filename projection (twin of segment_stem + safe_component) --

// The characters Windows forbids in a path component.
const ILLEGAL = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

// The reserved DOS device names. A component whose stem matches one (case-insensitively) cannot be a
// real file, so it is broken with a trailing underscore.
const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
  "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// The per-component character cap, guarding the filesystem limit.
const MAX_COMPONENT = 255;

/** A control character: the C0 range, DEL, and the C1 range, matching Rust's char::is_control. */
function isControl(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Appends an underscore to a component whose stem (before the first dot) is a reserved device name. */
function breakReserved(component: string): string {
  const stem = component.split(".")[0] ?? component;
  return RESERVED.has(stem.toUpperCase()) ? `${component}_` : component;
}

/**
 * Windows-strict sanitization of one path component: NFC-normalize, strip the forbidden characters
 * and control chars, drop trailing dots and spaces, break a reserved device name, and cap the length.
 * May return empty (all-illegal input); the caller substitutes a label.
 */
function sanitizeComponent(raw: string): string {
  const nfc = raw.normalize("NFC");
  const stripped = [...nfc].filter((c) => !ILLEGAL.has(c) && !isControl(c)).join("");
  const trimmed = stripped
    .trim()
    .replace(/[. ]+$/, "")
    .replace(/\s+$/, "");
  const broken = breakReserved(trimmed);
  return [...broken].slice(0, MAX_COMPONENT).join("");
}

/** The sanitized component, or the sanitized label when it comes out empty. */
function safeComponent(raw: string, label: string): string {
  const s = sanitizeComponent(raw);
  return s === "" ? sanitizeComponent(label) : s;
}

/** The metadata a projected filename draws its tokens from. */
export interface FilenameMeta {
  title?: string;
  artist?: string;
  track_no?: number;
}

/**
 * The projected filename for one segment, twinning the backend's segment_stem: the naming pattern's
 * {track_no}/{title}/{artist} tokens filled (track number zero-padded to two digits, its number the
 * segment's own or its 1-based index), sanitized, falling back to `Track N` when the stem is empty.
 * Returns `stem.ext`, or the bare stem when there is no extension.
 */
export function projectFilename(
  pattern: string,
  meta: FilenameMeta,
  index: number,
  ext: string,
): string {
  const number = meta.track_no ?? index + 1;
  const raw = pattern
    .split("{track_no}")
    .join(String(number).padStart(2, "0"))
    .split("{title}")
    .join(meta.title ?? "")
    .split("{artist}")
    .join(meta.artist ?? "");
  const stem = safeComponent(raw, `Track ${index + 1}`);
  return ext ? `${stem}.${ext}` : stem;
}

// -- Frame snap (per format) --

/**
 * A cut frame snapped to what the format can land on. WAV and FLAC pass through: WAV is sample-
 * accurate, and FLAC's real block boundaries are the encoder's, not ours, so the requested frame is
 * shown and the backend aligns to the nearest block. MP3 snaps to the MPEG frame grid (1152 samples
 * for a sample rate at or above 32 kHz, else 576); m4a snaps to the AAC frame grid (1024 samples); opus
 * snaps to the common 960-sample (20 ms) packet grid, approximate since packets can vary while the
 * backend cut is exact to the packet. Each is the granularity a frame-copy can honor.
 */
export function snapFrame(frame: number, format: SpliceFormat | null, sampleRate: number): number {
  if (format === "mp3") {
    const grid = sampleRate >= 32000 ? 1152 : 576;
    return Math.round(frame / grid) * grid;
  }
  if (format === "m4a") {
    return Math.round(frame / 1024) * 1024;
  }
  if (format === "opus") {
    return Math.round(frame / 960) * 960;
  }
  return Math.round(frame);
}

// -- Timecode --

/**
 * A frame position as HH:MM:SS.mmm, dropping the hours when they are zero. Rendered from the sample
 * rate, so it reads as absolute file time.
 */
export function formatTimecode(frames: number, sampleRate: number): string {
  const totalMs = sampleRate > 0 ? Math.max(0, Math.round((frames / sampleRate) * 1000)) : 0;
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const ss = String(s).padStart(2, "0");
  const mmm = String(ms).padStart(3, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}.${mmm}`;
  return `${String(m).padStart(2, "0")}:${ss}.${mmm}`;
}

/**
 * The inverse of formatTimecode: a typed `[hh:]mm:ss[.mmm]` position back to a frame, or null when the
 * text does not read as a time. The seconds field carries the fraction and stays under a minute; the
 * leading field is unbounded (so 90:00 is ninety minutes), any middle field under sixty. A bare number
 * reads as seconds. The frame rounds off the sample rate, so a value re-renders snapped, no fake precision.
 */
export function parseTimecode(text: string, sampleRate: number): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  const secStr = parts[parts.length - 1];
  if (!/^\d+(\.\d+)?$/.test(secStr)) return null;
  const seconds = Number(secStr);
  const lead = parts.slice(0, -1);
  for (const p of lead) if (!/^\d+$/.test(p)) return null;
  // A colon-separated seconds field wraps at sixty; the leading field alone runs free.
  if (parts.length >= 2 && seconds >= 60) return null;
  let total = seconds;
  if (parts.length >= 2) total += Number(lead[lead.length - 1]) * 60;
  if (parts.length === 3) {
    if (Number(lead[lead.length - 1]) >= 60) return null;
    total += Number(lead[0]) * 3600;
  }
  if (!Number.isFinite(total) || total < 0) return null;
  return Math.round(total * sampleRate);
}

/** The parent folder of a path, tolerant of either separator and a trailing slash. */
export function parentDir(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return cut >= 0 ? norm.slice(0, cut) : norm;
}
