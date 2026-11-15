/*
 * The decode tests of the parent file, run with the decoding in a decode helper process. Pushed
 * `pcm_s16le` always converts in-process, so it has no twin here.
 */

use super::isolated;

#[test]
fn decodes_wav_through_a_growing_buffer() {
    isolated(super::decodes_wav_through_a_growing_buffer);
}

#[test]
fn decodes_ogg_opus_through_a_ring_in_small_writes() {
    isolated(super::decodes_ogg_opus_through_a_ring_in_small_writes);
}

#[test]
fn decodes_flac_unseekable() {
    isolated(super::decodes_flac_unseekable);
}

#[test]
fn tiny_blocks_still_reach_the_start_threshold() {
    isolated(super::tiny_blocks_still_reach_the_start_threshold);
}

#[test]
fn decodes_adts_aac_unseekable() {
    isolated(super::decodes_adts_aac_unseekable);
}

#[test]
fn decodes_mp3_unseekable() {
    isolated(super::decodes_mp3_unseekable);
}

#[test]
#[ignore = "needs PLISTO_TEST_MP3 set to a local MP3"]
fn decodes_a_local_mp3_through_a_ring() {
    isolated(super::decodes_a_local_mp3_through_a_ring);
}

#[test]
fn chained_ogg_rebuilds_and_pushes_a_break() {
    isolated(super::chained_ogg_rebuilds_and_pushes_a_break);
}

#[test]
fn refusals_name_format_and_codec() {
    isolated(super::refusals_name_format_and_codec);
}

#[test]
fn html_under_an_audio_hint_is_refused_within_the_probe_limit() {
    isolated(super::html_under_an_audio_hint_is_refused_within_the_probe_limit);
}

#[test]
fn specs_outside_the_limits_are_refused_as_format() {
    isolated(super::specs_outside_the_limits_are_refused_as_format);
}
