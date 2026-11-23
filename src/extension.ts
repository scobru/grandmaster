import * as fs from "node:fs/promises";
import {
  initialize,
  AudioTrack,
  DataModelObject,
  Track,
  type ActivationContext,
  type ArrangementSelection,
  type Device,
} from "@ableton-extensions/sdk";
import { GENRES, analyzeWav, faderAfterGain, hzToNorm, planMix, type Genre, type Measured, type TrackPlan } from "./mix.js";

type Context = ReturnType<typeof initialize>;
type V = "1.0.0";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  for (const genre of GENRES) {
    const id = `granmaster.mix.${genre.toLowerCase()}`;
    context.commands.registerCommand(id, (arg: unknown) => {
      void mix(context, arg as ArrangementSelection, genre).catch((e) => console.error("Granmaster:", e));
    });
    for (const scope of ["AudioTrack.ArrangementSelection", "MidiTrack.ArrangementSelection"] as const) {
      void context.ui.registerContextMenuAction(scope, `Granmaster: Mix (${genre})`, id);
    }
  }
}

async function mix(context: Context, sel: ArrangementSelection, genre: Genre) {
  const tracks = sel.selected_lanes
    .map((h) => context.getObjectFromHandle(h, DataModelObject))
    .filter((o): o is Track<V> => o instanceof Track);
  if (!tracks.length) return console.warn("Granmaster: select a time range across the tracks to mix.");

  await context.ui.withinProgressDialog("Granmaster", {}, async (update, signal) => {
    const measured: Measured[] = [];
    for (const [i, track] of tracks.entries()) {
      signal.throwIfAborted();
      await update(`Analyzing ${track.name}…`, Math.round((i / tracks.length) * 90));
      if (!(track instanceof AudioTrack)) {
        // Only audio tracks can be rendered; MIDI tracks keep their level but still get pan and EQ.
        console.warn(`Granmaster: ${track.name} is not an audio track, level left unchanged.`);
        measured.push({ name: track.name, rmsDb: -Infinity, peakDb: -Infinity });
        continue;
      }
      const file = await context.resources.renderPreFxAudio(track, sel.time_selection_start, sel.time_selection_end);
      measured.push({ name: track.name, ...analyzeWav(await fs.readFile(file)) });
    }
    signal.throwIfAborted();

    const plan = planMix(measured, genre);
    for (const p of plan) console.log(`Granmaster [${genre}]`, JSON.stringify(p));

    await update("Applying mix…", 95);
    // Read current fader values first so all writes can go in one transaction.
    const faders = await Promise.all(tracks.map((t) => t.mixer.volume.getValue()));
    await Promise.all(
      context.withinTransaction(() =>
        tracks.flatMap((t, i) => {
          const p = plan[i]!;
          return [t.mixer.volume.setValue(faderAfterGain(faders[i]!, p.gainDb)), t.mixer.panning.setValue(p.pan)];
        }),
      ),
    );
    // Device inserts resolve asynchronously, so they and their settings land as later undo steps.
    await Promise.all(tracks.map((t, i) => addHighPass(t, plan[i]!)));
    await addMasterBus(context.application.song.mainTrack);
  });
}

async function addHighPass(track: Track<V>, plan: TrackPlan) {
  // shortcut: treats an existing EQ Eight in slot 0 as ours to avoid stacking on re-runs; tag our devices if the SDK allows renaming.
  if (plan.hpfHz === null || track.devices[0]?.name === "EQ Eight") return;
  const eq = await track.insertDevice("EQ Eight", 0);
  await setParam(eq, "1 Filter Type A", "Low Cut 48");
  await setParam(eq, "1 Frequency A", (p) => (p.max <= 1 ? hzToNorm(plan.hpfHz!) : plan.hpfHz!));
  await setParam(eq, "1 Filter On A", 1);
}

async function addMasterBus(main: Track<V>) {
  if (!main.devices.some((d) => d.name === "Glue Compressor")) {
    const glue = await main.insertDevice("Glue Compressor", main.devices.length);
    await setParam(glue, "Ratio", "2");
    await setParam(glue, "Threshold", -12);
  }
  if (!main.devices.some((d) => d.name === "Limiter")) {
    await setParam(await main.insertDevice("Limiter", main.devices.length), "Ceiling", -1);
  }
}

type Param = Device<V>["parameters"][number];

// value: a number (clamped to range), a value-item label to match, or a function of the parameter.
async function setParam(device: Device<V>, name: string, value: number | string | ((p: Param) => number)) {
  const p = device.parameters.find((x) => x.name === name);
  if (!p) return console.warn(`Granmaster: ${device.name} has no parameter "${name}"`);
  // Quantized parameters take the item's index (offset by min) as their value.
  const item = typeof value === "string" ? p.valueItems.findIndex((it) => it.name.includes(value)) : 0;
  const v = typeof value === "string" ? p.min + item : typeof value === "function" ? value(p) : value;
  if (item < 0) return console.warn(`Granmaster: ${device.name}.${name} has no option "${value}"`);
  await p.setValue(Math.min(p.max, Math.max(p.min, v)));
}
