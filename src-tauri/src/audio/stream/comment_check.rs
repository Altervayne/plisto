/*
 * A streaming check of a Vorbis comment, as symphonia 0.5.5's metadata reader parses it: a vendor
 * string, a comment count, then each comment at its declared length. symphonia allocates each
 * comment at that length before reading it, and a comment whose key is `METADATA_BLOCK_PICTURE`
 * (compared after Unicode lower-casing of the lossy UTF-8 key) is base64-decoded and parsed as a
 * FLAC picture block, whose MIME, description and data lengths it allocates in turn. Every one of
 * those lengths must fit in the bytes that follow it.
 *
 * The check holds no comment: only the key, up to the longest one that can lower-case to the
 * picture key, and the base64 symbols of the current group.
 */

// -- Local Imports --
use super::guard::Refused;

const PICTURE_KEY: &str = "metadata_block_picture";

// The longest raw key that can lower-case to the picture key, with room to spare: its one 'k'
// written as KELVIN SIGN (three UTF-8 bytes), the one non-ASCII character that lower-cases to an
// ASCII letter of the key, makes it 24 bytes.
const KEY_MAX: usize = 26;

/// A FLAC picture block's length fields, checked as its bytes stream by.
#[derive(Clone)]
pub(crate) struct PictureCheck {
    step: u8,
    field: [u8; 4],
    got: usize,
    skip: u64,
}

impl PictureCheck {
    pub(crate) fn new() -> Self {
        Self {
            step: 0,
            field: [0; 4],
            got: 0,
            skip: 0,
        }
    }

    pub(crate) fn feed(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if self.skip > 0 {
                let n = self.skip.min(bytes.len() as u64);
                self.skip -= n;
                bytes = &bytes[n as usize..];
                continue;
            }
            if self.step >= 4 {
                return;
            }
            let n = (4 - self.got).min(bytes.len());
            self.field[self.got..self.got + n].copy_from_slice(&bytes[..n]);
            self.got += n;
            bytes = &bytes[n..];
            if self.got < 4 {
                return;
            }
            self.got = 0;
            let value = u32::from_be_bytes(self.field) as u64;
            // Type, MIME length, description length (then four u32), data length.
            self.skip = match self.step {
                0 => 0,
                1 => value,
                2 => value + 16,
                _ => value,
            };
            self.step += 1;
        }
    }

    /// A declared length that runs past the end is one symphonia allocates before failing.
    pub(crate) fn finish(&self) -> Result<(), Refused> {
        if self.skip > 0 {
            return Err(Refused);
        }
        Ok(())
    }
}

// The value of a picture comment, base64-decoded on the fly into a picture check.
#[derive(Clone)]
struct Base64Picture {
    group: [u8; 4],
    got: usize,
    // '=' seen at the end so far: symphonia trims a trailing run; one followed by a symbol is
    // invalid.
    padding: bool,
    valid: bool,
    picture: PictureCheck,
}

fn symbol(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

impl Base64Picture {
    fn new() -> Self {
        Self {
            group: [0; 4],
            got: 0,
            padding: false,
            valid: true,
            picture: PictureCheck::new(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if !self.valid {
                return;
            }
            if b == b'=' {
                self.padding = true;
                continue;
            }
            match symbol(b) {
                Some(v) if !self.padding => {
                    self.group[self.got] = v;
                    self.got += 1;
                    if self.got == 4 {
                        let g = self.group;
                        self.picture.feed(&[
                            (g[0] << 2) | (g[1] >> 4),
                            (g[1] << 4) | (g[2] >> 2),
                            (g[2] << 6) | g[3],
                        ]);
                        self.got = 0;
                    }
                }
                _ => self.valid = false,
            }
        }
    }

    fn finish(&mut self) -> Result<(), Refused> {
        if !self.valid || self.got == 1 {
            // symphonia drops an invalid encoding without parsing it.
            return Ok(());
        }
        let g = self.group;
        if self.got >= 2 {
            self.picture.feed(&[(g[0] << 2) | (g[1] >> 4)]);
        }
        if self.got == 3 {
            self.picture.feed(&[(g[1] << 4) | (g[2] >> 2)]);
        }
        self.picture.finish()
    }
}

#[derive(Clone)]
enum Value {
    Key {
        raw: [u8; KEY_MAX],
        len: usize,
        long: bool,
    },
    Plain,
    Picture(Box<Base64Picture>),
}

#[derive(Clone)]
enum Step {
    Vendor,
    Count,
    Length,
    Comment { left: u64, value: Value },
    Done,
}

/// The whole-comment check: fed the comment bytes after its packet or block header.
#[derive(Clone)]
pub(crate) struct CommentCheck {
    step: Step,
    field: [u8; 4],
    got: usize,
    skip: u64,
    comments: u64,
    bad: bool,
}

impl CommentCheck {
    pub(crate) fn new() -> Self {
        Self {
            step: Step::Vendor,
            field: [0; 4],
            got: 0,
            skip: 0,
            comments: 0,
            bad: false,
        }
    }

    pub(crate) fn feed(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if self.skip > 0 {
                let n = self.skip.min(bytes.len() as u64);
                self.skip -= n;
                bytes = &bytes[n as usize..];
                continue;
            }
            if let Step::Comment { left, value } = &mut self.step {
                let n = (*left).min(bytes.len() as u64) as usize;
                value_feed(value, &bytes[..n]);
                *left -= n as u64;
                bytes = &bytes[n..];
                if *left == 0 {
                    if let Value::Picture(p) = value {
                        if p.finish().is_err() {
                            self.bad = true;
                        }
                    }
                    self.next_comment();
                }
                continue;
            }
            if matches!(self.step, Step::Done) {
                return;
            }
            let n = (4 - self.got).min(bytes.len());
            self.field[self.got..self.got + n].copy_from_slice(&bytes[..n]);
            self.got += n;
            bytes = &bytes[n..];
            if self.got < 4 {
                return;
            }
            self.got = 0;
            let value = u32::from_le_bytes(self.field) as u64;
            match self.step {
                Step::Vendor => {
                    self.skip = value;
                    self.step = Step::Count;
                }
                Step::Count => {
                    self.comments = value;
                    self.step = if value == 0 { Step::Done } else { Step::Length };
                }
                Step::Length => {
                    self.step = Step::Comment {
                        left: value,
                        value: Value::Key {
                            raw: [0; KEY_MAX],
                            len: 0,
                            long: false,
                        },
                    };
                    if value == 0 {
                        self.next_comment();
                    }
                }
                _ => {}
            }
        }
    }

    fn next_comment(&mut self) {
        self.comments -= 1;
        self.step = if self.comments == 0 {
            Step::Done
        } else {
            Step::Length
        };
    }

    /// Refuses a comment whose declared lengths run past the bytes given, or whose picture does.
    pub(crate) fn finish(&self) -> Result<(), Refused> {
        if self.bad || self.skip > 0 || matches!(self.step, Step::Comment { .. }) {
            return Err(Refused);
        }
        Ok(())
    }
}

// Feeds comment bytes: the key until '=', then the value, decoded when the key is the picture key.
fn value_feed(value: &mut Value, mut bytes: &[u8]) {
    if let Value::Key { raw, len, long } = value {
        match bytes.iter().position(|&b| b == b'=') {
            None => {
                let n = (KEY_MAX - *len).min(bytes.len());
                raw[*len..*len + n].copy_from_slice(&bytes[..n]);
                *len += n;
                if n < bytes.len() {
                    *long = true;
                }
                return;
            }
            Some(at) => {
                let n = (KEY_MAX - *len).min(at);
                raw[*len..*len + n].copy_from_slice(&bytes[..n]);
                *len += n;
                let is_picture = !*long
                    && n == at
                    && String::from_utf8_lossy(&raw[..*len]).to_lowercase() == PICTURE_KEY;
                *value = if is_picture {
                    Value::Picture(Box::new(Base64Picture::new()))
                } else {
                    Value::Plain
                };
                bytes = &bytes[at + 1..];
            }
        }
    }
    if let Value::Picture(p) = value {
        p.feed(bytes);
    }
}

#[cfg(test)]
mod tests;
