import { test } from "node:test";
import assert from "node:assert/strict";
import { aiUserPrompt, analyzeWav, decodeWav, faderAfterGain, hzToNorm, parseAiPlan, planMix, roleOf } from "../src/mix.ts";

// Build a 16-bit PCM or 32-bit float WAV from interleaved samples.
function wav(samples: number[], channels = 1, rate = 1000, float = false): Uint8Array {
  const bytes = float ? 4 : 2;
  const v = new DataView(new ArrayBuffer(44 + samples.length * bytes));
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); v.setUint32(4, 36 + samples.length * bytes, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * bytes, true); v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bytes * 8, true);
  s(36, "data"); v.setUint32(40, samples.length * bytes, true);
  samples.forEach((x, i) => (float ? v.setFloat32(44 + i * 4, x, true) : v.setInt16(44 + i * 2, Math.round(x * 32767), true)));
  return new Uint8Array(v.buffer);
}

const square = (amp: number, n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? amp : -amp));

test("decodes 16-bit and float WAV", () => {
  assert.equal(decodeWav(wav([0.5, -0.5])).samples.length, 2);
  assert.ok(Math.abs(decodeWav(wav([0.25], 1, 1000, true)).samples[0]! - 0.25) < 1e-6);
  assert.throws(() => decodeWav(new Uint8Array(12)), /not WAV/);
});

test("square wave at 0.5 measures -6 dB RMS and peak", () => {
  const r = analyzeWav(wav(square(0.5, 2000), 1, 1000, true));
  assert.equal(r.rmsDb, -6);
  assert.equal(r.peakDb, -6);
});

test("silence is gated out of RMS", () => {
  const r = analyzeWav(wav([...square(0.5, 2000), ...new Array(4000).fill(0)], 1, 1000, true));
  assert.equal(r.rmsDb, -6);
  assert.equal(analyzeWav(wav(new Array(1000).fill(0))).rmsDb, -Infinity);
});

test("stereo RMS matches mono at same level", () => {
  const r = analyzeWav(wav(square(0.5, 4000), 2, 1000, true));
  assert.equal(r.rmsDb, -3); // two channels at -6 dB sum to +3 dB in power
});

test("roles from track names", () => {
  assert.equal(roleOf("Kick 01"), "kick");
  assert.equal(roleOf("808"), "bass");
  assert.equal(roleOf("Lead Vox"), "vox");
  assert.equal(roleOf("Open HH"), "hats");
  assert.equal(roleOf("Audio 7"), "other");
  assert.equal(roleOf("2-AG Techno Kit"), "drums");
  assert.equal(roleOf("Bass Drum"), "kick");
  assert.equal(roleOf("4-808 Slapping"), "bass");
  assert.equal(roleOf("1-Organ LoFi"), "lead");
});

test("plan: gains toward target, centered lows, spread sides, no HPF on kick/bass", () => {
  const plan = planMix(
    [
      { name: "Kick", rmsDb: -20, peakDb: -3 },
      { name: "Bass", rmsDb: -14, peakDb: -3 },
      { name: "Hats", rmsDb: -22, peakDb: -6 },
      { name: "Pad", rmsDb: -40, peakDb: -20 },
      { name: "Empty", rmsDb: -Infinity, peakDb: -Infinity },
    ],
    "House",
  );
  assert.deepEqual(plan.map((p) => p.gainDb), [9, 0, 1, 12, 0]); // kick -11 target, pad clamped to +12
  assert.deepEqual(plan.map((p) => p.pan), [0, 0, 0.3, -0.3, 0.4]);
  assert.deepEqual(plan.map((p) => p.hpfHz), [null, null, 300, 200, 100]);
});

test("fader and frequency mapping", () => {
  assert.equal(faderAfterGain(0.85, 6), 1);
  assert.equal(faderAfterGain(0.1, -12), 0);
  assert.equal(hzToNorm(10), 0);
  assert.equal(hzToNorm(22000), 1);
});

test("AI reply: fenced JSON parsed, values clamped, unknown level and missing tracks fall back", () => {
  const tracks = [
    { name: "Kick", rmsDb: -20, peakDb: -3 },
    { name: "Pad", rmsDb: -30, peakDb: -10 },
    { name: "Synth (MIDI)", rmsDb: -Infinity, peakDb: -Infinity },
    { name: "Missing", rmsDb: -18, peakDb: -6 },
  ];
  const reply = 'Sure!\n```json\n{"genre":"Techno","tracks":[' +
    '{"name":"Kick","gainDb":40,"pan":0,"hpfHz":null},' +
    '{"name":"Pad","gainDb":-3.14,"pan":-5,"hpfHz":5000},' +
    '{"name":"Synth (MIDI)","gainDb":6,"pan":0.4,"hpfHz":"lots"}]}\n```';
  const { genre, plan } = parseAiPlan(reply, tracks);
  assert.equal(genre, "Techno");
  assert.deepEqual(plan.map((p) => [p.gainDb, p.pan, p.hpfHz]), [
    [12, 0, null],
    [-3.1, -1, 1000],
    [0, 0.4, null],
    [0, 0, null],
  ]);
});

test("AI reply without usable tracks is rejected", () => {
  const tracks = [{ name: "Kick", rmsDb: -20, peakDb: -3 }];
  assert.throws(() => parseAiPlan("no json here", tracks));
  assert.throws(() => parseAiPlan('{"genre":"x"}', tracks), /no tracks/);
  assert.throws(() => parseAiPlan('{"tracks":[{"name":"Other"}]}', tracks), /none of the tracks/);
});

test("AI prompt encodes unrendered levels as null", () => {
  const p = JSON.parse(aiUserPrompt([{ name: "Synth", rmsDb: -Infinity, peakDb: -Infinity }], 128));
  assert.deepEqual(p, { tempo: 128, tracks: [{ name: "Synth", rmsDb: null, peakDb: null }] });
});
