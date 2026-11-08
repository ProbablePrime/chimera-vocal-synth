/**
 * One part of a MusicXML score → the melody file `chimera render notes` sings:
 * `{"bpm", "lyrics", "notes": [[midi, beats], ...]}`. Used by tools/musicxml-to-notes.ts (one part)
 * and tools/musicxml-ify.ts (a whole score to a duet show). Needs the wasm build (`bun run wasm`).
 *
 * Notes: tied notes become one note; a chord sings its first note; grace and cue notes are
 * skipped; a sung note with no lyric holds the previous vowel (a melisma, `-`).
 *
 * Form: repeats and 1st/2nd endings are written out, and each pass through a repeat sings its
 * own lyric line (verse 2 on the second time) when the score has one. D.C., D.S., To Coda and
 * Fine are refused: write them out in the score. Where a staff has two voices, one is sung (the
 * one with more words; warned): split the voices into parts to sing both.
 *
 * Lyrics: a score splits words into syllables its own way ("to-ge-ther"), and the dictionary
 * can't say a lone "ge". So each word is joined back up and syllabified by the engine's
 * dictionary, as `render notes` will. When the dictionary finds fewer syllables than the word's
 * notes, the last vowel holds over the rest (with a warning); when it finds more ("ba" is
 * "B.A."), the part is refused: respell the word (`spell`, "ba" → "bah"). A melisma inside a word
 * moves to the word's end unless every piece is one syllable on its own (also warned).
 * When every piece is one syllable on its own and the joined word doesn't fit or isn't in the
 * dictionary (a vocable, "Ahh-ohh-ooo"), the pieces are sung as words.
 *
 * Exports in the wild: a letter typed three times or more is read twice ("ooo" is "oo"), a lyric
 * that is only a dash is a hold, a typed trailing hyphen ("A -", "ny") splits a word as
 * `<syllabic>` would (unless the next piece is capitalized), and U+FFFD is a lost apostrophe.
 *
 * The melody's bpm is the score's first `<sound tempo>`; later tempo changes are built into the
 * note lengths (a beat at half the tempo is two beats long). A given bpm sings it all at one tempo.
 * `.mxl` is unzipped with the system `unzip`.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initChimera } from "../../src/wasm/chimera.ts";

export interface Melody {
  bpm: number;
  lyrics: string;
  notes: [number, number][];
}

export interface Converted {
  melody: Melody;
  /** human-readable, one per line */
  warnings: string[];
  /** the beats before the first full bar (a pickup measure), 0 without one */
  pickupBeats: number;
}

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** the text of the first `<tag>` in `xml`, or null */
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

function has(xml: string, name: string): boolean {
  return new RegExp(`<${name}[\\s/>]`).test(xml);
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export async function readScore(path: string): Promise<string> {
  if (!path.endsWith(".mxl")) return Bun.file(path).text();
  // the container names the root score file
  const container = Bun.spawnSync(["unzip", "-p", path, "META-INF/container.xml"]);
  if (container.exitCode !== 0) throw new Error(`${path}: unzip failed: ${container.stderr.toString()}`);
  const root = container.stdout.toString().match(/full-path="([^"]+)"/)?.[1];
  if (!root) throw new Error(`${path}: no rootfile in META-INF/container.xml`);
  const score = Bun.spawnSync(["unzip", "-p", path, root]);
  if (score.exitCode !== 0) throw new Error(`${path}: unzip ${root} failed: ${score.stderr.toString()}`);
  return score.stdout.toString();
}

export function listParts(xml: string): { id: string; name: string }[] {
  return [...xml.matchAll(/<score-part id="([^"]+)">([\s\S]*?)<\/score-part>/g)].map((m) => ({ id: m[1], name: unescape(tag(m[2], "part-name") ?? "") }));
}

/** the score's title (work title, else movement title), or null */
export function scoreTitle(xml: string): string | null {
  const t = tag(xml, "work-title") ?? tag(xml, "movement-title");
  return t ? unescape(t) : null;
}

function partBody(xml: string, partId: string): string {
  const body = xml.match(new RegExp(`<part id="${partId}">([\\s\\S]*?)</part>`))?.[1];
  if (!body) throw new Error(`no part ${partId}; the parts are: ${listParts(xml).map((p) => `${p.id} (${p.name})`).join(", ")}`);
  return body;
}

/** whether a part has any lyric to sing (instrument parts have none) */
export function hasLyrics(xml: string, partId: string): boolean {
  return /<lyric\b/.test(partBody(xml, partId));
}

type Event = { at: number; beats: number; x: string; voice: string };

/**
 * A measure's notes in time: each `<note>` (chords, grace and cue notes left out) with its start in
 * beats from the barline and its voice, following `<backup>` and `<forward>`. `length` is the
 * measure's length (the furthest any voice reaches); `divisions` is the value after the measure.
 */
function measureEvents(mxml: string, divisions: number, measure: string): { events: Event[]; length: number; divisions: number } {
  const events: Event[] = [];
  let pos = 0;
  let length = 0;
  const beatsOf = (x: string) => {
    if (!divisions) throw new Error(`measure ${measure}: a note before <divisions>`);
    return Number(tag(x, "duration") ?? 0) / divisions;
  };
  for (const [, kind, x] of mxml.matchAll(/<(attributes|note|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    if (kind === "attributes") {
      const d = tag(x, "divisions");
      if (d) divisions = Number(d);
    } else if (kind === "backup") pos -= beatsOf(x);
    else if (kind === "forward") pos += beatsOf(x);
    else if (!has(x, "chord") && !has(x, "grace")) {
      const beats = beatsOf(x);
      // a cue note takes its time but isn't sung: the gap becomes a rest
      if (!has(x, "cue")) events.push({ at: pos, beats, x, voice: tag(x, "voice") ?? "1" });
      pos += beats;
    }
    length = Math.max(length, pos);
  }
  events.sort((a, b) => a.at - b.at);
  return { events, length, divisions };
}

/**
 * The score's tempo marks (`<sound tempo>`) by measure index and beat in the measure, in order,
 * from the part with the most of them (scores often mark tempo on the top staff only).
 */
function tempoMarks(xml: string): { index: number; at: number; bpm: number }[] {
  let best: { index: number; at: number; bpm: number }[] = [];
  for (const [, body] of xml.matchAll(/<part id="[^"]+">([\s\S]*?)<\/part>/g)) {
    const marks: { index: number; at: number; bpm: number }[] = [];
    let divisions = 0;
    let pos = 0;
    const beatsOf = (x: string) => (divisions ? Number(tag(x, "duration") ?? 0) / divisions : 0);
    [...body.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)].forEach(([, mxml], index) => {
      pos = 0;
      for (const [all, kind, x] of mxml.matchAll(/<(attributes|note|backup|forward|direction)\b[^>]*>([\s\S]*?)<\/\1>|<sound\b[^>]*\/>/g)) {
        if (kind === "attributes") divisions = Number(tag(x, "divisions") ?? divisions);
        else if (kind === "backup") pos -= beatsOf(x);
        else if (kind === "forward") pos += beatsOf(x);
        else if (kind === "note") {
          if (!has(x, "chord") && !has(x, "grace")) pos += beatsOf(x);
        } else {
          const t = all.match(/<sound[^>]*\stempo="([\d.]+)"/)?.[1];
          if (t && Number(t) > 0) marks.push({ index, at: pos, bpm: Number(t) });
        }
      }
    });
    if (marks.length > best.length) best = marks;
  }
  return best;
}

/** whether a part is written in a men's clef: bass (F) or the octave-down treble (tenor) clef */
export function lowClef(xml: string, partId: string): boolean {
  return [...partBody(xml, partId).matchAll(/<clef\b[^>]*>([\s\S]*?)<\/clef>/g)].some(([, c]) => tag(c, "sign") === "F" || tag(c, "clef-octave-change") === "-1");
}

type Dictionary = { count: (w: string) => number; known: (w: string) => boolean };
let dictionary: Promise<Dictionary> | null = null;
/** syllables per word by the engine's dictionary, as `render notes` uses it, and whether a word is in it */
function loadDictionary(): Promise<Dictionary> {
  dictionary ??= (async () => {
    // engine.ts calls the wasm when it loads, so it is imported only after initChimera
    await initChimera(readFileSync(new URL("../../src/wasm/chimera.wasm", import.meta.url)));
    const { EnglishG2P, lyricsToSyllables } = await import("../../src/wasm/engine.ts");
    const text = gunzipSync(readFileSync(new URL("../../public/data/cmudict.txt.gz", import.meta.url))).toString();
    new EnglishG2P().setDictionaryText(text);
    // "word\tPHONES", alternates as "word(2)\t..."
    const words = new Set(text.split("\n").map((l) => l.split(/[\t(]/)[0].toLowerCase()));
    return { count: (w: string) => lyricsToSyllables(w).length, known: (w: string) => words.has(w.toLowerCase()) };
  })();
  return dictionary;
}

/**
 * One part as a melody. Throws (with every word that doesn't fit, by measure) when the part can't
 * be sung as written. `spell` keys are lowercase words.
 */
export async function convertPart(xml: string, partId: string, opts: { bpm?: number; spell?: Map<string, string> } = {}): Promise<Converted> {
  const spell = opts.spell ?? new Map<string, string>();
  const warnings: string[] = [];
  const body = partBody(xml, partId);

  // The melody file has one bpm (the score's first tempo); later tempo changes are built into the
  // note lengths, so each note lasts as long as it does in the score. --bpm sings it all at one tempo.
  const marks = opts.bpm === undefined ? tempoMarks(xml) : [];
  const bpm = opts.bpm ?? marks[0]?.bpm ?? NaN;
  if (opts.bpm === undefined && !marks.length) throw new Error("the score has no tempo: give --bpm");
  if (!(bpm > 0)) throw new Error(`bad bpm: ${opts.bpm}`);
  if (opts.bpm !== undefined && new Set(tempoMarks(xml).map((m) => m.bpm)).size > 1) warnings.push(`the score changes tempo; --bpm sings all of it at ${bpm} bpm`);
  /** score beats at (measure index, beat in it) → beats at `bpm` */
  const scale = (index: number, at: number) => {
    let t = bpm;
    for (const m of marks) if (m.index < index || (m.index === index && m.at <= at + 1e-9)) t = m.bpm;
    return bpm / t;
  };

  const notes: [number, number][] = [];
  /** one per sounding note: a lyric syllable or a melisma */
  type Sung = { text: string; syllabic: string; measure: string } | { melisma: true; measure: string };
  const sung: Sung[] = [];
  let divisions = 0;
  let tieOpen = false;
  /** the last lyric ended with a typed hyphen: the next one continues its word */
  let hyphenOpen = false;

  const measures = [...body.matchAll(/<measure\b([^>]*)>([\s\S]*?)<\/measure>/g)].map((m) => ({ number: m[1].match(/number="([^"]+)"/)?.[1] ?? "?", implicit: /implicit="yes"/.test(m[1]), xml: m[2] }));
  const jump = measures.find((m) => /<sound[^>]*\s(dacapo|dalsegno|tocoda|fine)="/.test(m.xml));
  if (jump) throw new Error(`measure ${jump.number}: D.C., D.S., To Coda and Fine jumps are not supported; write the jumps out in the score`);

  // Play order: repeats (`<repeat direction=... times=...>`) and voltas (`<ending number="1, 2">`)
  // written out. `pass` is which time through the current repeat (1, 2, ...).
  const order: { number: string; xml: string; pass: number; index: number }[] = [];
  {
    let start = 0;
    let pass = 1;
    let jumped = false;
    let ending: number[] | null = null; // the volta the walk is in, and its passes
    for (let i = 0; i < measures.length; ) {
      const m = measures[i];
      if (/<repeat direction="forward"/.test(m.xml) && !jumped) {
        start = i;
        pass = 1;
      }
      jumped = false;
      const begins = m.xml.match(/<ending number="([^"]+)" type="start"/);
      if (begins) ending = begins[1].split(/[\s,]+/).filter(Boolean).map(Number);
      const play = !ending || ending.includes(pass);
      if (/<ending number="[^"]+" type="(stop|discontinue)"/.test(m.xml)) ending = null;
      if (!play) {
        i++;
        continue;
      }
      order.push({ number: m.number, xml: m.xml, pass, index: i });
      const back = m.xml.match(/<repeat direction="backward"(?:\s+times="(\d+)")?/);
      if (back && pass < Number(back[1] ?? 2)) {
        pass++;
        i = start;
        jumped = true;
        ending = null;
        continue;
      }
      if (back) {
        start = i + 1;
        pass = 1;
      }
      i++;
    }
  }
  const verses = new Set([...body.matchAll(/<lyric\b[^>]*\snumber="([^"]+)"/g)].map((m) => m[1]));
  const passes = Math.max(...order.map((m) => m.pass));
  if (verses.size > passes) warnings.push(`the part has ${verses.size} lyric lines (${[...verses].join(", ")}) but is sung ${passes} time(s); each pass sings its own line, the rest are unused`);

  let pickupBeats = 0;
  let lastVoice = "1";
  const rest = (beats: number) => {
    const last = notes[notes.length - 1];
    if (last && last[0] <= 0) last[1] += beats;
    else notes.push([0, beats]);
    tieOpen = false;
  };
  /** measures where the staff had more than one voice: the voice sung → measures */
  const voiceChoices = new Map<string, string[]>();
  for (const { number: measure, xml: mxml, pass, index } of order) {
    // the measure's notes with their start (beats into the measure) and voice
    const { events, length, divisions: d } = measureEvents(mxml, divisions, measure);
    divisions = d;
    // One head sings one line. With two voices on the staff, sing the one with more words (on a
    // tie, the voice sung before); its silences are rests.
    const voices = [...new Set(events.filter((e) => !has(e.x, "rest")).map((e) => e.voice))];
    let voice = voices[0] ?? events[0]?.voice ?? lastVoice;
    if (voices.length > 1) {
      const words = (v: string) => events.filter((e) => e.voice === v && /<lyric\b/.test(e.x)).length;
      const best = Math.max(...voices.map(words));
      const tied = voices.filter((v) => words(v) === best).sort();
      voice = tied.includes(lastVoice) ? lastVoice : tied[0];
      const key = `voice ${voice} of ${voices.length}`;
      voiceChoices.set(key, [...(voiceChoices.get(key) ?? []), measure]);
    }
    lastVoice = voice;
    let cursor = 0;
    const timed = (at: number, beats: number) => beats * scale(index, at);
    const line = events.filter((e) => e.voice === voice);
    for (const { at, beats: raw, x } of [...line, { at: length, beats: 0, x: "" }]) {
      if (at > cursor + 1e-9) {
        if (index === 0 && measures[0].implicit) pickupBeats += timed(cursor, at - cursor);
        rest(timed(cursor, at - cursor));
      }
      cursor = Math.max(cursor, at + raw);
      if (!x) break;
      const beats = timed(at, raw);
      if (index === 0 && measures[0].implicit) pickupBeats += beats;
      if (has(x, "rest")) {
        rest(beats);
        continue;
      }
      const pitch = tag(x, "pitch");
      if (!pitch) throw new Error(`measure ${measure}: a note with no pitch (unpitched parts are not supported)`);
      const midi = 12 * (Number(tag(pitch, "octave")) + 1) + STEP[tag(pitch, "step") ?? ""] + Math.round(Number(tag(pitch, "alter") ?? 0));
      const ties = new Set([...x.matchAll(/<tie type="(\w+)"/g)].map((t) => t[1]));
      if (tieOpen && ties.has("stop")) {
        notes[notes.length - 1][1] += beats;
        tieOpen = ties.has("start");
        continue;
      }
      tieOpen = ties.has("start");
      notes.push([midi, beats]);
      // each pass through a repeat sings its own verse line when the score has one
      const lyrics = [...x.matchAll(/<lyric\b([^>]*)>([\s\S]*?)<\/lyric>/g)];
      const lyric = (lyrics.find((l) => l[1].match(/number="([^"]+)"/)?.[1] === String(pass)) ?? lyrics[0])?.[2] ?? null;
      if (lyric === null) {
        if (!sung.length) throw new Error(`measure ${measure}: the first sung note has no lyric, so there is no vowel to hold`);
        sung.push({ melisma: true, measure });
        continue;
      }
      // a lyric's text may be split around <elision>; join the pieces
      let text = unescape([...lyric.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((t) => t[1]).join("")).trim();
      // some scores type a hold as a lyric that is only a dash or underscore
      if (/^[-_–—]+$/.test(text)) {
        if (!sung.length) throw new Error(`measure ${measure}: the first sung note has no lyric, so there is no vowel to hold`);
        sung.push({ melisma: true, measure });
        continue;
      }
      // and some split a word with a typed hyphen ("A -", "ny") instead of <syllabic>
      let syllabic = tag(lyric, "syllabic") ?? "single";
      // (a capital starts a new word: "see -", "I'm" is a hold, not "seeI'm")
      if (hyphenOpen && !/^[A-Z]/.test(text)) syllabic =syllabic === "single" || syllabic === "end" ? "end" : "middle";
      hyphenOpen = /[-–]$/.test(text);
      if (hyphenOpen) {
        text = text.replace(/\s*[-–]+$/, "");
        syllabic = syllabic === "single" ? "begin" : syllabic === "end" ? "middle" : syllabic;
      }
      sung.push({ text, syllabic, measure });
    }
  }
  for (const [choice, ms] of voiceChoices) warnings.push(`more than one voice on the staff: sang ${choice}, the one with more words (measure ${ms.join(", ")}); split the voices into parts to sing them all`);

  // words: their pieces (score syllables) and the melisma notes after each piece
  type Word = { pieces: string[]; holds: number[]; measure: string };
  const words: Word[] = [];
  let open: Word | null = null;
  for (const s of sung) {
    if ("melisma" in s) {
      const w = open ?? words[words.length - 1];
      w.holds[w.holds.length - 1]++;
      continue;
    }
    if (!open || s.syllabic === "single" || s.syllabic === "begin") {
      open = { pieces: [], holds: [], measure: s.measure };
      words.push(open);
    }
    open.pieces.push(s.text);
    open.holds.push(0);
    if (s.syllabic === "single" || s.syllabic === "end") open = null;
  }

  const { count, known } = await loadDictionary();
  const tokens: string[] = [];
  // messages grouped by word: "word: what" → measures
  const errors = new Map<string, string[]>();
  const warned = new Map<string, string[]>();
  const note = (to: Map<string, string[]>, key: string, measure: string) => to.set(key, [...(to.get(key) ?? []), measure]);
  // letters and apostrophes only (U+FFFD: an apostrophe lost to a bad encoding on export,
  // "doesn�t"), and a letter typed three or more times twice: the dictionary doesn't know
  // "ooo" and its rules make it two syllables, but "oo" is one (no English word has a triple letter)
  const clean = (s: string) =>
    s
      .replace(/[’‘ʼ�]/g, "'")
      .replace(/[^A-Za-z']/g, "")
      .replace(/([a-z])\1{2,}/gi, (run) => run.slice(0, 2));
  const respell = (s: string) => spell.get(s.toLowerCase()) ?? s;
  for (const w of words) {
    const joined = clean(w.pieces.join(""));
    if (!joined) throw new Error(`measure ${w.measure}: the lyric "${w.pieces.join("-")}" has no letters`);
    const word = respell(joined);
    const k = w.pieces.length;
    const n = count(word);
    const inner = w.holds.slice(0, -1).some((h) => h > 0);
    // each piece says itself ("Ahh-ohh-oo", "Doh-oo"): sing the pieces as words, each melisma
    // where it is (a melisma mark needs spaces round it, so a typed hyphen can't join the pieces
    // across it). Done when the word is held inside, when joined it doesn't fit its notes, or when
    // it isn't in the dictionary: the rules read a joined vocable's silent h's as consonants
    // ("ahhohhoo" is "æ-hɑ-hu"), and the score's own split is better than a guess. A word the
    // user respelled is sung as respelled.
    const pieces = w.pieces.map((p) => respell(clean(p)));
    const fits = n > 0 && n <= k;
    const unknown = !known(word) && !spell.has(joined.toLowerCase());
    if (k > 1 && (!fits || unknown || (inner && n === k)) && pieces.every((p) => p && count(p) === 1)) {
      pieces.forEach((p, i) => tokens.push(` ${p}`, ...Array.from({ length: w.holds[i] }, () => " -")));
      continue;
    }
    if (!fits) {
      // one entry per word whatever its case: spellings match without case too
      note(errors, `"${word.toLowerCase()}": ${n} syllable(s) on ${k} note(s)`, w.measure);
      continue;
    }
    if (inner) note(warned, `"${word.toLowerCase()}" is held at its end, not between its syllables`, w.measure);
    if (n < k) note(warned, `"${word.toLowerCase()}" has ${n} syllable(s) on ${k} notes: its last vowel holds over the rest`, w.measure);
    const holds = w.holds.reduce((a, b) => a + b, 0) + (k - n);
    tokens.push(` ${word}`, ...Array.from({ length: holds }, () => " -"));
  }
  const list = (m: Map<string, string[]>) => [...m].map(([k, ms]) => `${k} (measure ${[...new Set(ms)].join(", ")})`);
  warnings.push(...list(warned));
  if (errors.size) throw new Error(`the dictionary can't fit these words to their notes; respell them with --spell word=respelling:\n${list(errors).map((l) => `  ${l}`).join("\n")}`);

  return { melody: { bpm, lyrics: tokens.join("").trim(), notes }, warnings, pickupBeats };
}

/** `--spell ba=bah,dm=dum` → lowercase word → respelling */
export function parseSpell(arg: string | undefined): Map<string, string> {
  return new Map(
    (arg ?? "")
      .split(",")
      .filter(Boolean)
      .map((p) => {
        const [from, to] = p.split("=");
        if (!from || !to) throw new Error(`--spell: "${p}" is not from=to`);
        return [from.toLowerCase(), to] as const;
      }),
  );
}
