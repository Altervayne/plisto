/*
 * Tests for the harness readout: the rows it shows from what a frame reports, and "no reading" for what the
 * frame never gave. Pure module, no browser. Run: node --test plugin-kit/tests/harness-readout.mjs. The file
 * name avoids the .test suffix so the app's Vitest run does not collect it.
 */

// -- Library Imports --
import assert from "node:assert/strict";
import { test } from "node:test";

// -- Local Imports --
import { NO_READING, createRun, record, summarize } from "../visualizers/harness/readout.js";

test("a reading the frame never gave shows as no reading, not 0", () => {
  const idle = { sent: 0, acked: 0, outstanding: 0, withheld: 0, lastAckMs: null };
  const rows = Object.fromEntries(summarize(createRun(), idle, true).map((r) => [r.label, r.value]));
  for (const label of ["Ready", "Step cost", "Step median", "Step worst", "Flashing"]) {
    assert.equal(rows[label], NO_READING, label);
  }
  assert.equal(rows["Ticks sent"], "0");
  const off = Object.fromEntries(summarize(createRun(), idle, false).map((r) => [r.label, r.value]));
  assert.equal(off.Flashing, "meter off");
});

test("the readout shows ready time, step cost and flash readings once the frame reports them", () => {
  const run = createRun();
  run.startedAt = 1000;
  record(run, { type: "ready", metered: true }, 1250);
  record(run, { type: "ack", seq: 1, ms: 2 }, 1300);
  record(run, { type: "ack", seq: 2, ms: null }, 1316);
  record(run, { type: "flash", reading: { flashesPerSec: 4.5, redFlashesPerSec: 0 } }, 1400);
  const stats = { sent: 3, acked: 2, outstanding: 1, withheld: 0, lastAckMs: null };
  const rows = summarize(run, stats, true);
  const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(by.Ready, "250 ms");
  assert.equal(by["Step median"], "2.00 ms");
  assert.equal(by["Step cost"], NO_READING, "the latest ack gave no cost");
  assert.equal(by.Flashing, "over the limit: 4.5/s, red 0.0/s");
  assert.ok(rows.some((r) => r.label === "Finding" && r.tone === "warn" && /flashes/.test(r.value)));
});

test("the flashing row tells a quiet meter from no meter", () => {
  const flashing = (meterOn, metered) => {
    const run = createRun();
    record(run, { type: "ready", metered }, 5);
    return summarize(run, { sent: 0, acked: 0, outstanding: 0, withheld: 0, lastAckMs: null }, meterOn)
      .find((r) => r.label === "Flashing").value;
  };
  assert.equal(flashing(true, true), "under the limit");
  assert.equal(flashing(true, false), "not watched (no canvas registered)");
  assert.equal(flashing(false, true), "meter off");
});

test("an error and a lost context show as findings", () => {
  const run = createRun();
  record(run, { type: "error", stage: "compile", message: "bad shader" }, 10);
  record(run, { type: "lost" }, 20);
  const rows = summarize(run, { sent: 0, acked: 0, outstanding: 0, withheld: 0, lastAckMs: null }, true);
  assert.ok(rows.some((r) => r.value === "compile: bad shader" && r.tone === "warn"));
  assert.ok(rows.some((r) => /context was lost/.test(r.value)));
});
