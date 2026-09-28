/*
 * Turns raw watcher events into file or folder changes for the dirty set. The Windows backend never
 * says whether a path is a file or a folder, so a path that still exists is probed, and a path that is
 * gone is judged by its name: an audio extension is a file, anything else is taken as a folder so a
 * removed folder is never missed. A folder's own modify event is noise (its entries report their own
 * changes) and is dropped. The probe is passed in, so the rules are testable without a disk.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};

use notify::event::{EventKind, ModifyKind};

// -- Local Imports --
use super::dirty::{has_audio_ext, PathKind};

/// One change a watcher event carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsHit {
    Changed(PathBuf, PathKind),
    /// Events were lost at this path, or everywhere when None.
    Overflow(Option<PathBuf>),
}

/// Classifies `event`. `probe` returns whether a path is a folder, or None when it no longer exists.
pub fn classify(event: &notify::Event, probe: impl Fn(&Path) -> Option<bool>) -> Vec<FsHit> {
    if event.need_rescan() {
        if event.paths.is_empty() {
            return vec![FsHit::Overflow(None)];
        }
        return event
            .paths
            .iter()
            .map(|p| FsHit::Overflow(Some(p.clone())))
            .collect();
    }

    let kind_of = |path: &Path| match probe(path) {
        Some(true) => PathKind::Dir,
        Some(false) => PathKind::File,
        None if has_audio_ext(path) => PathKind::File,
        None => PathKind::Dir,
    };

    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => {
            event
                .paths
                .iter()
                .map(|p| FsHit::Changed(p.clone(), kind_of(p)))
                .collect()
        }
        EventKind::Modify(_) | EventKind::Any => event
            .paths
            .iter()
            .filter(|p| match probe(p) {
                Some(is_dir) => !is_dir,
                None => has_audio_ext(p),
            })
            .map(|p| FsHit::Changed(p.clone(), PathKind::File))
            .collect(),
        EventKind::Access(_) | EventKind::Other => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, Flag, RemoveKind, RenameMode};
    use notify::Event;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    // A probe over a fixed set of existing folders and files.
    fn disk<'a>(dirs: &'a [&'a str], files: &'a [&'a str]) -> impl Fn(&Path) -> Option<bool> + 'a {
        move |path: &Path| {
            let s = path.to_string_lossy();
            if dirs.contains(&s.as_ref()) {
                Some(true)
            } else if files.contains(&s.as_ref()) {
                Some(false)
            } else {
                None
            }
        }
    }

    #[test]
    fn a_created_path_is_probed() {
        let ev = Event::new(EventKind::Create(CreateKind::Any))
            .add_path(p("m/a"))
            .add_path(p("m/b.mp3"));
        assert_eq!(
            classify(&ev, disk(&["m/a"], &["m/b.mp3"])),
            vec![
                FsHit::Changed(p("m/a"), PathKind::Dir),
                FsHit::Changed(p("m/b.mp3"), PathKind::File),
            ]
        );
    }

    #[test]
    fn a_gone_path_is_judged_by_its_name() {
        let ev = Event::new(EventKind::Remove(RemoveKind::Any))
            .add_path(p("m/song.flac"))
            .add_path(p("m/Album"))
            .add_path(p("m/cover.jpg"));
        assert_eq!(
            classify(&ev, disk(&[], &[])),
            vec![
                FsHit::Changed(p("m/song.flac"), PathKind::File),
                FsHit::Changed(p("m/Album"), PathKind::Dir),
                FsHit::Changed(p("m/cover.jpg"), PathKind::Dir),
            ]
        );
    }

    #[test]
    fn both_sides_of_a_rename_are_kept() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(p("m/Old"))
            .add_path(p("m/New"));
        assert_eq!(
            classify(&ev, disk(&["m/New"], &[])),
            vec![
                FsHit::Changed(p("m/Old"), PathKind::Dir),
                FsHit::Changed(p("m/New"), PathKind::Dir),
            ]
        );
    }

    #[test]
    fn a_modify_keeps_files_and_drops_folders() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(p("m/Album"))
            .add_path(p("m/Album/01.mp3"))
            .add_path(p("m/gone.mp3"))
            .add_path(p("m/gone.txt"));
        assert_eq!(
            classify(&ev, disk(&["m/Album"], &["m/Album/01.mp3"])),
            vec![
                FsHit::Changed(p("m/Album/01.mp3"), PathKind::File),
                FsHit::Changed(p("m/gone.mp3"), PathKind::File),
            ]
        );
    }

    #[test]
    fn a_rescan_flag_is_an_overflow() {
        let ev = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(classify(&ev, disk(&[], &[])), vec![FsHit::Overflow(None)]);
        let ev = Event::new(EventKind::Other)
            .set_flag(Flag::Rescan)
            .add_path(p("m"));
        assert_eq!(
            classify(&ev, disk(&[], &[])),
            vec![FsHit::Overflow(Some(p("m")))]
        );
    }

    #[test]
    fn access_events_are_ignored() {
        let ev =
            Event::new(EventKind::Access(notify::event::AccessKind::Any)).add_path(p("m/a.mp3"));
        assert!(classify(&ev, disk(&[], &["m/a.mp3"])).is_empty());
    }
}
