// Pure mixing logic: no SDK imports, so it is testable outside Live.

export const GENRES = ["House", "Techno", "Hip-Hop", "Pop"] as const;
export type Genre = (typeof GENRES)[number];

type Role = "kick" | "drums" | "bass" | "snare" | "hats" | "vox" | "lead" | "pad" | "fx" | "other";

// First match wins, so order matters ("Bass Drum" is a kick, "808" alone is bass).
const ROLE_PATTERNS: [Role, RegExp][] = [
  ["kick", /kick|\bbd\b|kck|bass ?drum/i],
  ["drums", /kit|drum|beat|break/i],
  ["bass", /bass|sub|808/i],
  ["snare", /snare|clap|\bsd\b|rim/i],
  ["hats", /hat|\bhh\b|cymb|ride|perc|shaker|top/i],
  ["vox", /vox|vocal|voice|\bvx\b/i],
  ["fx", /fx|riser|sweep|impact|noise/i],
  ["pad", /pad|string|choir|atmo|ambient/i],
  ["lead", /lead|synth|pluck|arp|key|piano|organ|rhodes|chord|guitar|gtr/i],
];

// Target gated RMS in dBFS per role (pre-FX render).
const BASE_TARGET: Record<Role, number> = {
  kick: -12, drums: -12, bass: -14, snare: -15, hats: -22, vox: -14, lead: -18, pad: -22, fx: -26, other: -20,
};

const GENRE_OFFSET: Record<Genre, Partial<Record<Role, number>>> = {
  House: { kick: 1, hats: 1 },
  Techno: { kick: 2, pad: 1, vox: -3 },
  "Hip-Hop": { kick: 1, bass: 2, vox: 2, hats: -2 },
  Pop: { vox: 2, kick: -1, bass: -1 },
};

// High-pass cutoff per role; kick, drums and bass keep their lows.
const HPF_HZ: Partial<Record<Role, number>> = {
  snare: 100, hats: 300, vox: 90, lead: 150, pad: 200, fx: 150, other: 100,
};

const CENTER: Role[] = ["kick", "drums", "bass", "snare", "vox", "lead"];
const MAX_GAIN_DB = 12;
const SILENCE_DB = -60;

export interface Measured { name: string; rmsDb: number; peakDb: number }
export interface TrackPlan { name: string; role: Role; gainDb: number; pan: number; hpfHz: number | null }

export function roleOf(name: string): Role {
  return ROLE_PATTERNS.find(([, re]) => re.test(name))?.[0] ?? "other";
}

export function planMix(tracks: Measured[], genre: Genre): TrackPlan[] {
  let side = 0;
  return tracks.map(({ name, rmsDb }) => {
    const role = roleOf(name);
    const target = BASE_TARGET[role] + (GENRE_OFFSET[genre][role] ?? 0);
    const gainDb = rmsDb <= SILENCE_DB ? 0 : clamp(target - rmsDb, -MAX_GAIN_DB, MAX_GAIN_DB);
    let pan = 0;
    if (!CENTER.includes(role)) {
      // Alternate L/R, widening every pair, capped at 60%.
      pan = (side % 2 ? -1 : 1) * Math.min(0.6, 0.3 + 0.1 * Math.floor(side / 2));
      side++;
    }
    return { name, role, gainDb: round1(gainDb), pan: round1(pan), hpfHz: HPF_HZ[role] ?? null };
  });
}

// Gated RMS (400 ms blocks above -60 dBFS, mono sum of channel power) and sample peak.
export function analyzeWav(buf: Uint8Array): { rmsDb: number; peakDb: number } {
  const { samples, channels, rate } = decodeWav(buf);
  const block = Math.max(1, Math.round(rate * 0.4)) * channels;
  let peak = 0, gatedSum = 0, gatedBlocks = 0;
  for (let i = 0; i < samples.length; i += block) {
    let sum = 0;
    const end = Math.min(samples.length, i + block);
    for (let j = i; j < end; j++) {
      const s = samples[j]!;
      sum += s * s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    const ms = (sum / (end - i)) * channels;
    if (toDb(ms) / 2 > SILENCE_DB) { gatedSum += ms; gatedBlocks++; }
  }
  return {
    rmsDb: gatedBlocks ? round1(toDb(gatedSum / gatedBlocks) / 2) : -Infinity,
    peakDb: round1(toDb(peak)),
  };
}

export function decodeWav(buf: Uint8Array): { samples: Float32Array; channels: number; rate: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Rendered audio is not WAV: set Preferences → Record, Warp & Launch → File Type to WAV");
  let format = 0, channels = 0, rate = 0, bits = 0;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === "fmt ") {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE subformat
    } else if (id === "data") {
      if (!channels) throw new Error("WAV data before fmt chunk");
      const bytes = bits / 8, n = Math.floor(Math.min(size, buf.length - body) / bytes);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = body + i * bytes;
        if (format === 3 && bits === 32) samples[i] = v.getFloat32(p, true);
        else if (format === 3 && bits === 64) samples[i] = v.getFloat64(p, true);
        else if (format === 1 && bits === 16) samples[i] = v.getInt16(p, true) / 32768;
        else if (format === 1 && bits === 24) samples[i] = ((v.getUint8(p + 2) << 24) | (v.getUint8(p + 1) << 16) | (v.getUint8(p) << 8)) / 2147483648;
        else if (format === 1 && bits === 32) samples[i] = v.getInt32(p, true) / 2147483648;
        else throw new Error(`Unsupported WAV format ${format}/${bits}-bit`);
      }
      return { samples, channels, rate };
    }
    o = body + size + (size & 1); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}

// shortcut: linear 40 dB per fader unit around 0.85 = 0 dB is accurate only near unity (~-18..+6 dB); replace with Live's exact curve if the SDK exposes dB values.
export function faderAfterGain(raw: number, gainDb: number): number {
  return clamp(raw + gainDb / 40, 0, 1);
}

// EQ Eight frequency parameters are normalized 0..1 on a log scale from 10 Hz to 22 kHz.
export function hzToNorm(hz: number): number {
  return clamp(Math.log(hz / 10) / Math.log(22000 / 10), 0, 1);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
