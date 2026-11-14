/*
 * A walk over the codebooks of a Vorbis setup header, to bound what decoding it would allocate.
 *
 * symphonia 0.5.5's Vorbis decoder builds every codebook from the setup header as soon as the
 * decoder is made: a code-length list and a value list sized by the book's entry count, for lookup
 * types 1 and 2 a lookup table of entries x dimensions values, and a decoding table of 256 entries
 * for every distinct 8-bit step of every codeword (symphonia's codebook builder reads 8 bits at a
 * time). This walk reads the codebook section as the Vorbis I specification lays it out (section
 * 3.2.1), rebuilds the codewords as symphonia does, counts those steps, and refuses a setup past
 * the bounds below. The floor, residue, mapping and mode sections after the codebooks size nothing
 * from the input beyond small fixed bit widths and are not read.
 *
 * The libvorbis decoder refuses a book with ilog(dimensions) + ilog(entries) > 24; the libvorbis
 * encoder's own books stay at hundreds to a few thousand entries with short codewords. With these
 * bounds one decoding table is at most 1,024 x 256 entries of 8 bytes, 2 MiB (2,105,344 bytes
 * measured on symphonia's decoder for the worst book admitted), a setup's tables at most four
 * times that, and its lookup tables at most 4 MiB in all.
 */

// -- Local Imports --
use super::guard::Refused;

/// The most entries in one Vorbis codebook.
pub const VORBIS_ENTRIES_MAX: u32 = 1 << 16;

/// The most lookup values (entries x dimensions) in one Vorbis codebook.
pub const VORBIS_BOOK_VALUES_MAX: u64 = 1 << 18;

/// The most lookup values across all the codebooks of one setup header.
pub const VORBIS_SETUP_VALUES_MAX: u64 = 1 << 20;

/// The most entries across all the codebooks of one setup header: each entry costs the decoder a
/// code length, a value and a codeword.
pub const VORBIS_SETUP_ENTRIES_MAX: u64 = 1 << 20;

/// The most 256-entry decoding blocks in one codebook.
pub const VORBIS_BOOK_BLOCKS_MAX: usize = 1_024;

/// The most 256-entry decoding blocks across all the codebooks of one setup header.
pub const VORBIS_SETUP_BLOCKS_MAX: usize = 4_096;

/// The largest Vorbis setup header packet.
pub const VORBIS_SETUP_MAX: usize = 256 * 1_024;

// Reads bits least-significant first, as Vorbis packs them. Running past the end is refused: the
// decoder would fail there too.
struct Bits<'a> {
    data: &'a [u8],
    bit: usize,
}

impl Bits<'_> {
    fn read(&mut self, n: u32) -> Result<u32, Refused> {
        let mut out = 0u32;
        for i in 0..n {
            let byte = *self.data.get(self.bit / 8).ok_or(Refused)?;
            out |= (((byte >> (self.bit % 8)) & 1) as u32) << i;
            self.bit += 1;
        }
        Ok(out)
    }

    fn skip(&mut self, n: u64) -> Result<(), Refused> {
        let end = (self.bit as u64).checked_add(n).ok_or(Refused)?;
        if end > self.data.len() as u64 * 8 {
            return Err(Refused);
        }
        self.bit = end as usize;
        Ok(())
    }
}

// The bits needed to hold `v`: 0 for 0.
fn ilog(v: u32) -> u32 {
    32 - v.leading_zeros()
}

// symphonia's lookup type 1 value count, computed in f32 as it does, then the two asserts it makes
// on it. A pair that would trip either assert, or overflow on the way, is refused here.
fn lookup1_values(entries: u32, dims: u32) -> Result<u32, Refused> {
    let value = (entries as f32).powf(1.0f32 / dims as f32).floor() as u32;
    let fits = value.checked_pow(dims).ok_or(Refused)? <= entries;
    let next = value
        .checked_add(1)
        .and_then(|v| v.checked_pow(dims))
        .ok_or(Refused)?;
    if !fits || next <= entries {
        return Err(Refused);
    }
    Ok(value)
}

// The codewords symphonia assigns to `lens`, in its own order. None where symphonia refuses the
// book (over- or under-specified) and builds no table; a length or step that would panic it is
// refused.
fn codewords(lens: &[u8], out: &mut Vec<u32>) -> Result<Option<()>, Refused> {
    out.clear();
    let mut next = [0u32; 33];
    let mut sparse = 0;
    for &len in lens {
        if len == 0 {
            sparse += 1;
            out.push(0);
            continue;
        }
        if len > 32 {
            return Err(Refused);
        }
        let n = len as usize;
        let code = next[n];
        if len < 32 && (code >> len) > 0 {
            return Ok(None);
        }
        for i in (0..=n).rev() {
            if next[i] & 1 == 1 {
                if i == 0 {
                    return Err(Refused);
                }
                next[i] = next[i - 1] << 1;
                break;
            }
            next[i] = next[i].checked_add(1).ok_or(Refused)?;
        }
        let branch = next[n];
        for (i, nx) in next[n..].iter_mut().enumerate().skip(1) {
            if *nx == code << i {
                *nx = branch << i;
            } else {
                break;
            }
        }
        out.push(code);
    }
    let under = next
        .iter()
        .enumerate()
        .skip(1)
        .any(|(i, &c)| c & (u32::MAX >> (32 - i)) != 0);
    if under && lens.len() - sparse != 1 {
        return Ok(None);
    }
    Ok(Some(()))
}

// The 256-entry blocks symphonia's codebook builder makes: the root, and one for every distinct
// leading 8, 16 or 24 bits of a codeword longer than that.
fn blocks(lens: &[u8], codes: &[u32], scratch: &mut Vec<u32>) -> usize {
    let mut total = 1;
    for level in 1..=3u32 {
        scratch.clear();
        for (&len, &code) in lens.iter().zip(codes) {
            let len = len as u32;
            if len > 8 * level {
                scratch.push(code >> (len - 8 * level));
            }
        }
        scratch.sort_unstable();
        scratch.dedup();
        total += scratch.len();
    }
    total
}

/// Checks the codebooks of a complete setup header packet (`0x05 "vorbis"` first).
pub(crate) fn check_setup(packet: &[u8]) -> Result<(), Refused> {
    if packet.len() < 7 || packet.len() > VORBIS_SETUP_MAX {
        return Err(Refused);
    }
    let mut bits = Bits {
        data: &packet[7..],
        bit: 0,
    };
    let books = bits.read(8)? + 1;
    let (mut values_total, mut entries_total, mut blocks_total) = (0u64, 0u64, 0usize);
    let (mut lens, mut codes, mut scratch) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..books {
        if bits.read(24)? != 0x56_4342 {
            return Err(Refused);
        }
        let dims = bits.read(16)?;
        let entries = bits.read(24)?;
        entries_total += entries as u64;
        if entries > VORBIS_ENTRIES_MAX || entries_total > VORBIS_SETUP_ENTRIES_MAX {
            return Err(Refused);
        }
        lens.clear();
        if bits.read(1)? == 0 {
            let sparse = bits.read(1)? == 1;
            for _ in 0..entries {
                let used = !sparse || bits.read(1)? == 1;
                lens.push(if used { bits.read(5)? as u8 + 1 } else { 0 });
            }
        } else {
            let mut current = 0u32;
            let mut len = bits.read(5)? + 1;
            loop {
                let num = bits.read(ilog(entries.saturating_sub(current)))?;
                if num > 0 && len > 32 {
                    return Err(Refused);
                }
                lens.extend(std::iter::repeat_n(len as u8, num as usize));
                len += 1;
                current += num;
                if current > entries {
                    return Err(Refused);
                }
                if current == entries {
                    break;
                }
            }
        }
        if codewords(&lens, &mut codes)?.is_some() {
            let count = blocks(&lens, &codes, &mut scratch);
            blocks_total += count;
            if count > VORBIS_BOOK_BLOCKS_MAX || blocks_total > VORBIS_SETUP_BLOCKS_MAX {
                return Err(Refused);
            }
        }
        match bits.read(4)? {
            0 => {}
            lookup @ (1 | 2) => {
                let values = entries as u64 * dims as u64;
                values_total += values;
                if dims == 0
                    || values > VORBIS_BOOK_VALUES_MAX
                    || values_total > VORBIS_SETUP_VALUES_MAX
                {
                    return Err(Refused);
                }
                bits.skip(64)?;
                let value_bits = bits.read(4)? as u64 + 1;
                bits.skip(1)?;
                let count = if lookup == 1 {
                    lookup1_values(entries, dims)? as u64
                } else {
                    values
                };
                bits.skip(count * value_bits)?;
            }
            _ => return Err(Refused),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
