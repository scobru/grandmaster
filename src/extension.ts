import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  initialize,
  AudioTrack,
  DataModelObject,
  Track,
  type ActivationContext,
  type ArrangementSelection,
  type Device,
} from "@ableton-extensions/sdk";
import keyDialog from "./keyDialog.html";
import {
  AI_SYSTEM_PROMPT,
  GENRES,
  aiUserPrompt,
  analyzeWav,
  faderAfterGain,
  hzToNorm,
  parseAiPlan,
  planMix,
  type Measured,
  type TrackPlan,
} from "./mix.js";

type Context = ReturnType<typeof initialize>;
type V = "1.0.0";
type Planner = (measured: Measured[]) => Promise<{ label: string; plan: TrackPlan[] }>;

const OPENROUTER_MODEL = "openrouter/free";
const SCOPES = ["AudioTrack.ArrangementSelection", "MidiTrack.ArrangementSelection"] as const;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const register = (id: string, title: string, run: (sel: ArrangementSelection) => Promise<unknown>) => {
    context.commands.registerCommand(id, (arg: unknown) => {
      void run(arg as ArrangementSelection).catch((e) => console.error("Granmaster:", e));
    });
    for (const scope of SCOPES) void context.ui.registerContextMenuAction(scope, title, id);
  };

  for (const genre of GENRES) {
    register(`granmaster.mix.${genre.toLowerCase()}`, `Granmaster: Mix (${genre})`, (sel) =>
      mix(context, sel, async (m) => ({ label: genre, plan: planMix(m, genre) })),
    );
  }
  register("granmaster.mix.ai", "Granmaster: Mix (AI)", async (sel) => {
    const key = (await readKey(context)) ?? (await askKey(context));
    if (!key) return console.warn("Granmaster: no OpenRouter API key, AI mix cancelled.");
    return mix(context, sel, async (m) => {
      const { genre, plan } = parseAiPlan(await askOpenRouter(key, aiUserPrompt(m, context.application.song.tempo)), m);
      return { label: `AI: ${genre}`, plan };
    });
  });
  register("granmaster.key", "Granmaster: Set OpenRouter API key", () => askKey(context));
}

const keyFile = (context: Context) => {
  const dir = context.environment.storageDirectory;
  if (!dir) throw new Error("Live gave this extension no storage directory");
  return path.join(dir, "openrouter-key.txt");
};

async function readKey(context: Context): Promise<string | null> {
  try {
    return (await fs.readFile(keyFile(context), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function askKey(context: Context): Promise<string | null> {
  const { key } = JSON.parse(await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(keyDialog)}`, 420, 180)) as { key: unknown };
  if (typeof key !== "string" || !key) return null;
  await fs.mkdir(path.dirname(keyFile(context)), { recursive: true });
  await fs.writeFile(keyFile(context), key, { mode: 0o600 });
  return key;
}

async function askOpenRouter(key: string, userPrompt: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Granmaster" },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? res.statusText}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no message");
  return content;
}

async function mix(context: Context, sel: ArrangementSelection, planner: Planner) {
  const tracks = sel.selected_lanes
    .map((h) => context.getObjectFromHandle(h, DataModelObject))
    .filter((o): o is Track<V> => o instanceof Track);
  if (!tracks.length) return console.warn("Granmaster: select a time range across the tracks to mix.");

  await context.ui.withinProgressDialog("Granmaster", {}, async (update, signal) => {
    const measured: Measured[] = [];
    for (const [i, track] of tracks.entries()) {
      signal.throwIfAborted();
      await update(`Analyzing ${track.name}…`, Math.round((i / tracks.length) * 90));
      try {
        // shortcut: typings accept only AudioTrack, but the host takes any lane handle; MIDI render is tried and falls back if Live refuses.
        const file = await context.resources.renderPreFxAudio(track as AudioTrack<V>, sel.time_selection_start, sel.time_selection_end);
        measured.push({ name: track.name, ...analyzeWav(await fs.readFile(file)) });
      } catch (e) {
        // MIDI tracks Live cannot render keep their level but still get pan and EQ.
        console.warn(`Granmaster: cannot render ${track.name}${track instanceof AudioTrack ? "" : " (MIDI)"}, level left unchanged:`, e);
        measured.push({ name: track.name, rmsDb: -Infinity, peakDb: -Infinity });
      }
    }
    signal.throwIfAborted();

    await update("Planning mix…", 90);
    let label: string, plan: TrackPlan[];
    try {
      ({ label, plan } = await planner(measured));
    } catch (e) {
      // Nothing has been changed yet, so stopping here is safe.
      console.error("Granmaster: planning failed, Set left unchanged:", e);
      await update(`Granmaster failed: ${e instanceof Error ? e.message : e}`, 100);
      await new Promise((r) => setTimeout(r, 4000)); // keep the message readable before the dialog closes
      return;
    }
    for (const p of plan) console.log(`Granmaster [${label}]`, JSON.stringify(p));

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
    // One failing device must not stop the others (or the master bus).
    await Promise.all(tracks.map((t, i) => addHighPass(t, plan[i]!).catch((e) => console.warn(`Granmaster: EQ on ${t.name}:`, e))));
    await addMasterBus(context.application.song.mainTrack).catch((e) => console.warn("Granmaster: master bus:", e));
  });
}

async function addHighPass(track: Track<V>, plan: TrackPlan) {
  // Appended, not at 0: an audio effect cannot sit before a MIDI track's instrument.
  // shortcut: treats an EQ Eight at the end of the chain as ours to avoid stacking on re-runs; tag our devices if the SDK allows renaming.
  if (plan.hpfHz === null || track.devices.at(-1)?.name === "EQ Eight") return;
  const eq = await track.insertDevice("EQ Eight", track.devices.length);
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
