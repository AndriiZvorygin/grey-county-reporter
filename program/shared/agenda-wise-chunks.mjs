import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTextModel } from "../../../../../program/runtime/gpu/text-model.mjs";
import { requestManagedOllamaChat } from "../../../../../program/runtime/gpu/managed-ollama.mjs";

const HOUSE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIGURED_MODEL = resolveTextModel("", { runtimePath: path.join(HOUSE_ROOT, "conduct", "runtime.pya") });

async function managedChat({ ollamaUrl, llmModel, messages, options = {} }) {
  return requestManagedOllamaChat({
    model: llmModel || CONFIGURED_MODEL,
    ollamaUrl,
    managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
    messages,
    options,
    think: false,
    keepAlive: 300,
  });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9\s]/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "with", "by", "from", "re",
  "there", "are", "is", "be", "that", "this", "it", "as", "into", "held", "meeting", "minutes",
  "city", "council", "committee", "whole", "session", "motion", "report", "reports", "received",
]);

function tokenSet(value) {
  const out = new Set();
  for (const t of normalizeText(value).split(" ")) {
    if (!t || t.length < 3) continue;
    if (STOP.has(t)) continue;
    out.add(t);
  }
  return out;
}

function numberToWords(n) {
  const small = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  ];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty"];
  if (n < 20) return small[n] || String(n);
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${tens[t]} ${small[o]}` : tens[t];
}

function itemCuePhrases(item) {
  const m = String(item || "").match(/^(\d+)(?:\.([a-z]))?$/i);
  if (!m) return [];
  const main = Number(m[1]);
  const letter = (m[2] || "").toLowerCase();
  const mainWord = numberToWords(main);
  const out = [
    `number ${mainWord}`,
    `item ${mainWord}`,
    `at number ${mainWord}`,
  ];
  if (letter) {
    out.push(`number ${mainWord} ${letter}`);
    out.push(`item ${mainWord} ${letter}`);
    out.push(`${mainWord} ${letter}`);
    out.push(`number ${main} ${letter}`);
  }
  return out;
}

function cueStrength(item, paraNorm) {
  const cues = itemCuePhrases(item);
  let best = 0;
  for (const cue of cues) {
    if (!cue || cue.length < 3) continue;
    if (!paraNorm.includes(cue)) continue;
    best = Math.max(best, cue.includes("number ") || cue.includes("item ") ? 0.85 : 0.45);
  }
  return best;
}

function titleScore({ item, title }, paraText) {
  const paraNorm = normalizeText(paraText);
  if (!paraNorm) return 0;

  const titleTokens = tokenSet(title);
  if (!titleTokens.size) return 0;

  let overlap = 0;
  for (const t of titleTokens) {
    if (paraNorm.includes(t)) overlap += 1;
  }
  let score = overlap / Math.max(4, titleTokens.size);

  const titleNorm = normalizeText(title);
  if (titleNorm && paraNorm.includes(titleNorm.slice(0, 36))) score += 0.3;
  const cueWords = [...titleTokens].slice(0, 3);
  if (cueWords.length >= 2) {
    const cue = cueWords.join(" ");
    if (paraNorm.includes(cue)) score += 0.25;
  }

  if (item) score += cueStrength(item, paraNorm);
  if (paraNorm.startsWith("at number")) score += 0.08;
  return score;
}

function sectionHeadingCuePhrases(section) {
  const title = normalizeText(section?.title || "");
  const cues = [];
  if (!title) return cues;

  // Strip long motion tails so we keep the semantic heading core.
  const core = title.split(/\bthat\b/iu)[0]?.trim() || title;
  if (core) cues.push(core);

  if (/\bdeclarations?\s+of\s+interest\b/iu.test(title) || /\bdeclaration\s+of\s+interest\b/iu.test(title)) {
    cues.push("declaration of interest");
    cues.push("declarations of interest");
  }
  if (/\bbusiness\s+arising\s+from\s+(?:the\s+)?minutes\b/iu.test(title)) {
    cues.push("business arising from the minutes");
    cues.push("business arising from minutes");
  }
  if (/\bdelegations?\b/iu.test(title)) cues.push("delegations");
  if (/\bdetermination\s+of\s+items\s+requiring\s+separate\s+discussion\b/iu.test(title)) {
    cues.push("determination of items requiring separate discussion");
  }
  if (/\bconsent\s+agenda\b/iu.test(title)) cues.push("consent agenda");
  if (/\bitems?\s+for\s+direction\s+and\s+discussion\b/iu.test(title)) cues.push("items for direction and discussion");
  if (/\bclosed\s+meeting\s+matters\b/iu.test(title)) cues.push("closed meeting matters");
  if (/\bother\s+business\b/iu.test(title)) cues.push("other business");
  if (/\bnotice\s+of\s+motion\b/iu.test(title)) cues.push("notice of motion");
  return [...new Set(cues.filter((x) => x && x.length >= 8))];
}

function findHeadingCueParagraph(section, paragraphs, startIndex, endExclusive) {
  const cues = sectionHeadingCuePhrases(section);
  if (!cues.length) return -1;
  for (let p = Math.max(0, startIndex); p < Math.min(paragraphs.length, endExclusive); p += 1) {
    const pn = normalizeText(paragraphs[p]);
    if (!pn) continue;
    for (const cue of cues) {
      if (pn.includes(cue)) return p;
    }
  }
  return -1;
}

function sectionCueRegex(section) {
  const item = String(section?.item || "");
  const title = normalizeText(section?.title || "");
  const cues = [];
  if (item === "2" || title.includes("call for additional business")) cues.push("\\bcall\\s+for\\s+additional\\s+business\\b");
  if (item === "3" || title.includes("declarations of interest")) cues.push("\\bdeclarations?\\s+of\\s+interest\\b");
  if (item === "4" || title.includes("confirmation of the council minutes")) {
    cues.push("\\bconfirmation\\s+of\\s+(?:the\\s+)?council\\s+minutes\\b");
    cues.push("\\bminutes\\s+of\\s+the\\s+following\\s+meetings\\b");
  }
  if (item === "5" || title.includes("move council into committee of the whole")) {
    cues.push("\\bmotion\\s+to\\s+move\\s+council\\s+into\\s+committee\\s+of\\s+the\\s+whole\\b");
    cues.push("\\bmove\\s+into\\s+committee\\s+of\\s+the\\s+whole\\b");
  }
  if (item === "6" || title.includes("public meetings")) {
    cues.push("\\bno\\s+public\\s+meetings\\b");
    cues.push("\\bpublic\\s+meetings\\b");
  }
  if (item === "7" || title.includes("deputations") || title.includes("presentations")) {
    cues.push("\\bdeputations?\\s+and\\s+presentations?\\b");
    cues.push("\\bdeputation\\s+from\\b");
    cues.push("\\bnumber\\s+seven\\b.*\\bdeputation\\b");
  }
  if (item === "8") {
    cues.push("\\bnumber\\s+eight\\s+is\\s+public\\s+forum\\b");
    cues.push("\\bfor\\s+public\\s+forum\\s+have\\s+been\\s+submitted\\b");
  }
  if (item === "9") {
    cues.push("\\bmove\\s+on\\s+from\\s+number\\s+eight\\b.*\\bnumber\\s+nine\\b");
    cues.push("\\bnumber\\s+nine\\b.*\\bcorrespondence\\b");
  }
  if (item) {
    const m = item.match(/^(\d+)(?:\.([a-z]))?$/i);
    if (m) {
      const n = Number(m[1]);
      const w = numberToWords(n).replace(/\s+/gu, "\\s+");
      cues.push(`\\b(?:at\\s+)?number\\s+${w}\\b`);
      cues.push(`\\bitem\\s+${w}\\b`);
    }
  }
  if (title.includes("public forum")) cues.push("\\bpublic\\s+forum\\b");
  if (title.includes("correspondence")) cues.push("\\bcorrespondence\\b");
  if (title.includes("reports of city staff")) {
    cues.push("\\breports?\\s+of\\s+city\\s+staff\\b");
    cues.push("\\breports?\\s+from\\s+city\\s+staff\\b");
    cues.push("\\b10\\s*a\\b.*\\breports?\\s+from\\s+city\\s+staff\\b");
  }
  if (title.includes("consent agenda")) cues.push("\\bconsent\\s+agenda\\b");
  if (title.includes("committee minutes")) {
    cues.push("\\bcommittee\\s+minutes\\b");
    cues.push("\\bminutes\\s+of\\s+the\\s+corporate\\s+services\\s+committee\\b");
  }
  if (title.includes("motions for which notice was previously given")) {
    cues.push("\\bmotions?\\s+for\\s+which\\s+notice\\s+was\\s+previously\\s+given\\b");
    cues.push("\\bno\\s+motions?\\s+that\\s+were\\s+previously\\s+given\\b");
  }
  if (title.includes("discussion of additional business")) cues.push("\\bdiscussion\\s+of\\s+additional\\s+business\\b");
  if (title.includes("rise and report")) cues.push("\\brise\\s+and\\s+report\\b");
  if (title.includes("adopt proceedings in committee of the whole")) cues.push("\\badopt\\s+proceedings\\s+in\\s+committee\\s+of\\s+the\\s+whole\\b");
  if (title.includes("move into closed session")) cues.push("\\bmove\\s+into\\s+closed\\s+session\\b");
  if (title.includes("reporting out of closed session")) cues.push("\\breturning\\s+to\\s+the\\s+open\\s+session|reporting\\s+out\\b");
  if (!cues.length) return null;
  return new RegExp(cues.join("|"), "iu");
}

function parseAgendaItem(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})(?:\.([a-z]))?\.?$/iu);
  if (!m) return null;
  const mainNum = Number(m[1]);
  const sub = String(m[2] || "").toLowerCase();
  const hasDot = raw.includes(".");
  if (!sub && !raw.endsWith(".") && !hasDot) return null;
  const item = sub ? `${mainNum}.${sub}` : String(mainNum);
  return { item, mainNum, sub };
}

function parseAgendaSections(agendaText) {
  const lines = agendaText.split(/\r?\n/u).map((x) => x.trim());
  const sections = [];
  const isBigHeading = (s) => /^[A-Z][A-Z\s&'\-]+$/u.test(s) && s.length >= 8;
  const seen = new Set();
  let lastMainNum = 0;

  function pushSection(item, title) {
    const cleanTitle = String(title || "").replace(/\s+/gu, " ").trim();
    if (!item || !cleanTitle) return;
    if (/^(BY-LAWS|ADJOURNMENT|MATTERS POSTPONED|NOTICES OF MOTION)/iu.test(cleanTitle)) return;
    if (seen.has(item)) return;
    seen.add(item);
    sections.push({ item, title: cleanTitle });
  }

  function splitInlineSubitems(mainItem, title) {
    const out = [];
    const itemMatch = String(mainItem || "").match(/^(\d+)$/u);
    if (!itemMatch) {
      out.push({ item: mainItem, title });
      return out;
    }
    const mainNum = itemMatch[1];
    const full = String(title || "").trim();
    const subRe = new RegExp(`(?:^|\\s)(${mainNum}\\.[a-z])\\s+`, "giu");
    const markers = [];
    for (const m of full.matchAll(subRe)) {
      const idx = Number(m.index || 0) + (String(m[0] || "").startsWith(" ") ? 1 : 0);
      markers.push({ item: String(m[1] || "").toLowerCase(), idx });
    }
    if (!markers.length) {
      out.push({ item: mainItem, title: full });
      return out;
    }

    const before = full.slice(0, markers[0].idx).trim();
    if (before) out.push({ item: mainItem, title: before });
    for (let i = 0; i < markers.length; i += 1) {
      const cur = markers[i];
      const next = markers[i + 1];
      const sliceStart = cur.idx;
      const sliceEnd = next ? next.idx : full.length;
      const chunk = full.slice(sliceStart, sliceEnd).trim();
      const strip = chunk.replace(new RegExp(`^${cur.item}\\s+`, "iu"), "").trim();
      if (strip) out.push({ item: cur.item, title: strip });
    }
    return out;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const parsedItem = parseAgendaItem(line);
    if (!parsedItem) continue;
    const { item, mainNum, sub } = parsedItem;
    if (!sub && lastMainNum > 0 && mainNum + 2 < lastMainNum) continue;
    if (!sub) lastMainNum = mainNum;
    const titleParts = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const s = lines[j];
      if (!s) continue;
      if (parseAgendaItem(s)) break;
      if (/^Page\s+\d+\s+of\s+\d+/iu.test(s)) break;
      if (/^\d+$/u.test(s)) continue;
      if (isBigHeading(s) && titleParts.length > 0) break;
      if (s === "•") continue;
      titleParts.push(s);
      if (titleParts.join(" ").length > 260) break;
    }
    const title = titleParts.join(" ").replace(/\s+/gu, " ").trim();
    if (!title) continue;
    const split = splitInlineSubitems(item, title);
    for (const part of split) pushSection(part.item, part.title);
  }
  return sections;
}

function splitParagraphs(plainText) {
  const paras = plainText
    .split(/\n\s*\n+/u)
    .map((p) => p.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const out = [];
  for (const para of paras) {
    const bits = para.split(/(?<=[.!?])\s+/u).map((x) => x.trim()).filter(Boolean);
    if (bits.length <= 1) out.push(para);
    else out.push(...bits);
  }
  return out;
}

function buildSnippet(text, max = 220) {
  const one = String(text || "").replace(/\s+/gu, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 3)}...`;
}

function words(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  return t.split(/\s+/u).length;
}

function buildGrossWindows(paragraphs, startIndex, searchEnd, { targetWords = 1800, maxWindows = 14 } = {}) {
  const lo = Math.max(0, Math.min(paragraphs.length - 1, startIndex));
  const hiExclusive = Math.max(lo + 1, Math.min(paragraphs.length, searchEnd));
  const windows = [];
  let i = lo;
  while (i < hiExclusive) {
    let j = i;
    let count = 0;
    while (j < hiExclusive && count < targetWords) {
      count += words(paragraphs[j]);
      j += 1;
    }
    const end = Math.max(i, j - 1);
    const preview = [
      buildSnippet(paragraphs[i], 140),
      end > i ? buildSnippet(paragraphs[Math.min(end, i + 3)], 140) : "",
      end > i + 4 ? buildSnippet(paragraphs[end], 140) : "",
    ].filter(Boolean).join(" | ");
    windows.push({ start: i, end, preview });
    i = end + 1;
  }
  if (windows.length <= maxWindows) return windows;
  const step = Math.ceil(windows.length / maxWindows);
  const compact = [];
  for (let k = 0; k < windows.length; k += step) compact.push(windows[k]);
  if (compact.at(-1)?.end !== windows.at(-1)?.end) compact.push(windows.at(-1));
  return compact.slice(0, maxWindows);
}

async function ollamaPickGrossWindow({ section, startIndex, paragraphs, searchEnd, llmModel, ollamaUrl }) {
  const windows = buildGrossWindows(paragraphs, startIndex, searchEnd);
  const prompt = [
    "Pick the best gross transcript window where this agenda segment likely begins.",
    "Return strict JSON only: {\"start\": <num>, \"end\": <num>, \"reason\": \"short\"}",
    "",
    `Agenda item: ${section.item}`,
    `Agenda title: ${section.title}`,
    `Search start index: ${startIndex}`,
    `Search end index: ${Math.max(startIndex, searchEnd - 1)}`,
    "",
    "Window candidates:",
    JSON.stringify(windows, null, 2),
  ].join("\n");

  const body = {
    model: llmModel,
    stream: false,
    think: false,
    options: { temperature: 0.1 },
    messages: [
      { role: "system", content: "You align agenda sections to transcript windows. Output strict JSON only." },
      { role: "user", content: prompt },
    ],
  };

  const payload = await managedChat({ ollamaUrl, llmModel, messages: body.messages, options: body.options });
  const text = String(payload?.message?.content || "").trim();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/u);
    if (m) parsed = JSON.parse(m[0]);
  }
  const start = Number(parsed?.start);
  const end = Number(parsed?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: startIndex, end: Math.max(startIndex, searchEnd - 1), reason: "unparseable-json" };
  const boundedStart = Math.max(startIndex, Math.floor(start));
  const boundedEnd = Math.min(Math.max(boundedStart, Math.floor(end)), Math.max(startIndex, searchEnd - 1));
  return { start: boundedStart, end: boundedEnd, reason: String(parsed?.reason || "").slice(0, 180) };
}

async function ollamaPickParagraph({ section, startIndex, paragraphs, topCandidates, searchEnd, llmModel, ollamaUrl }) {
  let narrowedStart = startIndex;
  let narrowedEndExclusive = Math.min(paragraphs.length, searchEnd);
  let grossReason = "";
  const bestScore = Number(topCandidates?.[0]?.score || 0);
  if (bestScore < 0.95) {
    try {
      const gross = await ollamaPickGrossWindow({
        section,
        startIndex,
        paragraphs,
        searchEnd,
        llmModel,
        ollamaUrl,
      });
      narrowedStart = Math.max(startIndex, Math.min(searchEnd - 1, gross.start));
      narrowedEndExclusive = Math.max(narrowedStart + 1, Math.min(paragraphs.length, gross.end + 1));
      grossReason = gross.reason || "";
    } catch {
      // keep default search window
    }
  }

  const topInWindow = topCandidates
    .filter((c) => c.index >= narrowedStart && c.index < narrowedEndExclusive)
    .slice(0, 12);
  const candidates = topInWindow.map((c) => ({
    idx: c.index,
    score: Number(c.score.toFixed(3)),
    text: buildSnippet(paragraphs[c.index], 240),
  }));
  if (!candidates.length) {
    for (let i = narrowedStart; i < narrowedEndExclusive && candidates.length < 12; i += 1) {
      candidates.push({ idx: i, score: 0, text: buildSnippet(paragraphs[i], 220) });
    }
  }

  const prompt = [
    "Pick the best transcript paragraph index where this agenda segment starts.",
    "Return JSON only: {\"index\": <number or -1>, \"reason\": \"short\"}",
    "",
    `Agenda item: ${section.item}`,
    `Agenda title: ${section.title}`,
    `Search start index: ${narrowedStart}`,
    `Search end index: ${Math.max(narrowedStart, narrowedEndExclusive - 1)}`,
    "",
    "Candidates:",
    JSON.stringify(candidates, null, 2),
  ].join("\n");

  const body = {
    model: llmModel,
    stream: false,
    think: false,
    options: { temperature: 0.1 },
    messages: [
      { role: "system", content: "You align municipal agenda items to transcript paragraphs. Output strict JSON only." },
      { role: "user", content: prompt },
    ],
  };

  const payload = await managedChat({ ollamaUrl, llmModel, messages: body.messages, options: body.options });
  const text = String(payload?.message?.content || "").trim();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/u);
    if (m) parsed = JSON.parse(m[0]);
  }
  const index = Number(parsed?.index);
  if (!Number.isFinite(index)) return { index: -1, reason: "unparseable-json" };
  const reason = [grossReason, String(parsed?.reason || "").slice(0, 180)].filter(Boolean).join(" / ");
  return { index, reason };
}

function buildSectionStarts({ sections, chosen, paragraphCount }) {
  const byItem = new Map(chosen.map((m) => [m.item, m]));
  const starts = sections.map((s) => {
    const hit = byItem.get(s.item);
    return Number.isInteger(hit?.paragraphIndex) ? hit.paragraphIndex : null;
  });
  if (starts.length && starts[0] == null) starts[0] = 0;

  let i = 0;
  while (i < starts.length) {
    if (starts[i] != null) { i += 1; continue; }
    const gapStart = i;
    while (i < starts.length && starts[i] == null) i += 1;
    const gapEnd = i - 1;
    const prevIdx = gapStart - 1;
    const nextIdx = i < starts.length ? i : -1;
    const prevStart = prevIdx >= 0 && starts[prevIdx] != null ? starts[prevIdx] : 0;
    const nextStart = nextIdx >= 0 && starts[nextIdx] != null ? starts[nextIdx] : Math.max(prevStart + 1, paragraphCount - 1);
    const span = Math.max(1, nextStart - prevStart);
    const count = gapEnd - gapStart + 1;
    for (let g = 0; g < count; g += 1) {
      const pos = Math.floor(((g + 1) * span) / (count + 1));
      starts[gapStart + g] = Math.min(paragraphCount - 1, prevStart + pos);
    }
  }
  for (let k = 1; k < starts.length; k += 1) {
    if (starts[k] <= starts[k - 1]) starts[k] = Math.min(paragraphCount - 1, starts[k - 1] + 1);
  }
  return starts;
}

async function ollamaRefineSectionWindow({ section, nextSection, paragraphs, minStart, maxEnd, llmModel, ollamaUrl }) {
  const lo = Math.max(0, minStart);
  const hi = Math.max(lo, Math.min(paragraphs.length - 1, maxEnd));
  const maxCandidates = 30;
  const span = hi - lo + 1;
  const step = Math.max(1, Math.ceil(span / maxCandidates));
  const candidates = [];
  for (let i = lo; i <= hi; i += step) {
    candidates.push({ idx: i, text: buildSnippet(paragraphs[i], 180) });
  }
  if (candidates.at(-1)?.idx !== hi) candidates.push({ idx: hi, text: buildSnippet(paragraphs[hi], 180) });

  const prompt = [
    "Choose the best section start and end paragraph index inside this range.",
    "Return strict JSON only: {\"start\": <num>, \"end\": <num>, \"reason\": \"short\"}",
    "",
    `Section item: ${section.item}`,
    `Section title: ${section.title}`,
    `Next section: ${nextSection ? `${nextSection.item} ${nextSection.title}` : "(none)"}`,
    `Allowed range: ${lo}..${hi}`,
    "",
    "Rules:",
    "- Start where this section actually begins in transcript flow.",
    "- End where this section ends, before next section begins.",
    "- Keep ordering coherent with agenda progression.",
    "",
    "Candidate anchors:",
    JSON.stringify(candidates, null, 2),
  ].join("\n");

  const body = {
    model: llmModel,
    stream: false,
    think: false,
    options: { temperature: 0.1 },
    messages: [
      { role: "system", content: "You align municipal agenda sections to transcript boundaries. Output strict JSON only." },
      { role: "user", content: prompt },
    ],
  };

  const payload = await managedChat({ ollamaUrl, llmModel, messages: body.messages, options: body.options });
  const text = String(payload?.message?.content || "").trim();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/u);
    if (m) parsed = JSON.parse(m[0]);
  }
  const start = Number(parsed?.start);
  const end = Number(parsed?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: lo, end: lo, reason: "unparseable-json" };
  const boundedStart = Math.min(hi, Math.max(lo, Math.floor(start)));
  const boundedEnd = Math.min(hi, Math.max(boundedStart, Math.floor(end)));
  return { start: boundedStart, end: boundedEnd, reason: String(parsed?.reason || "").slice(0, 180) };
}

function toSeriesText(chips) {
  const lines = ["su name wise chips be series def"];
  for (let i = 0; i < chips.length; i += 1) {
    const n = String(i + 1).padStart(3, "0");
    const text = JSON.stringify(chips[i].text);
    const since = Number(chips[i]?.startParagraph ?? 0);
    const until = Number(chips[i]?.untilParagraph ?? since);
    const safeSince = Number.isFinite(since) ? since : 0;
    const safeUntil = Number.isFinite(until) ? Math.max(safeSince, until) : safeSince;
    lines.push(`su name wise chip ${n} since num ${safeSince} until num ${safeUntil} ob text ${text} ya`);
  }
  lines.push("prah");
  return `${lines.join("\n")}\n`;
}

export async function generateAgendaWiseArtifacts({
  plainPath,
  agendaPath,
  outputPath,
  matchPath,
  useLlmRange = false,
  llmModel = "",
  ollamaUrl = "http://mriczo:11434/api/chat",
  log = () => {},
}) {
  const paragraphs = splitParagraphs(fs.readFileSync(plainPath, "utf8"));
  if (!paragraphs.length) throw new Error("plain transcript has no paragraphs");
  const sections = parseAgendaSections(fs.readFileSync(agendaPath, "utf8"));
  if (!sections.length) throw new Error("agenda parser found no sections");

  const chosen = [];
  let cursor = 0;
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    const remainSections = Math.max(1, sections.length - i);
    const remainParagraphs = Math.max(1, paragraphs.length - cursor);
    const expectedPerSection = Math.max(6, Math.floor(remainParagraphs / remainSections));
    const searchEnd = Math.min(paragraphs.length, cursor + Math.max(35, expectedPerSection * 4));
    const top = [];
    for (let p = cursor; p < searchEnd; p += 1) {
      const score = titleScore(sec, paragraphs[p]);
      if (score <= 0.08) continue;
      top.push({ index: p, score });
    }
    top.sort((a, b) => b.score - a.score || a.index - b.index);

    const best = top[0] || { index: -1, score: 0 };
    let finalIndex = -1;
    let method = "none";
    let confidence = 0;
    let reason = "";

    // Primary selector: token-bounded gross-window LLM -> paragraph LLM pick.
    // Deterministic cue and token-overlap methods are fallback only.
    try {
      const pick = await ollamaPickParagraph({
        section: sec,
        startIndex: cursor,
        paragraphs,
        topCandidates: top,
        searchEnd,
        llmModel,
        ollamaUrl,
      });
      if (Number.isInteger(pick.index) && pick.index >= cursor && pick.index < searchEnd) {
        finalIndex = pick.index;
        method = "llm-primary";
        confidence = Math.max(0.9, Number(best.score || 0));
        reason = pick.reason;
      }
    } catch (err) {
      reason = `llm-error: ${String(err?.message || err)}`;
    }

    if (finalIndex < 0) {
      const cueRe = sectionCueRegex(sec);
      const headingCueIndex = findHeadingCueParagraph(sec, paragraphs, cursor, searchEnd);
      if (headingCueIndex >= 0) {
        finalIndex = headingCueIndex;
        method = "heading-cue-fallback";
        confidence = 1.35;
        reason = "fallback: matched heading cue phrase";
      } else if (cueRe) {
        for (let p = cursor; p < searchEnd; p += 1) {
          const pn = normalizeText(paragraphs[p]);
          if (!pn) continue;
          if (cueRe.test(pn)) {
            finalIndex = p;
            method = "cue-fallback";
            confidence = 1.5;
            reason = "fallback: matched section cue";
            break;
          }
        }
      } else if (best.index >= 0 && best.score >= 0.95) {
        finalIndex = best.index;
        method = "programmatic-fallback";
        confidence = best.score;
        reason = "fallback: high token overlap";
      }
    }

    if (finalIndex >= 0) {
      if (chosen.length && finalIndex <= chosen[chosen.length - 1].paragraphIndex) {
        finalIndex = chosen[chosen.length - 1].paragraphIndex + 1;
      }
      if (finalIndex < paragraphs.length) {
        chosen.push({
          item: sec.item,
          title: sec.title,
          paragraphIndex: finalIndex,
          method,
          score: Number(confidence.toFixed(4)),
          reason,
          snippet: buildSnippet(paragraphs[finalIndex], 220),
        });
        cursor = Math.min(paragraphs.length - 1, finalIndex + 1);
      }
    }
    log(`[agenda-wise] atindex num ${i + 1} toindex num ${sections.length} item ${sec.item} method ${method} paragraph ${finalIndex} score ${confidence.toFixed(3)}`);
  }

  const starts = buildSectionStarts({ sections, chosen, paragraphCount: paragraphs.length });
  const boundaries = sections.map((sec, i) => {
    const start = starts[i];
    const end = i + 1 < starts.length ? Math.max(start, starts[i + 1] - 1) : paragraphs.length - 1;
    return { item: sec.item, title: sec.title, start, end, method: "seed", reason: "" };
  });

  for (let i = 0; i < boundaries.length; i += 1) {
    if (useLlmRange) {
      const prevEnd = i > 0 ? boundaries[i - 1].end : -1;
      const nextStartSeed = i + 1 < boundaries.length ? boundaries[i + 1].start : paragraphs.length - 1;
      const minStart = Math.max(prevEnd + 1, boundaries[i].start - 2);
      const maxEnd = Math.min(paragraphs.length - 1, Math.max(minStart, nextStartSeed + 2));
      try {
        const refined = await ollamaRefineSectionWindow({
          section: sections[i],
          nextSection: sections[i + 1] || null,
          paragraphs,
          minStart,
          maxEnd,
          llmModel,
          ollamaUrl,
        });
        boundaries[i].start = refined.start;
        boundaries[i].end = refined.end;
        boundaries[i].method = "llm-range";
        boundaries[i].reason = refined.reason;
      } catch (err) {
        boundaries[i].method = "seed";
        boundaries[i].reason = `llm-refine-error: ${String(err?.message || err)}`;
      }
    } else {
      boundaries[i].method = boundaries[i].method === "seed" ? "deterministic-range" : boundaries[i].method;
      boundaries[i].reason = boundaries[i].reason || "end bounded by next section start";
    }
    if (i > 0 && boundaries[i].start <= boundaries[i - 1].end) boundaries[i].start = Math.min(paragraphs.length - 1, boundaries[i - 1].end + 1);
    if (boundaries[i].end < boundaries[i].start) boundaries[i].end = boundaries[i].start;
    log(`[agenda-wise] refine atindex num ${i + 1} toindex num ${boundaries.length} item ${boundaries[i].item} since ${boundaries[i].start} until ${boundaries[i].end} method ${boundaries[i].method}`);
  }

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    boundaries[i].end = Math.min(boundaries[i].end, Math.max(boundaries[i].start, boundaries[i + 1].start - 1));
  }
  boundaries[boundaries.length - 1].end = Math.max(boundaries[boundaries.length - 1].start, boundaries[boundaries.length - 1].end);

  const chips = [];
  const allowSyntheticPreAgenda = /^(1|true|yes)$/iu.test(String(
    process.env.AGENDA_WISE_INCLUDE_SYNTHETIC_PREAGENDA || "0"
  ));
  if (allowSyntheticPreAgenda && boundaries.length && boundaries[0].start > 0) {
    const pre = paragraphs.slice(0, boundaries[0].start);
    if (pre.length) {
      chips.push({
        startParagraph: 0,
        untilParagraph: boundaries[0].start - 1,
        text: `[Agenda Start] 0 PRE-AGENDA STATEMENTS | method inferred\n\n${pre.join("\n\n")}`.trim(),
        sections: ["0 PRE-AGENDA STATEMENTS"],
        wordCount: words(pre.join(" ")),
      });
    }
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const sec = sections[i];
    const start = boundaries[i].start;
    const boundedEnd = boundaries[i].end + 1;
    const seg = paragraphs.slice(start, boundedEnd);
    if (!seg.length) continue;
    const labels = [`${sec.item} ${sec.title}`];
    const method = boundaries[i].method;
    const header = `[Agenda Start] ${labels[0]} | method ${method}`;
    const text = `${header}\n\n${seg.join("\n\n")}`.trim();
    chips.push({
      startParagraph: start,
      untilParagraph: boundedEnd - 1,
      text,
      sections: labels,
      wordCount: words(text),
    });
  }
  if (!chips.length) throw new Error("no agenda-wise chips produced");

  const maxChipWords = chips.reduce((m, c) => Math.max(m, Number(c.wordCount || 0)), 0);
  const oversizedChips = chips.filter((c) => Number(c.wordCount || 0) >= 3000).length;
  const coverage = sections.length ? (chosen.length / sections.length) : 0;
  const llmRefineErrors = boundaries.filter((b) => /^llm-refine-error:/iu.test(String(b?.reason || ""))).length;
  const llmRangeCount = boundaries.filter((b) => String(b?.method || "") === "llm-range").length;
  if (maxChipWords >= 20000) {
    throw new Error(`agenda-wise quality defective: oversized chip words=${maxChipWords}`);
  }
  if (useLlmRange && llmRangeCount === 0 && (coverage < 0.6 || oversizedChips > 0)) {
    throw new Error(
      `agenda-wise quality defective: llm_range_missing coverage=${coverage.toFixed(2)} oversized_chips=${oversizedChips}`
    );
  }
  if (useLlmRange && llmRefineErrors > 0 && (coverage < 0.45 || oversizedChips > 0)) {
    throw new Error(
      `agenda-wise quality defective: llm_refine_errors=${llmRefineErrors} coverage=${coverage.toFixed(2)} oversized_chips=${oversizedChips}`
    );
  }

  fs.writeFileSync(outputPath, toSeriesText(chips), "utf8");
  fs.writeFileSync(matchPath, JSON.stringify({
    transcript: plainPath,
    agenda: agendaPath,
    sections_total: sections.length,
    matches_found: chosen.length,
    methods: {
      programmatic: chosen.filter((m) => m.method === "programmatic").length,
      llm_fallback: chosen.filter((m) => m.method === "llm-fallback").length,
    },
    matches: chosen,
    chips: chips.map((c, i) => ({
      index: i + 1,
      start_paragraph: c.startParagraph,
      until_paragraph: c.untilParagraph,
      words: c.wordCount,
      sections: c.sections,
    })),
    section_starts: sections.map((s, i) => ({
      item: s.item,
      title: s.title,
      start_paragraph: starts[i],
    })),
    boundaries,
  }, null, 2), "utf8");

  log(`[agenda-wise] sections matched: ${chosen.length}/${sections.length}`);
  log(`[agenda-wise] wise chips: ${chips.length}`);
  log(`[agenda-wise] matches: ${matchPath}`);
}
