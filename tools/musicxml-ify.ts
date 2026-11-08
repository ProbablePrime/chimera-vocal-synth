/**
 * A whole MusicXML score → a duet show folder (see src/ui/components/DuetPage.tsx): every part with
 * lyrics becomes a melody file, is sung by `chimera render notes --tele`, and the voices are mixed.
 *
 *   bun tools/musicxml-ify.ts <score.mxl|score.musicxml> --output <dir> [--title T] [--bpm N]
 *                             [--spell ba=bah,...] [--voice <part id or name>=male|female|child,...]
 *                             [--no-render]
 *
 * Writes to <dir>: `<part>.json` (the melody, as tools/musicxml-to-notes.ts writes it) and, unless
 * --no-render, `<part>.tele` per sung part, `mix.wav` and `show.json`. Put the folder at
 * `public/shows/<id>/` and open `?show=<id>`.
 *
 * Parts without lyrics (instruments) are skipped. Every sung part is converted before anything is
 * rendered, so one run lists every word that needs --spell. Each part gets the male body when it
 * is written in a bass or tenor (octave-down treble) clef or the middle of its range is below
 * middle C, else female; --voice overrides it. The parts are
 * rendered with the same start time, so they share sample 0 with each other and with the mix.
 * The mix is the parts summed, scaled to a peak of 0.9.
 *
 * Needs the wasm build (`bun run wasm`) for the dictionary, and cargo to build the CLI.
 */
import { availableParallelism } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { convertPart, hasLyrics, listParts, lowClef, parseSpell, readScore, scoreTitle, type Converted } from "./lib/musicxml.ts";
import { readWav, writeWav } from "./lib/wav.ts";

/** the CLI's start time (`t0`) and sample rate */
const T0 = 0.3;
const BODIES = ["male", "female", "child"];

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (...names: string[]): string | undefined => {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${args[i]} needs a value`);
  args.splice(i, 2);
  return v;
};
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};

const outDir = opt("--output", "-output", "-o", "--out");
const titleArg = opt("--title");
const bpmArg = opt("--bpm");
const spellArg = opt("--spell");
const voiceArg = opt("--voice");
const noRender = flag("--no-render");
const [path, ...extra] = args;
if (!path || !outDir || extra.length) fail("usage: bun tools/musicxml-ify.ts <score.mxl|score.musicxml> --output <dir> [--title T] [--bpm N] [--spell ba=bah,...] [--voice <part>=male|female|child,...] [--no-render]");

let spell: Map<string, string>;
try {
  spell = parseSpell(spellArg);
} catch (e) {
  fail((e as Error).message);
}
const voiceFor = new Map<string, string>();
for (const p of (voiceArg ?? "").split(",").filter(Boolean)) {
  const i = p.lastIndexOf("=");
  const [part, body] = [p.slice(0, i), p.slice(i + 1)];
  if (i <= 0 || !BODIES.includes(body)) fail(`--voice: "${p}" is not <part>=male|female|child`);
  voiceFor.set(part.toLowerCase(), body);
}

const xml = await readScore(path).catch((e: Error) => fail(e.message));
const parts = listParts(xml);
if (!parts.length) fail(`${path}: no parts`);
for (const k of voiceFor.keys()) if (!parts.some((p) => p.id.toLowerCase() === k || p.name.toLowerCase() === k)) fail(`--voice: no part "${k}"; the parts are: ${parts.map((p) => `${p.id} (${p.name})`).join(", ")}`);

// ---- every sung part to a melody, all errors at once
const sung: { id: string; name: string; file: string; body: string; converted: Converted }[] = [];
const errors: string[] = [];
const files = new Set<string>();
for (const p of parts) {
  if (!hasLyrics(xml, p.id)) {
    console.error(`${p.name || p.id}: no lyrics, skipped`);
    continue;
  }
  try {
    const converted = await convertPart(xml, p.id, { bpm: bpmArg === undefined ? undefined : Number(bpmArg), spell });
    for (const w of converted.warnings) console.error(`${p.name || p.id}: warning: ${w}`);
    // a file name from the part's name, unique in the folder
    const stem = (p.name || p.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || p.id;
    let file = stem;
    for (let n = 2; files.has(file); n++) file = `${stem}-${n}`;
    files.add(file);
    sung.push({ id: p.id, name: p.name || p.id, file, body: voiceFor.get(p.id.toLowerCase()) ?? voiceFor.get(p.name.toLowerCase()) ?? autoBody(converted, lowClef(xml, p.id)), converted });
  } catch (e) {
    errors.push(`${p.name || p.id} (${p.id}): ${(e as Error).message}`);
  }
}
if (errors.length) fail(errors.join("\n"));
if (!sung.length) fail(`${path}: no part has lyrics, so there is nothing to sing`);

/** male when the part is in a bass or tenor clef, or the middle of its range is below middle C */
function autoBody(c: Converted, lowClef: boolean): string {
  if (lowClef) return "male";
  const pitches = c.melody.notes.filter((n) => n[0] > 0).map((n) => n[0]).sort((a, b) => a - b);
  return pitches[pitches.length >> 1] < 60 ? "male" : "female";
}

mkdirSync(outDir, { recursive: true });
for (const s of sung) {
  writeFileSync(join(outDir, `${s.file}.json`), JSON.stringify(s.converted.melody) + "\n");
  const n = s.converted.melody.notes.filter((x) => x[0] > 0).length;
  console.error(`${s.name}: ${n} sung notes, ${s.file}.json, ${s.body}`);
}
if (noRender) process.exit(0);

// ---- render each part (the CLI built once, then the parts in parallel)
const repo = resolve(import.meta.dir, "..");
const build = Bun.spawnSync(["cargo", "build", "--release", "-q", "-p", "chimera-cli"], { cwd: repo, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) fail("cargo build of chimera-cli failed");
const exe = join(process.env.CARGO_TARGET_DIR ? resolve(repo, process.env.CARGO_TARGET_DIR) : join(repo, "target"), "release", process.platform === "win32" ? "chimera.exe" : "chimera");

const queue = [...sung];
const renderFailures: string[] = [];
async function worker() {
  for (let s = queue.shift(); s; s = queue.shift()) {
    const stem = join(outDir!, s.file);
    const p = Bun.spawn([exe, "render", "notes", `${stem}.json`, stem, s.body, "--tele", `${stem}.tele`, "--float"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    if (code !== 0) renderFailures.push(`${s.name}: render notes failed: ${(err || out).trim()}`);
    else console.error(`${s.name}: rendered (${out.trim().split("\n")[0]})`);
  }
}
console.error(`rendering ${sung.length} part(s)…`);
await Promise.all(Array.from({ length: Math.min(sung.length, availableParallelism()) }, worker));
if (renderFailures.length) fail(renderFailures.join("\n"));

// ---- the mix: the parts summed, one peak for all (each part's float WAV removed once mixed)
const waves = sung.map((s) => readWav(join(outDir, `${s.file}.wav`)));
const sampleRate = waves[0].sampleRate;
const mix = new Float32Array(Math.max(...waves.map((w) => w.channels[0].length)));
for (const w of waves) w.channels[0].forEach((v, i) => (mix[i] += v));
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
if (peak > 0) for (let i = 0; i < mix.length; i++) mix[i] *= 0.9 / peak;
writeWav(join(outDir, "mix.wav"), [mix], sampleRate);
for (const s of sung) rmSync(join(outDir, `${s.file}.wav`));

// ---- show.json
const bpm = sung[0].converted.melody.bpm;
const respelled = Object.fromEntries([...spell].map(([from, to]) => [to.toLowerCase(), from]));
const show = {
  title: titleArg ?? scoreTitle(xml) ?? basename(resolve(outDir)),
  audio: "mix.wav",
  bpm,
  // a bar's first beat: after the pickup, if the score starts with one
  downbeat: +(T0 + (sung[0].converted.pickupBeats * 60) / bpm).toFixed(4),
  ...(spell.size ? { spell: respelled } : {}),
  voices: sung.map((s) => ({ name: s.name, tele: `${s.file}.tele`, melody: `${s.file}.json` })),
};
writeFileSync(join(outDir, "show.json"), JSON.stringify(show, null, 2) + "\n");
const id = basename(resolve(outDir));
console.error(`${join(outDir, "show.json")}: "${show.title}", ${sung.length} voice(s), ${(mix.length / sampleRate).toFixed(1)} s. Put the folder at public/shows/${id}/ and open ?show=${id}`);
