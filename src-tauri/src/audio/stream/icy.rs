/*
 * The ICY (Shoutcast) metadata stripper. A server that sends `icy-metaint: N` interleaves a block
 * after every N audio bytes: one length byte L, then L x 16 bytes of `Key='value';` text, padded.
 * The blocks must come out before the bytes reach a decoder. Pure: bytes in, audio bytes and the
 * latest `StreamTitle` out, in whatever pieces the network delivers.
 *
 * Real servers bend the block format (spaces between entries, padding that is not NUL, a missing
 * final semicolon), so the parse is lenient: it looks for `StreamTitle='` and never fails. A block
 * it cannot read changes nothing. The stripping itself only trusts the length byte.
 */

/// The largest `icy-metaint` honored.
pub const ICY_METAINT_MAX: u32 = 65_536;

enum State {
    Audio { left: usize },
    Length,
    Meta { left: usize },
}

/// Strips the metadata blocks out of one connection's body. A reconnect starts a new stripper: the
/// count restarts with each response.
pub struct IcyStripper {
    metaint: usize,
    state: State,
    block: Vec<u8>,
}

impl IcyStripper {
    /// None for a `metaint` outside 1 to `ICY_METAINT_MAX`.
    pub fn new(metaint: u32) -> Option<Self> {
        if metaint == 0 || metaint > ICY_METAINT_MAX {
            return None;
        }
        Some(Self {
            metaint: metaint as usize,
            state: State::Audio {
                left: metaint as usize,
            },
            block: Vec::new(),
        })
    }

    /// Appends the audio bytes of `input` to `audio`. Returns the title of the last complete block in
    /// `input` that carried one; `Some("")` is a title cleared by the server. The title is raw:
    /// UTF-8 when valid, else Latin-1, which can yield C1 control characters, so it must be
    /// sanitized before display.
    pub fn feed(&mut self, mut input: &[u8], audio: &mut Vec<u8>) -> Option<String> {
        let mut title = None;
        while !input.is_empty() {
            match self.state {
                State::Audio { left } => {
                    let n = left.min(input.len());
                    audio.extend_from_slice(&input[..n]);
                    input = &input[n..];
                    self.state = if n == left {
                        State::Length
                    } else {
                        State::Audio { left: left - n }
                    };
                }
                State::Length => {
                    let len = input[0] as usize * 16;
                    input = &input[1..];
                    self.state = if len == 0 {
                        State::Audio { left: self.metaint }
                    } else {
                        State::Meta { left: len }
                    };
                }
                State::Meta { left } => {
                    let n = left.min(input.len());
                    self.block.extend_from_slice(&input[..n]);
                    input = &input[n..];
                    if n < left {
                        self.state = State::Meta { left: left - n };
                        continue;
                    }
                    if let Some(t) = stream_title(&self.block) {
                        title = Some(t);
                    }
                    self.block.clear();
                    self.state = State::Audio { left: self.metaint };
                }
            }
        }
        title
    }
}

/// Reads `StreamTitle` from one block; every other field is ignored. The value runs to the first
/// `';`, so a quote inside a title survives; without one, to the last quote, or to the end of the
/// block short of its NUL padding. None when the block carries no title.
fn stream_title(block: &[u8]) -> Option<String> {
    const KEY: &[u8] = b"StreamTitle='";
    let at = (0..block.len()).find(|&i| {
        block[i..].starts_with(KEY)
            && (i == 0 || matches!(block[i - 1], b';' | b' ' | b'\t' | b'\r' | b'\n'))
    })?;
    let body = &block[at + KEY.len()..];
    let value = match body.windows(2).position(|w| w == b"';") {
        Some(i) => &body[..i],
        None => match body.iter().rposition(|&b| b == b'\'') {
            Some(i) => &body[..i],
            None => {
                let end = body.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
                &body[..end]
            }
        },
    };
    Some(decode_text(value))
}

// UTF-8 when valid, else Latin-1, which most servers that are not UTF-8 send.
fn decode_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // One block as a server sends it: the length byte and the text padded with `pad` to a multiple
    // of 16.
    fn block_padded(text: &[u8], pad: u8) -> Vec<u8> {
        let mut body = text.to_vec();
        body.resize(body.len().div_ceil(16) * 16, pad);
        let mut v = vec![(body.len() / 16) as u8];
        v.extend(body);
        v
    }

    fn block(text: &str) -> Vec<u8> {
        block_padded(text.as_bytes(), 0)
    }

    // `metaint` audio bytes before each block, then half a run of trailing audio: the body and the
    // audio it carries. An empty block is a zero length byte.
    fn body(metaint: usize, blocks: &[Vec<u8>]) -> (Vec<u8>, Vec<u8>) {
        let mut wire = Vec::new();
        let mut audio = Vec::new();
        let mut n = 0u8;
        let mut run = |wire: &mut Vec<u8>, audio: &mut Vec<u8>, count: usize| {
            for _ in 0..count {
                wire.push(n);
                audio.push(n);
                n = n.wrapping_add(1);
            }
        };
        for b in blocks {
            run(&mut wire, &mut audio, metaint);
            wire.extend_from_slice(b);
        }
        run(&mut wire, &mut audio, metaint.div_ceil(2));
        (wire, audio)
    }

    // Feeds the whole body at once; returns the audio and the last title.
    fn strip(metaint: u32, wire: &[u8]) -> (Vec<u8>, Option<String>) {
        let mut icy = IcyStripper::new(metaint).unwrap();
        let mut out = Vec::new();
        let title = icy.feed(wire, &mut out);
        (out, title)
    }

    #[test]
    fn icy_strips_blocks_at_every_split_point() {
        let metaint = 16;
        let (wire, audio) = body(
            metaint,
            &[
                block("StreamTitle='One';"),
                vec![0],
                block("StreamTitle='Two';StreamUrl='x';"),
            ],
        );
        // Every single split point, then every pair of split points.
        for a in 0..=wire.len() {
            for b in a..=wire.len() {
                let mut icy = IcyStripper::new(metaint as u32).unwrap();
                let mut out = Vec::new();
                let mut last = None;
                for part in [&wire[..a], &wire[a..b], &wire[b..]] {
                    if let Some(t) = icy.feed(part, &mut out) {
                        last = Some(t);
                    }
                }
                assert_eq!(out, audio, "split at {a}/{b}");
                assert_eq!(last.as_deref(), Some("Two"), "split at {a}/{b}");
            }
        }
        // And one byte at a time.
        let mut icy = IcyStripper::new(metaint as u32).unwrap();
        let mut out = Vec::new();
        let mut titles = Vec::new();
        for byte in &wire {
            if let Some(t) = icy.feed(std::slice::from_ref(byte), &mut out) {
                titles.push(t);
            }
        }
        assert_eq!(out, audio);
        assert_eq!(titles, vec!["One".to_string(), "Two".to_string()]);
    }

    #[test]
    fn icy_reads_stream_title_and_drops_the_rest() {
        let title = |s: &str| stream_title(&block(s)[1..]);
        assert_eq!(
            title("StreamTitle='Guns N' Roses - Patience';StreamUrl='http://x';").as_deref(),
            Some("Guns N' Roses - Patience")
        );
        assert_eq!(title("StreamUrl='http://x';"), None);
        assert_eq!(title("StreamTitle='';").as_deref(), Some(""));
        assert_eq!(
            title("StreamTitle='No semicolon'").as_deref(),
            Some("No semicolon")
        );
        assert_eq!(title("StreamTitle='No quote").as_deref(), Some("No quote"));
        // A space after the semicolon, and the title not first.
        assert_eq!(
            title("StreamUrl='u'; StreamTitle='Spaced';").as_deref(),
            Some("Spaced")
        );
        // Not a key that merely ends in StreamTitle.
        assert_eq!(title("XStreamTitle='no';"), None);
        // Padding that is not NUL.
        let spaced = block_padded(b"StreamTitle='Pad';", b' ');
        assert_eq!(stream_title(&spaced[1..]).as_deref(), Some("Pad"));
        // Latin-1 bytes that are not UTF-8, C1 controls kept for the sanitizer.
        assert_eq!(
            stream_title(b"StreamTitle='Caf\xe9\x85';").as_deref(),
            Some("Caf\u{e9}\u{85}")
        );
        // Junk carries no title and changes nothing.
        assert_eq!(title("garbage"), None);
        let (wire, audio) = body(4, &[block("garbage"), block("StreamTitle=no quotes;")]);
        assert_eq!(strip(4, &wire), (audio, None));
    }

    #[test]
    fn icy_handles_the_extreme_metaints_and_block_lengths() {
        assert!(IcyStripper::new(0).is_none());
        assert!(IcyStripper::new(ICY_METAINT_MAX + 1).is_none());

        // One audio byte between blocks.
        let (wire, audio) = body(
            1,
            &[
                block("StreamTitle='A';"),
                vec![0],
                block("StreamTitle='B';"),
            ],
        );
        assert_eq!(strip(1, &wire), (audio, Some("B".to_string())));

        // The largest metaint, around the largest block: length byte 255, 4,080 bytes.
        let mut text = b"StreamTitle='".to_vec();
        text.extend(std::iter::repeat_n(b'x', 4_065));
        text.extend_from_slice(b"';");
        let big = block_padded(&text, 0);
        assert_eq!(big[0], 255);
        assert_eq!(big.len(), 1 + 4_080);
        let (wire, audio) = body(ICY_METAINT_MAX as usize, &[big]);
        let (out, title) = strip(ICY_METAINT_MAX, &wire);
        assert_eq!(out, audio);
        assert_eq!(title.map(|t| t.len()), Some(4_065));
    }
}
