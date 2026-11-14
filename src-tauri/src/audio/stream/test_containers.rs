/*
 * Ogg pages and MP4 files built byte by byte for the stream tests, so a test can set any size
 * field to any value. The M4A carries the same silent AAC-LC frames as the ADTS builder, and can
 * hold cover art, an edit list, an ALAC entry or 64-bit chunk offsets.
 */

// -- Library Imports --
use symphonia::core::checksum::Crc32;
use symphonia::core::io::Monitor;

// -- Local Imports --
use super::test_media::flac_bytes;

// ---- Ogg ----

/// Page flags.
pub const CONTINUED: u8 = 0x01;
pub const FIRST: u8 = 0x02;

/// One Ogg page holding `packets`; with `open_last` the last one continues on the next page, so
/// its length must be a multiple of 255.
pub fn ogg_page(serial: u32, seq: u32, flags: u8, packets: &[&[u8]], open_last: bool) -> Vec<u8> {
    let mut table = Vec::new();
    let mut body = Vec::new();
    for (i, p) in packets.iter().enumerate() {
        let open = open_last && i + 1 == packets.len();
        let mut left = p.len();
        while left >= 255 {
            table.push(255u8);
            left -= 255;
        }
        if open {
            assert_eq!(left, 0, "an open packet fills whole segments");
        } else {
            table.push(left as u8);
        }
        body.extend_from_slice(p);
    }
    assert!(table.len() <= 255);
    let mut v = b"OggS\x00".to_vec();
    v.push(flags);
    v.extend_from_slice(&0u64.to_le_bytes());
    v.extend_from_slice(&serial.to_le_bytes());
    v.extend_from_slice(&seq.to_le_bytes());
    v.extend_from_slice(&[0; 4]);
    v.push(table.len() as u8);
    v.extend(table);
    v.extend(body);
    let mut crc = Crc32::new(0);
    crc.process_buf_bytes(&v);
    let sum = crc.crc();
    v[22..26].copy_from_slice(&sum.to_le_bytes());
    v
}

/// A Vorbis identification header: mono 44.1 kHz, block sizes 256 and 2,048.
pub fn vorbis_ident() -> Vec<u8> {
    let mut v = b"\x01vorbis".to_vec();
    v.extend_from_slice(&0u32.to_le_bytes());
    v.push(1);
    v.extend_from_slice(&44_100u32.to_le_bytes());
    v.extend_from_slice(&[0; 12]);
    v.push(0xB8);
    v.push(1);
    v
}

/// A Vorbis comment body (no packet prefix): a vendor and comments declared at `lens`, each holding
/// at most 8 bytes.
pub fn comment_body(lens: &[u32]) -> Vec<u8> {
    let mut v = 4u32.to_le_bytes().to_vec();
    v.extend_from_slice(b"test");
    v.extend_from_slice(&(lens.len() as u32).to_le_bytes());
    for &n in lens {
        v.extend_from_slice(&n.to_le_bytes());
        v.extend(std::iter::repeat_n(b'c', n.min(8) as usize));
    }
    v
}

/// An Opus identification header: mono, no pre-skip.
pub fn opus_head() -> Vec<u8> {
    let mut v = b"OpusHead".to_vec();
    v.extend_from_slice(&[1, 1, 0, 0]);
    v.extend_from_slice(&48_000u32.to_le_bytes());
    v.extend_from_slice(&[0, 0, 0]);
    v
}

/// A FLAC-in-Ogg identification header: the mapping header and the STREAMINFO block.
pub fn flac_ogg_ident() -> Vec<u8> {
    let mut v = b"\x7FFLAC\x01\x00\x00\x01fLaC".to_vec();
    v.extend_from_slice(&[0x00, 0x00, 0x00, 0x22]);
    v.extend_from_slice(&flac_bytes(1, 4_096)[8..42]);
    v
}

/// A Vorbis comment body (no packet prefix) holding `comments` as given.
pub fn comment_with(comments: &[&[u8]]) -> Vec<u8> {
    let mut v = 0u32.to_le_bytes().to_vec();
    v.extend_from_slice(&(comments.len() as u32).to_le_bytes());
    for c in comments {
        v.extend_from_slice(&(c.len() as u32).to_le_bytes());
        v.extend_from_slice(c);
    }
    v
}

/// Standard base64 with padding.
pub fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// A `METADATA_BLOCK_PICTURE` comment: a FLAC picture block declaring a MIME type of `mime_len`
/// bytes (holding "image/png") and `data` bytes of image data, all present.
pub fn picture_comment(mime_len: u32, data: usize) -> Vec<u8> {
    let mut pic = 3u32.to_be_bytes().to_vec();
    pic.extend_from_slice(&mime_len.to_be_bytes());
    pic.extend_from_slice(b"image/png");
    pic.extend_from_slice(&0u32.to_be_bytes());
    pic.extend_from_slice(&[0; 16]);
    pic.extend_from_slice(&(data as u32).to_be_bytes());
    pic.extend(std::iter::repeat_n(0x5A, data));
    let mut v = b"METADATA_BLOCK_PICTURE=".to_vec();
    v.extend_from_slice(base64(&pic).as_bytes());
    v
}

/// The byte length of the first `n` pages of an Ogg stream.
pub fn pages_len(bytes: &[u8], n: usize) -> usize {
    let mut at = 0;
    for _ in 0..n {
        let segments = bytes[at + 26] as usize;
        let body: usize = bytes[at + 27..at + 27 + segments]
            .iter()
            .map(|&b| b as usize)
            .sum();
        at += 27 + segments + body;
    }
    at
}

/// Packs (value, bit count) fields least-significant bit first behind the Vorbis setup signature.
pub fn vorbis_setup(fields: &[(u64, u32)]) -> Vec<u8> {
    let mut out = b"\x05vorbis".to_vec();
    let (mut acc, mut n) = (0u8, 0u32);
    for &(value, bits) in fields {
        for i in 0..bits {
            acc |= (((value >> i) & 1) as u8) << n;
            n += 1;
            if n == 8 {
                out.push(acc);
                acc = 0;
                n = 0;
            }
        }
    }
    if n > 0 {
        out.push(acc);
    }
    out
}

// ---- MP4 ----

/// One atom.
pub fn atom(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(kind);
    v.extend_from_slice(payload);
    v
}

fn full(version_flags: u32, rest: &[u8]) -> Vec<u8> {
    let mut v = version_flags.to_be_bytes().to_vec();
    v.extend_from_slice(rest);
    v
}

/// What an M4A built by `m4a` holds.
pub struct M4a {
    pub frames: usize,
    pub cover: usize,
    pub moov_last: bool,
    pub co64: bool,
    pub edit_list: bool,
    // An ALAC sample entry with this frame length, in place of AAC.
    pub alac_frame: Option<u32>,
}

impl Default for M4a {
    fn default() -> Self {
        Self {
            frames: 20,
            cover: 0,
            moov_last: false,
            co64: false,
            edit_list: false,
            alac_frame: None,
        }
    }
}

const RAW_SILENCE: [u8; 4] = [0x00, 0xC8, 0x00, 0x07];

/// Replaces the payload of a leaf atom of the given type, or keeps it.
pub type Patch<'a> = &'a dyn Fn(&[u8; 4], Vec<u8>) -> Vec<u8>;

/// An M4A of silent AAC-LC frames, mono 44.1 kHz. `patch` may replace the payload of any leaf atom
/// by its type.
pub fn m4a(spec: &M4a, patch: Patch<'_>) -> Vec<u8> {
    let n = spec.frames as u32;
    let leaf = |kind: &[u8; 4], payload: Vec<u8>| atom(kind, &patch(kind, payload));
    let ftyp = leaf(b"ftyp", b"M4A \x00\x00\x00\x00M4A isom".to_vec());
    let mdat = atom(b"mdat", &RAW_SILENCE.repeat(spec.frames));

    let build_moov = |offset: u64| {
        let matrix: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
        let matrix: Vec<u8> = matrix.iter().flat_map(|m| m.to_be_bytes()).collect();
        let mut mvhd = full(0, &[0; 8]);
        mvhd.extend_from_slice(&44_100u32.to_be_bytes());
        mvhd.extend_from_slice(&(n * 1_024).to_be_bytes());
        mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        mvhd.extend_from_slice(&0x0100u16.to_be_bytes());
        mvhd.extend_from_slice(&[0; 10]);
        mvhd.extend_from_slice(&matrix);
        mvhd.extend_from_slice(&[0; 24]);
        mvhd.extend_from_slice(&2u32.to_be_bytes());

        let mut tkhd = full(7, &[0; 8]);
        tkhd.extend_from_slice(&1u32.to_be_bytes());
        tkhd.extend_from_slice(&[0; 4]);
        tkhd.extend_from_slice(&(n * 1_024).to_be_bytes());
        tkhd.extend_from_slice(&[0; 8 + 2 + 2]);
        tkhd.extend_from_slice(&0x0100u16.to_be_bytes());
        tkhd.extend_from_slice(&[0; 2]);
        tkhd.extend_from_slice(&matrix);
        tkhd.extend_from_slice(&[0; 8]);

        let mut mdhd = full(0, &[0; 8]);
        mdhd.extend_from_slice(&44_100u32.to_be_bytes());
        mdhd.extend_from_slice(&(n * 1_024).to_be_bytes());
        mdhd.extend_from_slice(&[0x55, 0xC4, 0, 0]);
        let hdlr = full(
            0,
            b"\x00\x00\x00\x00soun\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00",
        );

        let entry = match spec.alac_frame {
            Some(frame) => {
                let mut cookie = frame.to_be_bytes().to_vec();
                cookie.extend_from_slice(&[0, 16, 40, 10, 14, 1, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
                cookie.extend_from_slice(&44_100u32.to_be_bytes());
                let mut body = sample_entry_fields();
                body.extend(leaf(b"alac", full(0, &cookie)));
                atom(b"alac", &body)
            }
            None => {
                let esds = full(
                    0,
                    &[
                        0x03, 25, 0x00, 0x01, 0x00, 0x04, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0,
                        0, 0, 0, 0x05, 0x02, 0x12, 0x08, 0x06, 0x01, 0x02,
                    ],
                );
                let mut body = sample_entry_fields();
                body.extend(leaf(b"esds", esds));
                atom(b"mp4a", &body)
            }
        };
        let mut stsd = full(0, &1u32.to_be_bytes());
        stsd.extend(entry);
        let mut stts = full(0, &1u32.to_be_bytes());
        stts.extend_from_slice(&n.to_be_bytes());
        stts.extend_from_slice(&1_024u32.to_be_bytes());
        let mut stsc = full(0, &1u32.to_be_bytes());
        for v in [1, n, 1] {
            stsc.extend_from_slice(&v.to_be_bytes());
        }
        let mut stsz = full(0, &0u32.to_be_bytes());
        stsz.extend_from_slice(&n.to_be_bytes());
        for _ in 0..n {
            stsz.extend_from_slice(&4u32.to_be_bytes());
        }
        let offsets = if spec.co64 {
            let mut co64 = full(0, &1u32.to_be_bytes());
            co64.extend_from_slice(&offset.to_be_bytes());
            leaf(b"co64", co64)
        } else {
            let mut stco = full(0, &1u32.to_be_bytes());
            stco.extend_from_slice(&(offset as u32).to_be_bytes());
            leaf(b"stco", stco)
        };
        let mut stbl = leaf(b"stsd", stsd);
        stbl.extend(leaf(b"stts", stts));
        stbl.extend(leaf(b"stsc", stsc));
        stbl.extend(leaf(b"stsz", stsz));
        stbl.extend(offsets);
        let mut minf = leaf(b"smhd", full(0, &[0; 4]));
        minf.extend(atom(b"stbl", &stbl));
        let mut mdia = leaf(b"mdhd", mdhd);
        mdia.extend(leaf(b"hdlr", hdlr));
        mdia.extend(atom(b"minf", &minf));
        let mut trak = leaf(b"tkhd", tkhd);
        if spec.edit_list {
            let mut elst = full(0, &1u32.to_be_bytes());
            elst.extend_from_slice(&(n * 1_024).to_be_bytes());
            elst.extend_from_slice(&0u32.to_be_bytes());
            elst.extend_from_slice(&[0, 1, 0, 0]);
            trak.extend(atom(b"edts", &leaf(b"elst", elst)));
        }
        trak.extend(atom(b"mdia", &mdia));

        let mut moov = leaf(b"mvhd", mvhd);
        moov.extend(atom(b"trak", &trak));
        if spec.cover > 0 {
            let mut data = full(13, &[0; 4]);
            data.extend(std::iter::repeat_n(0xAB, spec.cover));
            let ilst = atom(b"covr", &leaf(b"data", data));
            let mut meta = full(0, &[]);
            meta.extend(leaf(
                b"hdlr",
                full(
                    0,
                    b"\x00\x00\x00\x00mdirappl\x00\x00\x00\x00\x00\x00\x00\x00\x00",
                ),
            ));
            meta.extend(atom(b"ilst", &ilst));
            moov.extend(atom(b"udta", &atom(b"meta", &meta)));
        }
        atom(b"moov", &moov)
    };

    // The chunk offset is a fixed-size field, so the moov length does not depend on its value.
    let moov_len = build_moov(0).len() as u64;
    let mut out = ftyp.clone();
    if spec.moov_last {
        out.extend(&mdat);
        out.extend(build_moov(ftyp.len() as u64 + 8));
    } else {
        out.extend(build_moov(ftyp.len() as u64 + moov_len + 8));
        out.extend(&mdat);
    }
    out
}

// The fixed fields of a version 0 audio sample entry: mono, 16-bit, 44.1 kHz.
fn sample_entry_fields() -> Vec<u8> {
    let mut v = vec![0u8; 6];
    v.extend_from_slice(&1u16.to_be_bytes());
    v.extend_from_slice(&[0; 8]);
    v.extend_from_slice(&1u16.to_be_bytes());
    v.extend_from_slice(&16u16.to_be_bytes());
    v.extend_from_slice(&[0; 4]);
    v.extend_from_slice(&(44_100u32 << 16).to_be_bytes());
    v
}

/// Finds the first atom of `kind` in `file` and adds `delta` to its 32-bit size field.
pub fn grow_atom(file: &mut [u8], kind: &[u8; 4], delta: u32) {
    let at = file
        .windows(4)
        .position(|w| w == kind)
        .expect("the atom is present")
        - 4;
    let size = u32::from_be_bytes([file[at], file[at + 1], file[at + 2], file[at + 3]]);
    file[at..at + 4].copy_from_slice(&(size + delta).to_be_bytes());
}
