# Granmaster

Ableton Live extension (Extensions SDK, Live 12.4.5 Suite beta) that gives a selection of tracks a starting mix.

## What it does

Select a time range across the tracks in Arrangement view, right-click, and pick **Granmaster: Mix (House | Techno | Hip-Hop | Pop)**.

1. Renders each track's pre-FX audio for the selection and measures gated RMS and peak.
2. Guesses each track's role from its name (kick, bass, snare, hats, vox, lead, pad, fx, other).
3. Moves each fader toward a target level for that role and genre (at most ±12 dB).
4. Pans: kick, bass, snare, vox and lead stay centered; other tracks alternate left and right (30–60%).
5. Inserts EQ Eight with a 48 dB low cut on every track except kick and bass.
6. Adds Glue Compressor (2:1, −12 dB threshold) and Limiter (−1 dB ceiling) on the Main track.

The computed plan for each track is logged to `ExtensionHost.txt`.

## Setup

1. Download the SDK zip from the Ableton beta program and copy `ableton-extensions-sdk-<version>.tgz` and `ableton-extensions-cli-<version>.tgz` into `vendor/`. If the version is not `1.0.0-beta.1`, update the two paths in `package.json`.
2. Create `.env` containing `EXTENSION_HOST_PATH=<path to ExtensionHostNodeModule.node inside your Live install>`.
3. In Live, turn on Developer Mode under Preferences → Extensions.
4. Install and run:

```sh
npm install
npm test        # mixing logic, no Live needed
npm start       # build and load into Live
npm run package # build dist/*.ablx
```

## Layout

- `src/mix.ts`: WAV decoding, analysis, role detection, mix plan. Pure TypeScript, unit tested.
- `src/extension.ts`: Live glue (menu actions, rendering, mixer and device changes).
- `.claude/skills/ableton-extensions`: community SDK skill (Ronvaknins/ableton-extensions-skill) used as reference.
