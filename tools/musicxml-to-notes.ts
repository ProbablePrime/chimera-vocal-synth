/**
 * One part of a MusicXML score → the melody file `chimera render notes` sings:
 * `{"bpm", "lyrics", "notes": [[midi, beats], ...]}`.
 *
 *   bun tools/musicxml-to-notes.ts <score.mxl|score.musicxml> [part-id] [--bpm N] [--out part.json]
 *                                  [--spell ba=bah,...]
 *
 * Without a part id it lists the parts. Needs the wasm build (`bun run wasm`). What it does with
 * the score's form, lyrics and tempo is in tools/lib/musicxml.ts. For a whole score as a duet
 * show (every sung part rendered and mixed), use tools/musicxml-ify.ts.
 */
import { convertPart, listParts, parseSpell, readScore } from "./lib/musicxml.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} needs a value`);
  args.splice(i, 2);
  return v;
};

try {
  const bpmArg = opt("--bpm");
  const outPath = opt("--out");
  const spell = parseSpell(opt("--spell"));
  const [path, partId] = args;
  if (!path) fail("usage: bun tools/musicxml-to-notes.ts <score.mxl|score.musicxml> [part-id] [--bpm N] [--out part.json] [--spell ba=bah,...]");

  const xml = await readScore(path);
  if (!partId) {
    for (const p of listParts(xml)) console.log(`${p.id}\t${p.name}`);
    process.exit(0);
  }

  const { melody, warnings } = await convertPart(xml, partId, { bpm: bpmArg === undefined ? undefined : Number(bpmArg), spell }).catch((e: Error) => fail(`${partId}: ${e.message}`));
  if (warnings.length) console.error(`${partId} warnings:\n${warnings.map((w) => `  ${w}`).join("\n")}`);
  const out = JSON.stringify(melody);
  if (outPath) await Bun.write(outPath, out + "\n");
  else console.log(out);
  const sounding = melody.notes.filter((n) => n[0] > 0).length;
  console.error(`${partId}: ${sounding} sung notes, ${melody.notes.reduce((s, n) => s + n[1], 0)} beats at ${melody.bpm} bpm`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
