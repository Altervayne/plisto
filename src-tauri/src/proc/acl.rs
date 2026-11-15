/*
 * Gives an AppContainer read and execute on one file, the executable it runs, and on nothing else:
 * not the folder, not the files beside it. The grant is one allow ACE on the file, not inherited,
 * written only when the file's DACL does not already let both container kinds read it. The user owns
 * the files it runs on, so writing the DACL needs no elevation.
 */

// -- Library Imports --
use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{self, addr_of};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{LocalFree, HLOCAL, WIN32_ERROR};
use windows::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    ACCESS_MODE, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    EqualSid, GetAce, MapGenericMask, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACL,
    DACL_SECURITY_INFORMATION, GENERIC_MAPPING, INHERIT_ONLY_ACE, NO_INHERITANCE,
    PSECURITY_DESCRIPTOR, PSID,
};
use windows::Win32::Storage::FileSystem::{
    FILE_ALL_ACCESS, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};

// -- Local Imports --
use super::container::{setup_lock, Cancelled};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const READ_EXECUTE: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;
/// Every app package. A less privileged container is not in it.
pub const ALL_APPLICATION_PACKAGES: &str = "S-1-15-2-1";
/// Every app package, less privileged ones included.
pub const ALL_RESTRICTED_APPLICATION_PACKAGES: &str = "S-1-15-2-2";
// How generic rights in an ACE map to file rights.
const FILE_MAPPING: GENERIC_MAPPING = GENERIC_MAPPING {
    GenericRead: FILE_GENERIC_READ.0,
    GenericWrite: FILE_GENERIC_WRITE.0,
    GenericExecute: FILE_GENERIC_EXECUTE.0,
    GenericAll: FILE_ALL_ACCESS.0,
};

/// Makes `file` readable and executable by the container `sid`, in either container kind. Does
/// nothing when it already is.
pub fn ensure_container_access(file: &Path, sid: PSID, cancelled: Cancelled) -> io::Result<()> {
    if has_container_access(file, sid)? {
        return Ok(());
    }
    edit_entry(file, sid, GRANT_ACCESS, cancelled)
}

/// Whether `file` is readable and executable by the container `sid`, in either container kind.
pub fn has_container_access(file: &Path, sid: PSID) -> io::Result<bool> {
    Descriptor::read(&wide(file))?.grants(sid)
}

/// Adds an allow ACE for `sid` on `file` alone, read and execute, or with `mode` another change for
/// that SID.
#[cfg(test)]
pub(super) fn set_entry(file: &Path, sid: PSID, mode: ACCESS_MODE) -> io::Result<()> {
    edit_entry(file, sid, mode, super::container::NEVER)
}

fn edit_entry(file: &Path, sid: PSID, mode: ACCESS_MODE, cancelled: Cancelled) -> io::Result<()> {
    // A change reads, merges and writes the whole DACL: two at once on one file would lose one.
    let _setup = setup_lock(cancelled)?;
    let path = wide(file);
    let current = Descriptor::read(&path)?;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: READ_EXECUTE,
        grfAccessMode: mode,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: PWSTR(sid.0.cast()),
            ..Default::default()
        },
    };
    let mut merged: *mut ACL = ptr::null_mut();
    // SAFETY: `entry` names a SID that lives as long as the caller's, `current.dacl` stays valid while
    // `current` lives, and the merged ACL is owned by `Local` at once.
    check(unsafe { SetEntriesInAclW(Some(&[entry]), Some(current.dacl), &mut merged) })?;
    let merged = Local(merged.cast());
    // SAFETY: `path` is NUL-terminated and the merged ACL is live until `merged` drops.
    check(unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            PSID::default(),
            PSID::default(),
            Some(merged.0 as *const ACL),
            None,
        )
    })
}

/// How many allow ACEs on `file`, not inherited from its folder, name `sid`.
#[cfg(test)]
pub(super) fn explicit_grants(file: &Path, sid: PSID) -> io::Result<usize> {
    const INHERITED_ACE: u8 = 0x10;
    let current = Descriptor::read(&wide(file))?;
    let mut found = 0;
    for ace in current.aces()? {
        // SAFETY: `aces` yields allow ACEs of a DACL that lives as long as `current`.
        let (header, trustee) = unsafe { ((*ace).Header, ace_sid(ace)) };
        // SAFETY: both SIDs are valid for the length of the call.
        if header.AceFlags & INHERITED_ACE == 0 && unsafe { EqualSid(trustee, sid) }.is_ok() {
            found += 1;
        }
    }
    Ok(found)
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain([0]).collect()
}

fn check(code: WIN32_ERROR) -> io::Result<()> {
    code.ok().map_err(io::Error::from)
}

/// Memory Windows hands out to be freed with LocalFree.
struct Local(*mut c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a call that hands out LocalAlloc memory, freed once, here.
            unsafe { LocalFree(HLOCAL(self.0)) };
        }
    }
}

/// A SID parsed from its string form.
pub struct StringSid(Local);

impl StringSid {
    pub fn parse(text: &str) -> io::Result<StringSid> {
        let mut sid = PSID::default();
        // SAFETY: a NUL-terminated string and a live out-pointer; the SID is owned by `Local` at once.
        unsafe { ConvertStringSidToSidW(&HSTRING::from(text), &mut sid) }?;
        Ok(StringSid(Local(sid.0)))
    }

    /// The SID, valid while self lives.
    pub fn sid(&self) -> PSID {
        PSID(self.0 .0)
    }
}

/// A file's security descriptor and the DACL inside it.
struct Descriptor {
    _owner: Local,
    dacl: *const ACL,
}

impl Descriptor {
    fn read(path: &[u16]) -> io::Result<Descriptor> {
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: `path` is NUL-terminated and both out-pointers are live locals. The DACL points into
        // the descriptor, which `_owner` frees after it.
        check(unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            )
        })?;
        Ok(Descriptor {
            _owner: Local(descriptor.0),
            dacl,
        })
    }

    /// The DACL's allow ACEs, valid while self lives. A null DACL has none.
    fn aces(&self) -> io::Result<Vec<*const ACCESS_ALLOWED_ACE>> {
        if self.dacl.is_null() {
            return Ok(Vec::new());
        }
        // SAFETY: a non-null DACL from GetNamedSecurityInfoW is a valid ACL.
        let count = unsafe { (*self.dacl).AceCount };
        let mut aces = Vec::new();
        for index in 0..u32::from(count) {
            let mut ace: *mut c_void = ptr::null_mut();
            // SAFETY: the index is under the ACL's ACE count, and `ace` is a live out-pointer.
            unsafe { GetAce(self.dacl, index, &mut ace) }?;
            let ace = ace as *const ACCESS_ALLOWED_ACE;
            // SAFETY: every ACE starts with a header.
            if unsafe { (*ace).Header.AceType } == ACCESS_ALLOWED_ACE_TYPE {
                aces.push(ace);
            }
        }
        Ok(aces)
    }

    /// Whether the file's allow ACEs give read and execute to `sid`, or to both every app package
    /// and every restricted one, which together cover both container kinds.
    fn grants(&self, sid: PSID) -> io::Result<bool> {
        // A null DACL gives everyone every right.
        if self.dacl.is_null() {
            return Ok(true);
        }
        let any = StringSid::parse(ALL_APPLICATION_PACKAGES)?;
        let restricted = StringSid::parse(ALL_RESTRICTED_APPLICATION_PACKAGES)?;
        let (mut any_found, mut restricted_found) = (false, false);
        for ace in self.aces()? {
            // SAFETY: `aces` yields allow ACEs of the DACL self holds.
            let (header, mut mask, trustee) = unsafe { ((*ace).Header, (*ace).Mask, ace_sid(ace)) };
            if ACE_FLAGS(u32::from(header.AceFlags)).contains(INHERIT_ONLY_ACE) {
                continue;
            }
            // SAFETY: both pointers are live locals.
            unsafe { MapGenericMask(&mut mask, &FILE_MAPPING) };
            if mask & READ_EXECUTE != READ_EXECUTE {
                continue;
            }
            // SAFETY: every SID is valid for the length of the calls.
            unsafe {
                if EqualSid(trustee, sid).is_ok() {
                    return Ok(true);
                }
                any_found |= EqualSid(trustee, any.sid()).is_ok();
                restricted_found |= EqualSid(trustee, restricted.sid()).is_ok();
            }
        }
        Ok(any_found && restricted_found)
    }
}

/// The SID an allow ACE names. It runs from `SidStart` to the ACE's end.
///
/// # Safety
/// `ace` points at a live allow ACE.
unsafe fn ace_sid(ace: *const ACCESS_ALLOWED_ACE) -> PSID {
    PSID(addr_of!((*ace).SidStart).cast_mut().cast())
}
