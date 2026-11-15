/*
 * The file grant: written once, on the executable alone, and skipped when the file's DACL already
 * covers both container kinds.
 */

// -- Library Imports --
use windows::Win32::Security::Authorization::GRANT_ACCESS;

// -- Local Imports --
use super::*;
use crate::proc::acl::{
    ensure_container_access, explicit_grants, StringSid, ALL_APPLICATION_PACKAGES,
    ALL_RESTRICTED_APPLICATION_PACKAGES,
};
use crate::proc::test_helper::DENIED;

/// A new file in a scratch folder beside the build output, outside the test binary's folder.
fn scratch_file(name: &str) -> (Scratch, PathBuf) {
    let exe = std::env::current_exe().unwrap();
    let folder =
        Scratch(target_dir(&exe).join(format!("plisto-acl-test-{}-{name}", std::process::id())));
    fs::create_dir_all(&folder.0).unwrap();
    let file = folder.0.join("file");
    fs::write(&file, b"granted or not").unwrap();
    (folder, file)
}

#[test]
fn access_grant_is_idempotent_and_on_the_file_alone() {
    let f = fixture();
    let (folder, file) = scratch_file("own");
    let sid = f.container.sid();
    assert_eq!(explicit_grants(&file, sid).unwrap(), 0);
    ensure_container_access(&file, sid).unwrap();
    ensure_container_access(&file, sid).unwrap();
    assert_eq!(explicit_grants(&file, sid).unwrap(), 1);
    assert_eq!(explicit_grants(&folder.0, sid).unwrap(), 0);
}

#[test]
fn a_file_beside_the_granted_executable_stays_unreadable() {
    for isolation in [Isolation::LessPrivileged, Isolation::Plain] {
        let f = fixture_in(isolation);
        let sibling = Scratch(
            f.exe
                .with_file_name(format!("plisto-sibling-test-{}", std::process::id())),
        );
        fs::write(&sibling.0, b"beside the executable").unwrap();
        assert_eq!(
            probe(&f, "open-file", Some(sibling.0.as_os_str())),
            DENIED,
            "{isolation:?}"
        );
    }
}

#[test]
fn every_app_package_with_every_restricted_one_covers_both_kinds() {
    let f = fixture();
    let (_folder, file) = scratch_file("pair");
    for package in [
        ALL_APPLICATION_PACKAGES,
        ALL_RESTRICTED_APPLICATION_PACKAGES,
    ] {
        set_entry(
            &file,
            StringSid::parse(package).unwrap().sid(),
            GRANT_ACCESS,
        )
        .unwrap();
    }
    ensure_container_access(&file, f.container.sid()).unwrap();
    assert_eq!(explicit_grants(&file, f.container.sid()).unwrap(), 0);
}

#[test]
fn every_app_package_alone_does_not_cover_the_less_privileged_kind() {
    let f = fixture();
    let (_folder, file) = scratch_file("any");
    let any = StringSid::parse(ALL_APPLICATION_PACKAGES).unwrap();
    set_entry(&file, any.sid(), GRANT_ACCESS).unwrap();
    ensure_container_access(&file, f.container.sid()).unwrap();
    assert_eq!(explicit_grants(&file, f.container.sid()).unwrap(), 1);
}
