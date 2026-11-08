/**
 * tools/musicxml-to-notes.ts, run as a user runs it, on small hand-written scores: the form is
 * sung in play order, words come back together for the dictionary, and words the dictionary
 * can't fit to their notes stop the tool rather than shift every later syllable.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/musicxml-to-notes.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "musicxml-"));

/** a one-part score in 4/4, one beat per division, at 100 bpm */
function score(measures: string[]): string {
  const body = measures.map((m, i) => `<measure number="${i + 1}">${i ? "" : '<attributes><divisions>1</divisions></attributes><direction><sound tempo="100"/></direction>'}${m}</measure>`).join("");
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
}

/** a note: step, beats, then lyric lines as [syllabic, text] (line 1, 2, ...), and extra XML */
function note(step: string, beats: number, lyrics: [string, string][] = [], extra = ""): string {
  const ly = lyrics.map(([s, t], i) => `<lyric number="${i + 1}"><syllabic>${s}</syllabic><text>${t}</text></lyric>`).join("");
  return `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${beats}</duration>${extra}${ly}</note>`;
}

function run(xml: string, ...args: string[]): { code: number; out: string; err: string } {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.musicxml`);
  writeFileSync(path, xml);
  const p = Bun.spawnSync(["bun", TOOL, path, "P1", ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("musicxml-to-notes", () => {
  test("repeats and endings are sung in play order, each pass with its own verse", () => {
    const r = run(
      score([
        `<barline location="left"><repeat direction="forward"/></barline>${note("C", 4, [["single", "one"], ["single", "two"]])}`,
        `<barline location="left"><ending number="1" type="start"/></barline>${note("D", 4, [["single", "go"]])}<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>`,
        `<barline location="left"><ending number="2" type="start"/></barline>${note("E", 4, [["single", "end"]])}<barline location="right"><ending number="2" type="discontinue"/></barline>`,
        `${note("F", 2, [["single", "last"]])}<note><rest/><duration>2</duration></note>`,
      ]),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ bpm: 100, lyrics: "one go two end last", notes: [[60, 4], [62, 4], [60, 4], [64, 4], [65, 2], [0, 2]] });
  });

  test("a word the score splits is joined for the dictionary, and tied notes are one note", () => {
    const r = run(
      score([
        note("C", 1, [["begin", "to"]]) + note("D", 1, [["middle", "ge"]]) + note("E", 1, [["end", "ther"]]) + note("G", 1, [["single", "we"]]),
        note("G", 2, [["single", "sing"]], '<tie type="start"/>') + note("G", 2, [], '<tie type="stop"/>'),
      ]),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ lyrics: "together we sing", notes: [[60, 1], [62, 1], [64, 1], [67, 1], [67, 4]] });
  });

  test("typed hyphens split words, a dash alone holds, and a lost apostrophe (U+FFFD) is one", () => {
    // as MuseScore 3.0.1 exported bohemian-rhapsody-choir-and-piano.mxl: every lyric "single"
    const r = run(
      score([
        note("C", 1, [["single", "A -"]]) + note("D", 1, [["single", "ny"]]) + note("E", 1, [["single", "does -"]]) + note("F", 1, [["single", "n�t"]]),
        note("G", 1, [["single", "see -"]]) + note("A", 1, [["single", "I�m"]]) + note("B", 1, [["single", "ooh"]]) + note("C", 1, [["single", " -"]]),
      ]),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).lyrics).toBe("Any doesn't see I'm ooh -");
  });

  test("a tripled letter is read as two, and a glide of one-syllable pieces is sung piece by piece", () => {
    // as all-i-want-for-christmas-is-you-mariah-carey-ttbb-a-cappella-choir.mxl writes them:
    // "Ooo" alone was two syllables, and "Ahh-ohh-ooo" joined was four on three notes
    const r = run(
      score([
        note("C", 1, [["single", "Ooo"]]) + note("D", 1, [["begin", "Ahh"]]) + note("E", 1, [["middle", "ohh"]]) + note("F", 1, [["end", "ooo"]]),
        note("G", 2, [["begin", "Doh"]]) + note("A", 2, [["end", "ooo"]]),
      ]),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).lyrics).toBe("Oo Ahh ohh oo Doh oo");
    // a word respelled by the user is sung as respelled, though the respelling isn't in the dictionary
    const spelled = run(score([note("C", 2, [["begin", "frighte"]]) + note("D", 2, [["end", "ning"]])]), "--spell", "frightening=frightning");
    expect(spelled.code).toBe(0);
    expect(JSON.parse(spelled.out).lyrics).toBe("frightning");
  });

  test("a word with more syllables than notes stops the tool, once per word whatever its case, until respelled", () => {
    const xml = score([note("C", 2, [["single", "Ba"]]) + note("D", 2, [["single", "ba"]])]);
    const bad = run(xml);
    expect(bad.code).toBe(1);
    expect(bad.err.match(/"ba": 2 syllable/gi)).toHaveLength(1);
    const good = run(xml, "--spell", "ba=bah");
    expect(good.code).toBe(0);
    expect(JSON.parse(good.out).lyrics).toBe("bah bah");
  });

  test("a later tempo is built into the note lengths, at the score's first tempo", () => {
    // 100 bpm, then 50 bpm from measure 2: a beat there lasts two beats at 100
    const r = run(score([note("C", 4, [["single", "one"]]), `<direction><sound tempo="50"/></direction>${note("D", 2, [["single", "two"]])}<note><rest/><duration>2</duration></note>`]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ bpm: 100, notes: [[60, 4], [62, 4], [0, 4]] });
  });

  test("two voices on the staff: the one with words is sung, its silences as rests", () => {
    // voice 1 holds a wordless note; voice 2 waits a beat (no rest written), then sings
    const v = (step: string, beats: number, voice: string, text?: string) =>
      `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${beats}</duration><voice>${voice}</voice>${text ? `<lyric number="1"><syllabic>single</syllabic><text>${text}</text></lyric>` : ""}</note>`;
    const r = run(score([note("C", 4, [["single", "one"]]), v("E", 4, "1") + "<backup><duration>4</duration></backup><forward><duration>1</duration></forward>" + v("G", 1, "2", "bum") + v("A", 1, "2", "bum")]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ lyrics: "one bum bum", notes: [[60, 4], [0, 1], [67, 1], [69, 1], [0, 1]] });
    expect(r.err).toContain("sang voice 2 of 2");
  });

  test("a D.S. jump is refused, not sung straight through", () => {
    const r = run(score([note("C", 4, [["single", "one"]]), `<direction><sound dalsegno="1"/></direction>${note("D", 4, [["single", "two"]])}`]));
    expect(r.code).toBe(1);
    expect(r.err).toContain("not supported");
  });
});
