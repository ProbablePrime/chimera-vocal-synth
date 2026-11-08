/**
 * tools/musicxml-ify.ts with --no-render (rendering needs a cargo build): every sung part becomes a
 * melody file, instrument parts are skipped, bodies follow the range unless --voice says otherwise,
 * and words that don't fit are listed for every part before anything is written.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/musicxml-ify.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "musicxml-ify-"));

const note = (step: string, octave: number, beats: number, text?: string) =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${beats}</duration>${text ? `<lyric number="1"><syllabic>single</syllabic><text>${text}</text></lyric>` : ""}</note>`;
const part = (id: string, notes: string) => `<part id="${id}"><measure number="1"><attributes><divisions>1</divisions></attributes><direction><sound tempo="90"/></direction>${notes}</measure></part>`;

/** Upper and Lower sing `words` an octave and a half apart; Piano has no lyrics */
function score(words: [string, string]): string {
  const sing = (o: number) => note("C", o, 2, words[0]) + note("E", o, 2, words[1]);
  return `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Upper</part-name></score-part><score-part id="P2"><part-name>Lower</part-name></score-part><score-part id="P3"><part-name>Piano</part-name></score-part></part-list>${part("P1", sing(5))}${part("P2", sing(3))}${part("P3", note("C", 3, 4))}</score-partwise>`;
}

function run(xml: string, ...args: string[]) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.musicxml`);
  const out = join(dir, Math.random().toString(36).slice(2));
  writeFileSync(path, xml);
  const p = Bun.spawnSync(["bun", TOOL, path, "--output", out, "--no-render", ...args]);
  return { code: p.exitCode, err: p.stderr.toString(), out };
}

describe("musicxml-ify", () => {
  test("each sung part becomes a melody file, with a body from its range; instruments are skipped", () => {
    const r = run(score(["we", "sing"]));
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(r.out, "upper.json"), "utf8"))).toEqual({ bpm: 90, lyrics: "we sing", notes: [[72, 2], [76, 2]] });
    expect(JSON.parse(readFileSync(join(r.out, "lower.json"), "utf8")).notes).toEqual([[48, 2], [52, 2]]);
    expect(existsSync(join(r.out, "piano.json"))).toBe(false);
    expect(r.err).toContain("Piano: no lyrics, skipped");
    expect(r.err).toContain("upper.json, female");
    expect(r.err).toContain("lower.json, male");
  });

  test("--voice picks a part's body by id or name", () => {
    const r = run(score(["we", "sing"]), "--voice", "P1=child,lower=female");
    expect(r.code).toBe(0);
    expect(r.err).toContain("upper.json, child");
    expect(r.err).toContain("lower.json, female");
  });

  test("a part in the tenor clef is sung by the male body even when its written range is high", () => {
    const xml = score(["we", "sing"]).replace('<part id="P1"><measure number="1"><attributes><divisions>1</divisions>', '<part id="P1"><measure number="1"><attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>');
    const r = run(xml);
    expect(r.code).toBe(0);
    expect(r.err).toContain("upper.json, male");
  });

  test("words that don't fit are listed for every part, and nothing is written", () => {
    const r = run(score(["ba", "sing"]));
    expect(r.code).toBe(1);
    expect(r.err).toContain("Upper (P1)");
    expect(r.err).toContain("Lower (P2)");
    expect(existsSync(r.out)).toBe(false);
    expect(run(score(["ba", "sing"]), "--spell", "ba=bah").code).toBe(0);
  });
});
