<div align="center">
  <img src="src/assets/plisto-logo-final.svg" alt="Plisto" width="120" />

  # Plisto

  **A calm, native desktop app for organizing and playing your local music library.**

  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
  ![Platform: Windows](https://img.shields.io/badge/platform-Windows_x64-informational)
  ![Version](https://img.shields.io/badge/version-2.0.0-success)
</div>

---

Plisto is an audio library organizer application. Point it to folders containing
mixed up music files, and it'll help you separate them into albums and singles.
It'll help you fill out their metadata, and apply image files in the folders as
actual embedded covers. It will also help you create playlists with those
organized tracks, and finally, export them into an entirely new folder of your
choosing exactly as you organized them.

Plisto also helps you trim silence off of tracks, or split a single large file
into several smaller ones using a .cue file, embedded chapters, by detecting
silence, or by hand. Plisto is **NOT** a DAW.

When everything is all neatly organized, Plisto also doubles as a basic music
player, with a pop-out widget, sequencing, and queueing.

Everything runs locally. Your library, and edits, live in a bundled
SQLite database placed under `%APPDATA%`. This means every edit is non-destructive.

## Features

### Library and organization

- **Scan** your music folders into a fast, searchable track index.
- **Albums, singles, and playlists.** Curate collections, reorder tracks, and
  keep a slot-based playlist model, where a track can appear more than once.
- **Unsorted workspace** for triaging freshly imported material.
- **Covers workspace** that shows which folders and albums still need art, with
  one-click assignment from loose images, auto-matching by filename, and
  pick-from-folder.
- A **per-track edit layer**, so your changes overlay the file's tags without
  touching the originals until you export.

### Tags and filenames

- **Bulk tag editing**, **title cleaning** (it strips the `(128kbit_AAC)` style
  cruft), and a **filename-to-metadata extractor** (the reverse of the export
  naming grammar).
- **Per-track cover art**, with folder-wide and album-wide assignment.

### Player

- Native in-app playback (Rust `symphonia` decode into `rodio` output), not a
  browser audio element.
- Now-playing surfaces everywhere it makes sense: a sidebar **mini-player**, a
  full **Player** destination (big cover, seek, transport, and a live up-next
  queue), a **system-tray** block, and a frameless, always-on-top **pop-out
  widget**.
- A live **audio-reactive visualizer**. The spectrum is tapped straight from the
  audio engine and drawn as a ridge behind the player and the pop-out widget.
- **Queue management**: add to queue, drag to reorder, remove, shuffle, and
  repeat (off, the whole queue, or a single track).
- **Output-device selection**, with follow-the-default behavior.

### Track Editor (splicer and cropper)

- **Split** one file into several at cut points (manual, silence-detected, `.cue`
  import, or embedded chapters), or **trim** leading and trailing silence.
- **Lossless per format.** Plisto stream-copies the encoded frames rather than
  re-encoding, so cuts introduce no quality loss. Supported formats are **WAV**
  (sample-exact), **FLAC**, **MP3**, **m4a/AAC**, and **Opus**. There is no
  FFmpeg; the cut engine is pure Rust.

### Export and device sync

- **Token-based export** with configurable folder and file naming,
  album-structured output, and playlist export (`.m3u` or `.m3u8`, in place or as
  a portable copy).
- **Direct-to-device (MTP) export on Windows.** Copy a curated selection straight
  onto a connected phone, with progress and cancel, including an update-in-place
  merge mode.

## Screenshots

> _To add: the library grid, the Player destination, the Track Editor, and the
> pop-out widget._

## Tech stack

- **[Tauri 2](https://tauri.app/)** gives Plisto a Rust core behind a WebView2
  interface, which keeps the installer small and the app native.
- **Rust** owns the library index and scan pipeline, the audio engine, the
  lossless cut engine, and the exporters. Key crates: `rusqlite`, `symphonia`,
  `rodio`, `lofty`, `image`, `walkdir`, `rayon`.
- **React 19, TypeScript, and Vite**, with **Zustand** for state, CSS Modules on
  a design-token system, and **`@dnd-kit`** for drag-reordering.

## Building from source

**Prerequisites**

- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Node.js](https://nodejs.org/) (LTS)
- Tauri's platform prerequisites. On Windows that means the **WebView2 runtime**
  and the **MSVC C++ build tools**. See the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

**Run in development**

```bash
npm install
npm run tauri dev
```

**Build installers**

```bash
npm run tauri build
```

The NSIS (`.exe`) and WiX (`.msi`) installers are written to
`src-tauri/target/release/bundle/`.

**Tests and checks**

```bash
npm run test                                      # frontend unit tests (Vitest)
npx tsc --noEmit                                  # frontend type-check
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
```

## Platform support

Plisto is currently built and supported on **Windows (x64)**. The Tauri and Rust
core is largely cross-platform, but some features are Windows-specific today. The
MTP device export and the pop-out widget's window styling both use the Windows
APIs, so macOS and Linux are not yet packaged.

## License

Plisto's source code is licensed under the **GNU Affero General Public License
v3.0**. See [`LICENSE`](./LICENSE). In short: you are free to use, study, modify,
and redistribute it, but any distributed or network-hosted version (modifications
included) must make its complete corresponding source available under the same
license.

The name "Plisto" and the Plisto logo are **© 2026 Florian Douay, all rights
reserved**, and are not covered by the AGPL. If you distribute a modified version,
please give it a different name and remove the Plisto branding. See
[`NOTICE`](./NOTICE).

Third-party components are licensed under their own permissive, AGPL-compatible
terms. See [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).

## Acknowledgements

Plisto stands on a deep stack of open-source work: the Tauri, Rust, and React
ecosystems, and in particular the
[Symphonia](https://github.com/pdeljanov/Symphonia) decoders and
[rodio](https://github.com/RustAudio/rodio) that make its audio features
possible. Thank you to everyone who builds and maintains those.
