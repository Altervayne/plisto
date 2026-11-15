/*
 * What the container keeps the helper from: the token it runs with, user files, sockets, user
 * registry keys and child processes. Where the two container kinds differ, both are tested.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::net::TcpListener;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::LUID;
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, LookupPrivilegeNameW, TokenCapabilities,
    TokenIntegrityLevel, TokenIsAppContainer, TokenPrivileges, TOKEN_GROUPS, TOKEN_MANDATORY_LABEL,
    TOKEN_PRIVILEGES,
};

// -- Local Imports --
use super::*;
use crate::proc::test_helper::{ALLOWED, DENIED, NO_SOCKET_STACK};

const SECURITY_MANDATORY_LOW_RID: u32 = 0x1000;

fn privilege_names(process: HANDLE) -> Vec<String> {
    let buffer = token_info::<TOKEN_PRIVILEGES>(process, TokenPrivileges);
    let privileges = buffer.as_ptr() as *const TOKEN_PRIVILEGES;
    // SAFETY: the buffer holds a TOKEN_PRIVILEGES followed by its `PrivilegeCount` entries.
    let (count, first) = unsafe {
        (
            (*privileges).PrivilegeCount,
            (*privileges).Privileges.as_ptr(),
        )
    };
    (0..count as usize)
        .map(|i| {
            // SAFETY: `i` is under the count the token reported.
            let luid: LUID = unsafe { (*first.add(i)).Luid };
            let mut name = [0u16; 128];
            let mut len = name.len() as u32;
            // SAFETY: the name buffer holds `len` units.
            unsafe {
                LookupPrivilegeNameW(PCWSTR::null(), &luid, PWSTR(name.as_mut_ptr()), &mut len)
            }
            .map(|()| String::from_utf16_lossy(&name[..len as usize]))
            .unwrap_or_else(|_| format!("{luid:?}"))
        })
        .collect()
}

#[test]
fn contained_helper_token_is_app_container_and_low_integrity() {
    let f = fixture();
    let (helper, _stdout) = ready_echo(&f);
    let process = helper.process.handle();
    let is_container = token_info::<u32>(process, TokenIsAppContainer);
    // SAFETY: the buffer holds the u32 flag.
    assert_eq!(unsafe { *(is_container.as_ptr() as *const u32) }, 1);
    let label = token_info::<TOKEN_MANDATORY_LABEL>(process, TokenIntegrityLevel);
    // SAFETY: the buffer holds a TOKEN_MANDATORY_LABEL.
    let sid = unsafe {
        (*(label.as_ptr() as *const TOKEN_MANDATORY_LABEL))
            .Label
            .Sid
    };
    // SAFETY: the label's SID points into `label`, which is live; its last sub-authority is the
    // integrity level.
    let level = unsafe { *GetSidSubAuthority(sid, u32::from(*GetSidSubAuthorityCount(sid)) - 1) };
    assert_eq!(level, SECURITY_MANDATORY_LOW_RID);
    eprintln!("decode helper privileges: {:?}", privilege_names(process));
}

#[test]
fn contained_helper_token_has_no_capability() {
    for isolation in [Isolation::LessPrivileged, Isolation::Plain] {
        let f = fixture_in(isolation);
        let (helper, _stdout) = ready_echo(&f);
        let groups = token_info::<TOKEN_GROUPS>(helper.process.handle(), TokenCapabilities);
        // SAFETY: the buffer holds a TOKEN_GROUPS.
        let count = unsafe { (*(groups.as_ptr() as *const TOKEN_GROUPS)).GroupCount };
        assert_eq!(count, 0, "{isolation:?}");
    }
}

#[test]
fn contained_helper_cannot_open_a_user_file() {
    let f = fixture();
    let folder =
        Scratch(std::env::temp_dir().join(format!("plisto-container-test-{}", std::process::id())));
    fs::create_dir_all(&folder.0).unwrap();
    let file = folder.0.join("user-file");
    fs::write(&file, b"user data").unwrap();
    assert_eq!(probe(&f, "open-file", Some(file.as_os_str())), DENIED);
}

// In the less privileged container Winsock does not start at all. In the plain one it starts and
// the connect is refused.
#[test]
fn contained_helper_cannot_connect_a_socket() {
    cannot_connect_in(Isolation::LessPrivileged, NO_SOCKET_STACK);
}

#[test]
fn contained_helper_cannot_connect_a_socket_in_the_plain_container() {
    cannot_connect_in(Isolation::Plain, DENIED);
}

fn cannot_connect_in(isolation: Isolation, refusal: i32) {
    let f = fixture_in(isolation);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let local = listener.local_addr().unwrap().to_string();
    assert_ne!(probe(&f, "connect", Some(OsStr::new(&local))), ALLOWED);
    listener.set_nonblocking(true).unwrap();
    assert!(
        listener.accept().is_err(),
        "the helper reached the listener"
    );
    // A documentation address no network routes, so only the container's refusal answers at once.
    assert_eq!(
        probe(&f, "connect", Some(OsStr::new("192.0.2.1:443"))),
        refusal
    );
}

#[test]
fn contained_helper_cannot_read_the_user_hive() {
    let f = fixture();
    assert_eq!(
        probe(&f, "registry", Some(OsStr::new("Environment"))),
        DENIED
    );
}

// The user's keys grant every app package read by default, so only the less privileged container
// keeps them out of reach.
#[test]
fn the_plain_container_reads_user_keys_that_grant_every_app_package() {
    let f = fixture_in(Isolation::Plain);
    for key in ["Environment", "Software", "Control Panel"] {
        assert_eq!(
            probe(&f, "registry", Some(OsStr::new(key))),
            ALLOWED,
            "{key}"
        );
    }
}

#[test]
fn contained_helper_cannot_read_a_user_key_with_no_package_grant() {
    let f = fixture();
    // HKCU\Console grants nothing to app packages.
    assert_eq!(probe(&f, "registry", Some(OsStr::new("Console"))), DENIED);
}

#[test]
fn contained_helper_cannot_start_a_child() {
    let f = fixture();
    assert_eq!(probe(&f, "spawn", None), DENIED);
}
