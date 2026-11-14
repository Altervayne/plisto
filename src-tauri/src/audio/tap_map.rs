/*
 * The tap region in a named file mapping, so a reader in another process sees the same layout v1
 * header and ring the engine writes. The mapping is backed by the paging file, which the system hands
 * out zeroed, and is named `Local\plisto-tap-<pid>-<nonce>`: that name is all a reader needs. The
 * name exists from the moment the mapping does, before the header is written; `open` refuses a region
 * whose header is not v1, which is what keeps a reader from trusting a half-built one.
 *
 * The mapping carries an owner-only DACL: the user this process runs as gets full access and no one
 * else gets any. With no explicit label the system treats it as medium integrity with no-write-up, so
 * a lower-integrity process of the same user can read it but not write it. A region holds its handle
 * and view until it drops; a reader's own handle keeps the memory alive after the creator lets go.
 */

// -- Local Imports --
use super::tap::{TAP_CAPACITY, TAP_SAMPLES_OFFSET};

/// Bytes in a tap mapping: the header page, then the sample ring.
pub const TAP_MAP_BYTES: usize = TAP_SAMPLES_OFFSET + TAP_CAPACITY * 4;

#[cfg(windows)]
pub use imp::MappedRegion;
#[cfg(not(windows))]
pub use stub::MappedRegion;

#[cfg(windows)]
mod imp {
    use std::hash::{BuildHasher, Hasher};
    use std::io;
    use std::sync::atomic::AtomicU32;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, BOOL, ERROR_ALREADY_EXISTS, HANDLE, HLOCAL,
        INVALID_HANDLE_VALUE,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows::Win32::System::Memory::{
        CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP,
        FILE_MAP_ALL_ACCESS, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::TAP_MAP_BYTES;
    use crate::audio::tap::{
        TapHeader, TapRegion, TAP_CAPACITY, TAP_LAYOUT_VERSION, TAP_MAGIC, TAP_SAMPLES_OFFSET,
        TAP_SEGMENTS,
    };

    /// A tap region in a named mapping: the writable one the engine creates, or a read-only view a
    /// reader opens by name.
    pub struct MappedRegion {
        name: String,
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
    }

    // SAFETY: the view is shared memory reached only through atomics, and the handle is a kernel
    // object usable from any thread.
    unsafe impl Send for MappedRegion {}
    // SAFETY: as above; no method mutates the struct itself.
    unsafe impl Sync for MappedRegion {}

    impl MappedRegion {
        /// Creates a zeroed mapping under a new name and writes the v1 header into it.
        pub fn create() -> io::Result<Self> {
            let name = format!(r"Local\plisto-tap-{}-{:016x}", std::process::id(), nonce());
            let wide = wide(&name);
            let descriptor = OwnerOnly::new()?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0 .0,
                bInheritHandle: BOOL(0),
            };
            // SAFETY: a paging-file mapping with a live descriptor and a NUL-terminated name.
            let handle = unsafe {
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    Some(&attributes),
                    PAGE_READWRITE,
                    0,
                    TAP_MAP_BYTES as u32,
                    PCWSTR(wide.as_ptr()),
                )
            }
            .map_err(io::Error::from)?;
            // SAFETY: reads the calling thread's last error, set by the call just above.
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                // The name is taken: the handle is to someone else's mapping.
                close(handle);
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            let region = Self::map(name, handle, FILE_MAP_ALL_ACCESS)?;
            // SAFETY: the view is page-aligned, TAP_MAP_BYTES long and writable, and no reference
            // into it exists yet in this process.
            unsafe { std::ptr::write(region.view.Value.cast::<TapHeader>(), TapHeader::new()) };
            Ok(region)
        }

        /// Opens a mapping by name, read-only, as a reader in another process does. Fails when the
        /// name is unknown or its header is not tap layout v1.
        pub fn open(name: &str) -> io::Result<Self> {
            let wide = wide(name);
            // SAFETY: a NUL-terminated name and a plain access mask.
            let handle = unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(wide.as_ptr())) }
                .map_err(io::Error::from)?;
            let region = Self::map(name.to_owned(), handle, FILE_MAP_READ)?;
            let header = region.header();
            if header.magic != TAP_MAGIC
                || header.layout_version != TAP_LAYOUT_VERSION
                || header.capacity as usize != TAP_CAPACITY
                || header.segment_count as usize != TAP_SEGMENTS
            {
                return Err(io::Error::from(io::ErrorKind::InvalidData));
            }
            Ok(region)
        }

        /// The name a reader opens.
        pub fn name(&self) -> &str {
            &self.name
        }

        /// The mapping's DACL in SDDL, and the SID of the user this process runs as.
        #[cfg(test)]
        pub(in crate::audio) fn dacl_and_user(&self) -> (String, String) {
            use windows::Win32::Security::Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
                SE_KERNEL_OBJECT,
            };
            use windows::Win32::Security::DACL_SECURITY_INFORMATION;

            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let mut text = PWSTR::null();
            // SAFETY: test-only queries on this region's own handle; both outputs are freed below.
            let sddl = unsafe {
                let status = GetSecurityInfo(
                    self.handle,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    None,
                    None,
                    Some(&mut descriptor),
                );
                assert!(status.is_ok(), "reads the descriptor");
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    None,
                )
                .expect("formats the descriptor");
                let sddl = text.to_string().expect("utf-16");
                LocalFree(HLOCAL(text.0.cast()));
                LocalFree(HLOCAL(descriptor.0));
                sddl
            };
            (sddl, current_user_sid().expect("reads the user"))
        }

        // Maps the whole region. Takes ownership of `handle`: it is closed when mapping fails.
        fn map(name: String, handle: HANDLE, access: FILE_MAP) -> io::Result<Self> {
            // SAFETY: a valid mapping handle; a mapping smaller than TAP_MAP_BYTES fails here.
            let view = unsafe { MapViewOfFile(handle, access, 0, 0, TAP_MAP_BYTES) };
            if view.Value.is_null() {
                let err = io::Error::last_os_error();
                close(handle);
                return Err(err);
            }
            Ok(Self { name, handle, view })
        }
    }

    impl TapRegion for MappedRegion {
        #[inline]
        fn header(&self) -> &TapHeader {
            // SAFETY: the view starts with a v1 header and lives as long as `self`.
            unsafe { &*self.view.Value.cast::<TapHeader>() }
        }

        #[inline]
        fn samples(&self) -> &[AtomicU32] {
            // SAFETY: the ring starts at TAP_SAMPLES_OFFSET, page-aligned, and holds TAP_CAPACITY
            // slots inside the view, which lives as long as `self`.
            unsafe {
                std::slice::from_raw_parts(
                    self.view
                        .Value
                        .cast::<u8>()
                        .add(TAP_SAMPLES_OFFSET)
                        .cast::<AtomicU32>(),
                    TAP_CAPACITY,
                )
            }
        }
    }

    impl Drop for MappedRegion {
        fn drop(&mut self) {
            // SAFETY: the view is this region's own and is released once, here.
            let _ = unsafe { UnmapViewOfFile(self.view) };
            close(self.handle);
        }
    }

    /// A self-relative security descriptor granting GENERIC_ALL to the current process's user and
    /// nothing to anyone else, protected from inherited entries. Freed on drop.
    struct OwnerOnly(PSECURITY_DESCRIPTOR);

    impl OwnerOnly {
        fn new() -> io::Result<Self> {
            let sid = current_user_sid()?;
            let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            // SAFETY: a NUL-terminated SDDL string and an out pointer this struct then owns.
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl.as_ptr()),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    None,
                )
            }
            .map_err(io::Error::from)?;
            Ok(Self(descriptor))
        }
    }

    impl Drop for OwnerOnly {
        fn drop(&mut self) {
            // SAFETY: the descriptor was allocated by the conversion above and is freed once.
            unsafe { LocalFree(HLOCAL(self.0 .0)) };
        }
    }

    // The string SID of the user this process runs as.
    fn current_user_sid() -> io::Result<String> {
        let mut token = HANDLE::default();
        // SAFETY: queries this process's own token into a handle closed below.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
            .map_err(io::Error::from)?;
        let sid = token_user_sid(token);
        close(token);
        sid
    }

    fn token_user_sid(token: HANDLE) -> io::Result<String> {
        let mut len = 0u32;
        // SAFETY: a size query with no buffer; it fails with the size needed, which is the point.
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut len) };
        // u64 words, so the TOKEN_USER read below is aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: the buffer holds at least `len` bytes.
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr().cast()),
                len,
                &mut len,
            )
        }
        .map_err(io::Error::from)?;
        // SAFETY: the call filled the buffer with a TOKEN_USER, whose SID points inside it.
        let user = unsafe { &*buf.as_ptr().cast::<TOKEN_USER>() };
        let mut text = PWSTR::null();
        // SAFETY: a valid SID in, a LocalAlloc'd string out, freed below.
        unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) }.map_err(io::Error::from)?;
        // SAFETY: the string is NUL-terminated and freed once after it is copied.
        let sid = unsafe { text.to_string() };
        unsafe { LocalFree(HLOCAL(text.0.cast())) };
        sid.map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
    }

    fn close(handle: HANDLE) {
        // SAFETY: the handle is owned by the caller and not used after this.
        let _ = unsafe { CloseHandle(handle) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // A per-call random value from the standard library's randomly keyed hasher.
    fn nonce() -> u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        );
        h.finish()
    }
}

#[cfg(not(windows))]
mod stub {
    use std::io;
    use std::sync::atomic::AtomicU32;

    use crate::audio::tap::{TapHeader, TapRegion};

    /// Named mappings are Windows-only; elsewhere the tap has no cross-process region and this
    /// type cannot be built.
    pub struct MappedRegion {
        never: std::convert::Infallible,
    }

    impl MappedRegion {
        pub fn create() -> io::Result<Self> {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        }

        pub fn open(_name: &str) -> io::Result<Self> {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        }

        pub fn name(&self) -> &str {
            match self.never {}
        }
    }

    impl TapRegion for MappedRegion {
        fn header(&self) -> &TapHeader {
            match self.never {}
        }

        fn samples(&self) -> &[AtomicU32] {
            match self.never {}
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::audio::tap::tests::{
        check_gapless_boundary, check_inactive_writes_nothing, check_output_bit_for_bit,
        check_overrun, check_seek_epoch, check_torn_read, segment, STEREO,
    };
    use crate::audio::tap::{Segment, TapHeader, TapReader, TapRegion, TapSlot, TAP_MAGIC};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn mapped_slot() -> Arc<TapSlot> {
        Arc::new(TapSlot::new(
            MappedRegion::create().expect("creates the mapping"),
        ))
    }

    #[test]
    fn a_second_handle_reads_what_the_writer_wrote() {
        let created = MappedRegion::create().expect("creates the mapping");
        let name = created.name().to_owned();
        assert!(name.starts_with(&format!(r"Local\plisto-tap-{}-", std::process::id())));
        let slot = Arc::new(TapSlot::new(created));
        slot.set_active(true);
        let mut w = slot.cold();
        assert!(w.refill(STEREO));
        for i in 0..1_000 {
            w.push(i as f32 * 0.001);
        }
        w.publish();

        let opened = MappedRegion::open(&name).expect("opens by name");
        let writer_view = slot.region().expect("installed").header() as *const TapHeader;
        assert_ne!(opened.header() as *const TapHeader, writer_view);
        let header = opened.header();
        assert_eq!(header.magic, TAP_MAGIC);
        assert_eq!(header.layout_version, 1);
        assert_eq!(header.capacity as usize, TAP_CAPACITY);
        assert_eq!(header.write_cursor.load(Ordering::Acquire), 1_000);

        let mut reader = TapReader::at(0, 0);
        let mut out = vec![0.0; 1_000];
        assert_eq!(reader.read(&opened, &mut out), Ok(1_000));
        let expect: Vec<f32> = (0..1_000).map(|i| i as f32 * 0.001).collect();
        assert_eq!(out, expect);
        let segs: Vec<Segment> =
            std::iter::from_fn(|| reader.next_segment(&opened).unwrap()).collect();
        assert_eq!(segs, vec![segment(0, 1, STEREO)]);
    }

    #[test]
    fn the_memory_outlives_the_creator_while_a_reader_holds_it() {
        let created = MappedRegion::create().expect("creates the mapping");
        let name = created.name().to_owned();
        let opened = MappedRegion::open(&name).expect("opens by name");
        drop(created);
        assert_eq!(opened.header().magic, TAP_MAGIC);
        drop(opened);
        assert!(MappedRegion::open(&name).is_err());
    }

    #[test]
    fn only_the_current_user_may_open_the_mapping() {
        let region = MappedRegion::create().expect("creates the mapping");
        let (dacl, user) = region.dacl_and_user();
        // One allow entry, for this user, protected from inheritance.
        assert!(dacl.starts_with("D:P("), "{dacl}");
        assert_eq!(dacl.matches('(').count(), 1, "{dacl}");
        assert!(dacl.ends_with(&format!(";;;{user})")), "{dacl}");
    }

    #[test]
    fn an_unknown_name_does_not_open() {
        assert!(MappedRegion::open(r"Local\plisto-tap-0-none").is_err());
    }

    #[test]
    fn a_mapped_tap_is_the_source_output_bit_for_bit() {
        check_output_bit_for_bit(mapped_slot());
    }

    #[test]
    fn an_inactive_mapped_slot_writes_nothing() {
        check_inactive_writes_nothing(mapped_slot());
    }

    #[test]
    fn a_mapped_gapless_pair_records_the_boundary_cursor() {
        check_gapless_boundary(mapped_slot());
    }

    #[test]
    fn a_mapped_seek_starts_a_new_epoch() {
        check_seek_epoch(mapped_slot());
    }

    #[test]
    fn a_lagging_reader_of_a_mapping_detects_overrun() {
        check_overrun(mapped_slot());
    }

    #[test]
    fn a_torn_read_of_a_mapping_is_detected() {
        check_torn_read(mapped_slot());
    }
}
