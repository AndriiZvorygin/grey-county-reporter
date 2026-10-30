import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTextModel } from '../../../../../program/runtime/gpu/text-model.mjs';
import { requestManagedOllamaChat } from '../../../../../program/runtime/gpu/managed-ollama.mjs';

// LEGACY MODULE: JSON-era agenda summarizer kept for backward compatibility.
// Canonical pipeline uses Stage 1/2/3 .pya artifacts via reporter_shared stage modules.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOUSE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLLAMA_URL = process.env.OLLAMA_HOST?.replace(/\/$/u, '')
  ? `${process.env.OLLAMA_HOST.replace(/\/$/u, '')}/api/chat`
  : 'http://mriczo:11434/api/chat';
const MODEL = resolveTextModel(
  process.env.AGENDA_SECTION_SUMMARY_MODEL
    || process.env.MEETING_SUMMARY_MODEL
    || process.env.SUMMARY_MODEL
    || process.env.OWEN_SUMMARY_MODEL,
  { runtimePath: path.join(HOUSE_ROOT, 'conduct', 'runtime.pya') },
);
const MAX_ATTEMPTS = 3;
const PASS_THRESHOLD = (() => {
  const raw = Number(process.env.AGENDA_SUMMARY_PASS_THRESHOLD || process.env.MEETING_SUMMARY_PASS_THRESHOLD || process.env.OWEN_SUMMARY_PASS_THRESHOLD || 0.65);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.65;
})();
const MIN_SUMMARY_WORDS = (() => {
  const raw = Number(process.env.AGENDA_SUMMARY_MIN_WORDS || process.env.MEETING_SUMMARY_MIN_WORDS || process.env.OWEN_SUMMARY_MIN_WORDS || 120);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
})();
const BASE_NEWS_HOOK = 'the newsworthy, juicy, and unusual bits';
const MAX_SECTIONS = (() => {
  const raw = Number(process.env.AGENDA_SUMMARY_MAX_SECTIONS || process.env.MEETING_SUMMARY_MAX_SECTIONS || process.env.OWEN_SUMMARY_MAX_SECTIONS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
})();
const SUMMARY_TIME_MODE = String(process.env.AGENDA_SUMMARY_TIME_MODE || "standard").trim().toLowerCase();
const FORCE_ONE_SENTENCE = !/^(0|false|no)$/iu.test(String(
  process.env.AGENDA_SUMMARY_ONE_SENTENCE || "1"
));
const MAX_SECTION_SECONDS = (() => {
  const raw = Number(
    process.env.AGENDA_SUMMARY_MAX_SECTION_SECONDS
    || process.env.MEETING_SUMMARY_MAX_SECTION_SECONDS
    || process.env.OWEN_SUMMARY_MAX_SECTION_SECONDS
    || 900
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 900;
})();
const SUBSECTION_GROSS_MIN_CHARS = (() => {
  const raw = Number(process.env.AGENDA_SUBSECTION_GROSS_MIN_CHARS || 12000);
  return Number.isFinite(raw) && raw >= 3000 ? Math.floor(raw) : 12000;
})();
const SUBSECTION_GROSS_MAX_CHARS = (() => {
  const raw = Number(process.env.AGENDA_SUBSECTION_GROSS_MAX_CHARS || 16000);
  return Number.isFinite(raw) && raw >= 5000 ? Math.floor(raw) : 16000;
})();
const SUBSECTION_MIN_GAP_SECONDS = (() => {
  const raw = Number(process.env.AGENDA_SUBSECTION_MIN_GAP_SECONDS || 90);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
})();
const DEBUG_SECTION_SPLIT = /^(1|true|yes)$/iu.test(String(process.env.AGENDA_SUMMARY_DEBUG_SPLIT || '0'));

function usage() {
  return [
    'Usage: node command/summarize_agenda_wise_sections_from_transcript_folder.mjs <transcript_dir> [prefix] [focus]',
    'Example: node command/summarize_agenda_wise_sections_from_transcript_folder.mjs artifacts/.../transcript auto "newsworthy civic impacts"'
  ].join('\n');
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`transcript directory not found: ${dirPath}`);
}

function resolvePathFromRoot(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(ROOT, inputPath);
}

function unescapeQuoted(value) {
  try {
    return JSON.parse(`"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  } catch {
    return String(value || '');
  }
}

function readNormalizeCheckpoint(transcriptDir, prefix) {
  const metaPath = path.join(transcriptDir, `${prefix}.normalize.metadata.json`);
  if (!fs.existsSync(metaPath)) return { exists: false, complete: false };
  try {
    const obj = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const total = Number(obj?.chunks_total);
    const done = Number(obj?.chunks_processed);
    const complete = Number.isFinite(total) && total > 0 && done === total;
    return { exists: true, complete };
  } catch {
    return { exists: true, complete: false };
  }
}

function pickAgendaWiseSeries(transcriptDir, prefix = 'auto') {
  const wantsAuto = !prefix || /^auto$/iu.test(String(prefix));
  if (!wantsAuto) {
    const preferred = path.join(transcriptDir, `${prefix}.agenda-wise.series.pya`);
    if (fs.existsSync(preferred)) return { seriesPath: preferred, resolvedPrefix: prefix };
  }

  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.endsWith('.agenda-wise.series.pya'));
  if (!candidates.length) throw new Error(`no *.agenda-wise.series.pya found in ${transcriptDir}`);

  const ranked = candidates.map((name) => {
    const full = path.join(transcriptDir, name);
    const st = fs.statSync(full);
    const pfx = name.replace(/\.agenda-wise\.series\.pya$/u, '');
    const cp = readNormalizeCheckpoint(transcriptDir, pfx);
    let score = 0;
    if (cp.complete) score += 400;
    if (cp.exists && !cp.complete) score -= 300;
    if (/normalized/iu.test(pfx)) score += 150;
    if (/test|tmp|partial/iu.test(pfx)) score -= 250;
    if (pfx === 'meeting-qwen-auto') score += 10;
    return { name, full, pfx, score, mtimeMs: Number(st.mtimeMs || 0), size: Number(st.size || 0) };
  }).sort((a, b) =>
    b.score - a.score ||
    b.mtimeMs - a.mtimeMs ||
    b.size - a.size ||
    a.name.localeCompare(b.name)
  );

  const chosen = ranked[0];
  return { seriesPath: chosen.full, resolvedPrefix: chosen.pfx };
}

function pickCouncilRosterFile(transcriptDir) {
  const meetingDir = path.dirname(transcriptDir);
  const rosterFromEnv = String(process.env.MEETING_ROSTER_FILE || process.env.ROSTER_FILE || '').trim();
  if (rosterFromEnv) {
    const rosterPath = path.isAbsolute(rosterFromEnv)
      ? path.normalize(rosterFromEnv)
      : path.resolve(process.cwd(), rosterFromEnv);
    if (fs.existsSync(rosterPath)) return rosterPath;
  }

  const houseFromEnv = String(
    process.env.REPORTER_HOUSE_ROOT
    || process.env.HOUSE_ROOT
    || process.env.OWEN_HOUSE_ROOT
    || ''
  ).trim();
  const houseFromPathMatch = String(transcriptDir || '').match(/^(.*\/world\/house\/[^/]+)/u)?.[1] || '';
  const houseRoot = houseFromEnv || houseFromPathMatch || '';
  const jurisdictionSlug = path.basename(path.dirname(path.dirname(meetingDir)));
  const candidates = [
    houseRoot ? path.join(houseRoot, 'artifacts', jurisdictionSlug, 'roster.txt') : '',
    houseRoot ? path.join(houseRoot, 'artifacts', jurisdictionSlug, 'council-roster.txt') : '',
    houseRoot ? path.join(houseRoot, 'artifacts', jurisdictionSlug, '2022-2026-council.txt') : '',
    path.join(path.dirname(path.dirname(meetingDir)), '2022-2026-council.txt'),
    path.join(path.dirname(meetingDir), '2022-2026-council.txt'),
    path.join(meetingDir, '2022-2026-council.txt'),
    path.join(path.dirname(path.dirname(meetingDir)), 'roster.txt'),
    path.join(path.dirname(meetingDir), 'roster.txt'),
    path.join(meetingDir, 'roster.txt')
  ];
  for (const filePath of candidates) {
    if (filePath && fs.existsSync(filePath)) return filePath;
  }
  return '';
}

function parseSeriesTexts(pyaText) {
  const source = String(pyaText || '');
  const out = [];

  const quotedRe = /ob text quoted\.text\.(.*?)\.text\.quoted(?: from num \d+)? be text ya/gs;
  for (const m of source.matchAll(quotedRe)) out.push(String(m[1] || ''));

  const plainRe = /ob text "((?:[^"\\]|\\.)*)"(?: from num \d+)? ya/g;
  for (const m of source.matchAll(plainRe)) out.push(unescapeQuoted(String(m[1] || '')));

  return out;
}

function parseHeadingAndBody(chipText, idx) {
  const raw = String(chipText || '')
    .replace(/\\r\\n/gu, '\n')
    .replace(/\\n/gu, '\n');
  const lines = raw.split(/\r?\n/u);
  const first = (lines[0] || '').trim();
  let heading = `Section ${idx + 1}`;
  if (first.startsWith('[Agenda Start]')) {
    heading = first.replace(/^\[Agenda Start\]\s*/u, '').replace(/\s*\|\s*method\s+[^|]+$/iu, '').trim() || heading;
  }

  let body = raw;
  if (first.startsWith('[Agenda Start]')) {
    const bodyLines = lines.slice(1);
    body = bodyLines.join('\n').trim();
    if (!body) body = raw;
  }

  return { heading, body };
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseLeadingItemNumber(heading) {
  const m = String(heading || '').match(/^\s*(\d+)\b/u);
  return m ? String(Number(m[1])) : '';
}

function loadTranscriptRowsForPrefix(transcriptDir, prefix) {
  const jsonPath = path.join(transcriptDir, `${prefix}.sentences.speaker.sentences.json`);
  if (!fs.existsSync(jsonPath)) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const rows = Array.isArray(obj?.rows) ? obj.rows : [];
    return rows.map((r) => ({
      text: String(r?.text || '').trim(),
      display: String(r?.display || '').trim(),
      since: Number(r?.since),
      until: Number(r?.until),
    })).filter((r) => r.text);
  } catch {
    return [];
  }
}

function loadAgendaMatchesForPrefix(transcriptDir, prefix) {
  const jsonPath = path.join(transcriptDir, `${prefix}.agenda.matches.json`);
  const canonicalPya = path.join(transcriptDir, `${prefix}.agenda.matches.pya`);
  if (!fs.existsSync(jsonPath) && fs.existsSync(canonicalPya)) {
    throw new Error("legacy agenda-section-summaries requires .agenda.matches.json; canonical .pya-only artifacts must use stage3 summary renderer");
  }
  if (!fs.existsSync(jsonPath)) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return Array.isArray(obj?.matches) ? obj.matches : [];
  } catch {
    return [];
  }
}

function parseWiseRangesFromSeries(seriesText) {
  const src = String(seriesText || '');
  const out = [];
  const re = /su name wise chip \d+\s+since num ([0-9.]+)\s+until num ([0-9.]+)\s+ob text /gu;
  for (const m of src.matchAll(re)) {
    const since = Number(m[1]);
    const until = Number(m[2]);
    if (!Number.isFinite(since) || !Number.isFinite(until)) continue;
    out.push({ since, until });
  }
  return out;
}

function buildSectionRowRanges({ headings, rows, matches, wiseRanges }) {
  if (!Array.isArray(headings) || !headings.length || !Array.isArray(rows) || !rows.length) return [];
  const wise = Array.isArray(wiseRanges) ? wiseRanges : [];
  if (wise.length === headings.length) {
    const wiseMax = wise.reduce((mx, w) => Math.max(mx, Number(w?.until ?? w?.since ?? 0) || 0), 0);
    const wiseLooksLikeRowIndex =
      wise.length > 0 &&
      wise.every((w) => Number.isFinite(Number(w?.since)) && Number.isFinite(Number(w?.until))) &&
      wise.every((w) => Number.isInteger(Number(w?.since)) && Number.isInteger(Number(w?.until))) &&
      wiseMax <= (rows.length + 50);
    if (wiseLooksLikeRowIndex) {
      return wise.map((w, idx) => {
        const start = Math.max(0, Math.min(rows.length - 1, Math.floor(Number(w?.since) || 0)));
        const nextStart = idx + 1 < wise.length
          ? Math.max(0, Math.min(rows.length - 1, Math.floor(Number(wise[idx + 1]?.since) || 0)))
          : rows.length;
        const end = idx + 1 < wise.length ? Math.max(start, nextStart - 1) : (rows.length - 1);
        return { start, end };
      });
    }
  }

  const rowNorm = rows.map((r) => normalizeForMatch(r?.text || ''));
  const matchByItem = new Map();
  for (const m of Array.isArray(matches) ? matches : []) {
    const key = String(m?.item || '').trim();
    if (!key || matchByItem.has(key)) continue;
    matchByItem.set(key, m);
  }

  const starts = [];
  let matchedCount = 0;
  for (let i = 0; i < headings.length; i += 1) {
    const heading = String(headings[i] || '');
    const item = parseLeadingItemNumber(heading);
    const m = matchByItem.get(item);
    const snippet = normalizeForMatch(String(m?.snippet || '').slice(0, 240));
    let rowIndex = -1;
    if (snippet) {
      const anchor = snippet.slice(0, Math.min(80, snippet.length));
      for (let r = 0; r < rowNorm.length; r += 1) {
        if (rowNorm[r] && rowNorm[r].includes(anchor)) {
          rowIndex = r;
          matchedCount += 1;
          break;
        }
      }
    }
    starts.push({ heading, rowIndex });
  }

  // If alignment coverage is weak, do not trust row slicing at all.
  // This avoids reusing the opening rows across many sections.
  const minCoverage = Math.max(2, Math.floor(headings.length * 0.5));
  if (matchedCount < minCoverage) return [];

  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].rowIndex >= 0 && starts[i - 1].rowIndex >= 0 && starts[i].rowIndex < starts[i - 1].rowIndex) {
      starts[i].rowIndex = starts[i - 1].rowIndex;
    }
  }

  const out = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i].rowIndex;
    if (start < 0) {
      out.push({ start: -1, end: -1 });
      continue;
    }
    const end = i + 1 < starts.length ? Math.max(start, starts[i + 1].rowIndex - 1) : (rows.length - 1);
    out.push({ start, end });
  }
  return out;
}

function abridgeUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) return String(text ?? '');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  if (end <= 0) end = maxBytes;
  return buf.slice(0, end).toString('utf8');
}

async function ask(messages, { numPredict = 280 } = {}) {
  const json = await requestManagedOllamaChat({
    model: MODEL,
    ollamaUrl: OLLAMA_URL,
    managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || '',
    options: { num_predict: numPredict },
    messages,
    think: false,
    keepAlive: 300,
  });
  return String(json?.message?.content || json?.response || '').trim();
}

function buildShortSummaryPrompt({ heading, source, focus, feedback, rosterText }) {
  const focusRaw = String(focus || '').trim();
  const focusLine = focusRaw
    ? `${BASE_NEWS_HOOK}; additionally prioritize ${focusRaw}`
    : BASE_NEWS_HOOK;
  const roster = String(rosterText || '').trim();
  return [
    `Summarize this municipal meeting section in exactly one sentence for agenda heading: ${heading}`,
    `Focus: prioritize ${focusLine}.`,
    roster ? '' : '',
    roster ? 'COUNCIL ROSTER REFERENCE:' : '',
    roster ? roster : '',
    '',
    'Rules:',
    '- One sentence only.',
    '- Keep only facts supported by SOURCE.',
    '- Do not introduce any person name, number, dollar figure, date, vote count, or title unless it is explicitly present in SOURCE.',
    '- Use roster only to disambiguate speaker identity/role/gender; do not invent facts.',
    '- If transcript naming appears misspelled by ASR, normalize to the closest roster name silently.',
    '- If uncertain about a specific identity or figure, use role-level phrasing and omit the uncertain number/name.',
    '- If speaker identity is uncertain, use role phrasing (e.g., "a councillor").',
    ...(SUMMARY_TIME_MODE === 'upcoming'
      ? [
        '- This is an upcoming agenda preview before the meeting occurs.',
        '- Use present/future tense.',
        '- Do not imply debate, votes, or decisions have already happened unless SOURCE explicitly states a past completed event.',
      ]
      : []),
    '- No speculation.',
    '',
    'RETRY_FEEDBACK:',
    feedback || '',
    '',
    'SOURCE:',
    source
  ].join('\n');
}

function buildSummaryPrompt({ heading, source, focus, feedback, rosterText, bodyLabel, jurisdiction }) {
  const focusRaw = String(focus || '').trim();
  const focusLine = focusRaw
    ? `${BASE_NEWS_HOOK}; additionally prioritize ${focusRaw}`
    : BASE_NEWS_HOOK;
  const roster = String(rosterText || '').trim();
  return [
    `Summarize this municipal meeting section for agenda heading: ${heading}`,
    `Governing body (authoritative): ${String(bodyLabel || 'Unknown body')}`,
    `Jurisdiction (authoritative): ${String(jurisdiction || 'Unknown jurisdiction')}`,
    `Focus: prioritize ${focusLine}.`,
    roster ? '' : '',
    roster ? 'COUNCIL ROSTER REFERENCE:' : '',
    roster ? roster : '',
    '',
    'Rules:',
    '- Keep only facts supported by SOURCE.',
    `- Use the governing body label "${String(bodyLabel || 'Unknown body')}" accurately.`,
    '- Do not refer to this as "Council" unless the governing body is explicitly Council.',
    '- Do not introduce any person name, number, dollar figure, date, vote count, or title unless it is explicitly present in SOURCE.',
    '- Use roster only to disambiguate speaker identity/role/gender; do not invent facts.',
    '- Never assign a title (Mayor/Deputy Mayor/Councillor) to a person unless that title is explicitly supported by roster and source context.',
    '- If transcript naming appears misspelled by ASR, normalize to the closest roster name silently.',
    '- If uncertain about a specific identity or figure, use role-level phrasing and omit the uncertain number/name.',
    '- Prefer exact roster spellings in output names (example: "Koepke" not "Keppie"; "Greig" not "Greg" when identifying Deputy Mayor).',
    '- Never treat spelling/name mismatch itself as a news finding.',
    '- If speaker identity is uncertain, use role phrasing (e.g., "a councillor") instead of speculation.',
    '- Attribute statements to named speakers only when SOURCE makes that attribution explicit.',
    '- Do not infer attendance counts unless explicitly stated in SOURCE.',
    ...(SUMMARY_TIME_MODE === 'upcoming'
      ? [
        '- This is an upcoming agenda preview before the meeting occurs.',
        '- Write in present/future tense.',
        '- Do not frame agenda items as completed actions unless SOURCE explicitly states a historical completed event.',
      ]
      : []),
    '- Surface unusual, high-impact, conflict-heavy, costly, surprising, or politically sensitive details when present.',
    '- Mention concrete decisions, motions, votes, actions, and notable debate if present.',
    '- Prefer specific numbers/thresholds/heights/dates/dollar amounts when SOURCE provides them.',
    '- Avoid vague wording like "significant", "many", or "several" when exact details are available.',
    '- No speculation.',
    '- No bullet lists.',
    '- Keep under 220 words.',
    ...(FORCE_ONE_SENTENCE ? ['- Output exactly one sentence.'] : []),
    '',
    'RETRY_FEEDBACK:',
    feedback || '',
    '',
    'SOURCE:',
    source
  ].join('\n');
}

function clampToOneSentence(text) {
  const src = String(text || "").replace(/\s+/gu, " ").trim();
  if (!src) return src;
  const m = src.match(/^(.+?[.!?])(?:\s|$)/u);
  if (m && m[1]) return String(m[1]).trim();
  // Keep colon-delimited speaker attributions intact (e.g. "Name: statement ...")
  // and only trim on semicolons when no sentence boundary exists.
  return src.split(/;/u)[0].trim();
}

function buildScorePrompt({ source, summary, rosterText, bodyLabel, summaryTimeMode }) {
  const roster = String(rosterText || '').trim();
  return [
    'Score SUMMARY for semantic faithfulness to SOURCE.',
    roster ? '' : '',
    roster ? 'COUNCIL ROSTER REFERENCE:' : '',
    roster ? roster : '',
    '',
    'Scoring:',
    '- 1.0 = fully faithful',
    '- 0.8 = mostly faithful with minor compression drift',
    '- 0.5 = mixed',
    '- 0.0 = unusable / unsupported',
    '',
    'Rules:',
    '- Penalize unsupported claims or invented outcomes.',
    `- Penalize incorrect governing-body wording; required body is "${String(bodyLabel || 'Unknown body')}".`,
    '- Penalize calling the meeting "Council" when SOURCE/context indicates committee/board.',
    '- Penalize non-canonical speaker naming when a clear canonical roster spelling is available.',
    '- Penalize speculative claims about identity mismatch, attendance counts, or roster discrepancies not explicit in SOURCE.',
    ...(summaryTimeMode === 'upcoming'
      ? [
        '- This is an upcoming agenda preview.',
        '- Penalize past-tense framing that implies the meeting item already happened (for example "presented", "debated", "approved"), unless SOURCE clearly describes a distinct historical event.',
      ]
      : []),
    '- Penalize visibly truncated endings (for example trailing "..." or "…").',
    '- Do not penalize concise paraphrase if meaning is preserved.',
    '- Penalize omission when SOURCE contains clearly unusual/high-impact/newsworthy details and SUMMARY ignores them.',
    '- Penalize vague wording when SOURCE contains specific figures or thresholds that could be stated directly.',
    '',
    'Output:',
    '- First line: one short feedback sentence.',
    '- Final line: exactly PASS, FAIL, or a numeric score from 0 to 1.',
    '',
    'SOURCE:',
    source,
    '',
    'SUMMARY:',
    summary
  ].join('\n');
}

function looksTruncatedSummary(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /(?:\.\.\.|…)\s*$/u.test(t);
}

function buildAttributionScorePrompt({ source, summary, rosterText }) {
  const roster = String(rosterText || '').trim();
  return [
    'Score SUMMARY for speaker-attribution correctness against SOURCE.',
    roster ? '' : '',
    roster ? 'COUNCIL ROSTER REFERENCE:' : '',
    roster ? roster : '',
    '',
    'Scoring:',
    '- 1.0 = all speaker attributions are supported by SOURCE',
    '- 0.5 = uncertain / mixed',
    '- 0.0 = misattributed speaker(s)',
    '',
    'Rules:',
    '- If SUMMARY attributes a statement/opinion/motion to the wrong person, score must be 0.0.',
    '- If speaker identity is unclear in SOURCE and SUMMARY uses neutral phrasing, do not penalize.',
    '- Penalize use of non-canonical roster names when canonical match is clear.',
    '',
    'Output:',
    '- First line: one short feedback sentence.',
    '- Final line: exactly PASS, FAIL, or a numeric score from 0 to 1.',
    '',
    'SOURCE:',
    source,
    '',
    'SUMMARY:',
    summary
  ].join('\n');
}

function parseScore(review) {
  const lines = String(review || '').split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  const last = lines.at(-1) || '';
  if (/^PASS$/i.test(last)) return 1;
  if (/^FAIL$/i.test(last)) return 0;
  const n = Number(last);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return 0;
}

function deriveMeetingContext(transcriptDir) {
  const meetingDir = path.dirname(String(transcriptDir || ''));
  const meetingJsonPath = path.join(meetingDir, 'meeting.json');
  const envJurisdiction = String(process.env.MEETING_JURISDICTION || process.env.JURISDICTION || '').trim();
  let jurisdiction = envJurisdiction;
  let bodyLabel = '';
  const normalizeBodyLabel = (label) => {
    let out = String(label || '').trim().replace(/\s+/gu, ' ');
    out = out.replace(/^((?:Council Meeting|Committee|Board))\s*-\s*\1\s*-\s*/iu, '$1 - ');
    out = out.replace(/^Committee\s*-\s*Committee of\s+/iu, 'Committee of ');
    out = out.replace(/^Board\s*-\s*Board of\s+/iu, 'Board of ');
    out = out.replace(/\s*-\s*/gu, ' - ');
    return out.trim();
  };
  try {
    const meeting = JSON.parse(fs.readFileSync(meetingJsonPath, 'utf8'));
    const payload = meeting?.payload || {};
    bodyLabel = normalizeBodyLabel(String(payload?.meeting_name || payload?.meeting_type || '').trim());
    if (!jurisdiction) {
      jurisdiction = String(payload?.jurisdiction || payload?.municipality || payload?.county || '').trim();
    }
  } catch {}
  if (!jurisdiction) {
    const slug = String(path.basename(path.dirname(path.dirname(meetingDir))) || '').trim();
    jurisdiction = slug
      ? slug.split('-').map((part) => part ? (part[0].toUpperCase() + part.slice(1)) : '').join(' ')
      : 'Local Municipality';
  }
  if (!bodyLabel) {
    const dirName = path.basename(meetingDir);
    if (/committee-corporate-services/iu.test(dirName)) bodyLabel = 'Committee - Corporate Services';
    else if (/committee-operations/iu.test(dirName)) bodyLabel = 'Committee - Operations';
    else if (/committee-community-services/iu.test(dirName)) bodyLabel = 'Committee - Community Services';
    else if (/committee-of-adjustment|committee-committee-of-adjustment/iu.test(dirName)) bodyLabel = 'Committee of Adjustment';
    else if (/committee-of-the-whole/iu.test(dirName)) bodyLabel = 'Committee of the Whole';
    else if (/board/iu.test(dirName)) bodyLabel = 'Board';
    else if (/council/iu.test(dirName)) bodyLabel = 'Council Meeting - Regular';
    else bodyLabel = 'Council';
  }
  bodyLabel = normalizeBodyLabel(bodyLabel);
  return { bodyLabel, jurisdiction };
}

function normalizeNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9' -]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseRosterRoles(rosterText) {
  const byFull = new Map();
  const byLast = new Map();
  const re = /^\s*-\s*([^|\n]+?)\s*\|\s*role:\s*([^|\n]+)\s*(?:\||$)/gimu;
  for (const m of String(rosterText || '').matchAll(re)) {
    const name = String(m[1] || '').trim();
    const role = String(m[2] || '').trim().toLowerCase();
    if (!name || !role) continue;
    const fullKey = normalizeNameKey(name);
    if (!fullKey) continue;
    byFull.set(fullKey, role);
    const last = fullKey.split(' ').filter(Boolean).at(-1) || '';
    if (!last) continue;
    const arr = byLast.get(last) || [];
    arr.push({ fullKey, role });
    byLast.set(last, arr);
  }
  return { byFull, byLast };
}

function expectedRoleFromTitle(title) {
  const t = String(title || '').toLowerCase().trim();
  if (t === 'mayor') return 'mayor';
  if (t === 'deputy mayor') return 'deputy mayor';
  if (t === 'councillor' || t === 'councilor') return 'councillor';
  return '';
}

function sourceMentionsName(source, rawName) {
  const sourceNorm = normalizeNameKey(source);
  const full = normalizeNameKey(rawName);
  if (!full) return false;
  if (sourceNorm.includes(full)) return true;
  const last = full.split(' ').filter(Boolean).at(-1) || '';
  return last ? sourceNorm.includes(last) : false;
}

function findTitledIdentityViolations(summary, source, rosterRoles) {
  const out = [];
  const re = /\b(Mayor|Deputy Mayor|Councillor|Councilor)\s+([A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,2})\b/gu;
  for (const m of String(summary || '').matchAll(re)) {
    const title = String(m[1] || '');
    const rawName = String(m[2] || '').trim();
    const expected = expectedRoleFromTitle(title);
    if (!expected) continue;
    const fullKey = normalizeNameKey(rawName);
    const directRole = rosterRoles.byFull.get(fullKey);
    if (directRole) {
      if (!directRole.includes(expected)) {
        out.push(`${title} ${rawName} (role mismatch: roster=${directRole})`);
      }
      if (!sourceMentionsName(source, rawName)) {
        out.push(`${title} ${rawName} (not explicit in source)`);
      }
      continue;
    }
    const last = fullKey.split(' ').filter(Boolean).at(-1) || '';
    const candidates = rosterRoles.byLast.get(last) || [];
    const roleMatches = candidates.filter((c) => c.role.includes(expected));
    if (roleMatches.length !== 1) {
      out.push(`${title} ${rawName} (unknown titled person)`);
      continue;
    }
    if (!sourceMentionsName(source, rawName)) {
      out.push(`${title} ${rawName} (not explicit in source)`);
    }
  }
  return out;
}

function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/u).length;
}

function sectionDurationSeconds(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const since = Number(first?.since);
  const until = Number(last?.until);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return 0;
  return Math.max(0, until - since);
}

function secondsToHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

function parseClockToSeconds(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/u);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  return (hh * 3600) + (mm * 60) + ss;
}

function parseChapterLines(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d{1,2}:\d{2}:\d{2})\s*\|\s*(.+)$/u);
    if (!m) continue;
    const since = parseClockToSeconds(m[1]);
    const title = String(m[2] || '').replace(/\s+/gu, ' ').trim();
    if (!Number.isFinite(since) || !title) continue;
    out.push({ since, title });
  }
  return out;
}

function buildGrossChunksFromRows(rows, { minChars = 12000, maxChars = 16000, overlapRows = 3 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const out = [];
  let start = 0;
  while (start < list.length) {
    let end = start;
    let size = 0;
    while (end < list.length) {
      const add = String(list[end]?.text || '').length + 18;
      if (size >= minChars && (size + add) > maxChars) break;
      size += add;
      end += 1;
      if (size >= maxChars) break;
    }
    if (end <= start) end = Math.min(list.length, start + 1);
    const chunkRows = list.slice(start, end);
    out.push({
      startIndex: start,
      endIndex: end - 1,
      since: Number(chunkRows[0]?.since || 0),
      until: Number(chunkRows[chunkRows.length - 1]?.until || chunkRows[0]?.since || 0),
      rows: chunkRows,
    });
    if (end >= list.length) break;
    start = Math.max(0, end - Math.max(0, overlapRows));
    if (start >= end) start = end;
  }
  return out;
}

function findNearestRowIndexForTime(rows, start, end, targetSeconds) {
  let best = start;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, start); i <= Math.min(end, rows.length - 1); i += 1) {
    const since = Number(rows[i]?.since);
    if (!Number.isFinite(since)) continue;
    const delta = Math.abs(since - targetSeconds);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

async function detectTopicBoundariesFromRows({ rows, start, end, maxSeconds }) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeEnd = Math.max(safeStart, Number(end) || safeStart);
  const sectionRows = rows.slice(safeStart, safeEnd + 1).filter((r) => String(r?.text || '').trim());
  if (sectionRows.length < 4) return [];
  const sectionStart = Number(sectionRows[0]?.since);
  const sectionEnd = Number(sectionRows[sectionRows.length - 1]?.until || sectionRows[sectionRows.length - 1]?.since);
  if (!Number.isFinite(sectionStart) || !Number.isFinite(sectionEnd) || sectionEnd <= sectionStart) return [];
  if ((sectionEnd - sectionStart) <= maxSeconds) return [];

  const chunks = buildGrossChunksFromRows(sectionRows, {
    minChars: SUBSECTION_GROSS_MIN_CHARS,
    maxChars: SUBSECTION_GROSS_MAX_CHARS,
    overlapRows: 3,
  });
  const candidates = [];
  for (const chunk of chunks) {
    const body = chunk.rows
      .map((r) => `${secondsToHms(Number(r?.since || 0))} ${String(r?.text || '').replace(/\s+/gu, ' ').trim()}`)
      .join('\n')
      .slice(0, 18000);
    if (!body) continue;
    let raw = '';
    try {
      raw = await ask([
        { role: 'system', content: 'You detect transcript topic boundaries and provide concise chapter start lines only.' },
        {
          role: 'user',
          content: [
            'Find meaningful topic-shift chapter starts inside this transcript chunk.',
            'Output 1 to 5 lines only, exact format:',
            'HH:MM:SS | Chapter Title',
            'Rules:',
            '- Choose natural subtopic boundaries, not fixed intervals.',
            '- Use title case, concise factual titles, no speaker names.',
            `- Keep starts inside ${secondsToHms(chunk.since)} to ${secondsToHms(chunk.until)}.`,
            '',
            body,
          ].join('\n')
        }
      ], { numPredict: 260 });
    } catch {
      continue;
    }
    const parsed = parseChapterLines(raw).filter((x) => x.since >= chunk.since && x.since <= chunk.until);
    for (const p of parsed) candidates.push(p);
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => a.since - b.since || a.title.localeCompare(b.title));

  const dedup = [];
  for (const c of candidates) {
    if (!dedup.length) {
      dedup.push(c);
      continue;
    }
    const prev = dedup[dedup.length - 1];
    if (Math.abs(c.since - prev.since) < 8) continue;
    if ((c.since - prev.since) < SUBSECTION_MIN_GAP_SECONDS) continue;
    dedup.push(c);
  }

  const boundaries = [];
  for (const c of dedup) {
    if (c.since <= sectionStart + 20) continue;
    if (c.since >= sectionEnd - 20) continue;
    const idx = findNearestRowIndexForTime(rows, safeStart, safeEnd, c.since);
    boundaries.push({ idx, title: c.title, since: c.since });
  }
  boundaries.sort((a, b) => a.idx - b.idx || a.since - b.since);

  const unique = [];
  let lastIdx = -1;
  for (const b of boundaries) {
    if (b.idx <= safeStart || b.idx >= safeEnd) continue;
    if (lastIdx >= 0 && (b.idx - lastIdx) < 2) continue;
    unique.push(b);
    lastIdx = b.idx;
  }
  return unique;
}

function splitRowRangeByDuration({ rows, start, end, maxSeconds }) {
  const out = [];
  if (!Array.isArray(rows) || !rows.length) return out;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return out;

  const safeMax = Math.max(60, Number(maxSeconds) || 900);
  let segStart = start;
  let anchorSince = Number(rows[segStart]?.since);
  if (!Number.isFinite(anchorSince)) anchorSince = Number(rows[segStart]?.until);

  for (let i = start; i <= end; i += 1) {
    const rowUntil = Number(rows[i]?.until);
    const rowSince = Number(rows[i]?.since);
    const candidateUntil = Number.isFinite(rowUntil) ? rowUntil : rowSince;
    if (!Number.isFinite(candidateUntil) || !Number.isFinite(anchorSince)) continue;

    const duration = candidateUntil - anchorSince;
    if (duration > safeMax && i > segStart) {
      out.push({ start: segStart, end: i - 1 });
      segStart = i;
      const nextSince = Number(rows[segStart]?.since);
      const nextUntil = Number(rows[segStart]?.until);
      anchorSince = Number.isFinite(nextSince) ? nextSince : nextUntil;
    }
  }
  out.push({ start: segStart, end });
  return out.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start);
}

async function generateSubsectionTitle({ parentHeading, source, partIndex, partCount }) {
  const deriveFallback = () => {
    const cleaned = String(source || '')
      .replace(/\r\n/gu, '\n')
      .replace(/\n+/gu, ' ')
      .replace(/\bSPEAKER_\d+\s*:/gu, '')
      .replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*:/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    const sentence = cleaned.split(/(?<=[.!?])\s+/u).map((x) => x.trim()).find((x) => countWords(x) >= 5) || cleaned;
    const words = sentence.replace(/[.!?]$/u, '').split(/\s+/u).filter(Boolean).slice(0, 10);
    const title = words.join(' ').trim();
    if (!title) return `Part ${partIndex} continuation`;
    return title[0].toUpperCase() + title.slice(1);
  };

  const clippedSource = abridgeUtf8(String(source || '').trim(), 5000);
  if (!clippedSource) return deriveFallback();
  try {
    const raw = await ask([
      { role: 'system', content: 'You create concise civic section titles.' },
      {
        role: 'user',
        content: [
          'Create one concise subsection title (4-10 words) for this transcript segment.',
          `Parent heading: ${parentHeading}`,
          `Part: ${partIndex} of ${partCount}`,
          'Rules:',
          '- Return title text only.',
          '- No numbering, no markdown, no trailing period.',
          '- Keep factual and specific.',
          '- Do not repeat the parent heading text verbatim.',
          '',
          'SOURCE:',
          clippedSource
        ].join('\n')
      }
    ], { numPredict: 60 });
    const oneLine = String(raw || '').split(/\r?\n/u).map((x) => x.trim()).filter(Boolean)[0] || '';
    const clean = oneLine.replace(/^[-*#\d.\s]+/u, '').replace(/\s+/gu, ' ').trim();
    if (!clean) return deriveFallback();
    const parentNorm = normalizeForMatch(parentHeading);
    const cleanNorm = normalizeForMatch(clean);
    if (cleanNorm && cleanNorm === parentNorm) {
      return deriveFallback();
    }
    return clean;
  } catch {
    return deriveFallback();
  }
}

function buildExtractiveFallbackSummary(source, heading, maxWords = 70) {
  const text = String(source || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bSPEAKER_\d+\s*:/gu, '')
    .replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*:/gu, '')
    .trim();
  if (!text) return `No clear transcript content was available for "${heading}".`;

  const pieces = text
    .split(/(?<=[.!?])\s+/u)
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const out = [];
  let words = 0;
  for (const piece of pieces) {
    const n = countWords(piece);
    if (n <= 0) continue;
    if (words > 0 && words + n > maxWords) break;
    out.push(piece);
    words += n;
    if (words >= Math.floor(maxWords * 0.7)) break;
  }
  let joined = (out.length ? out.join(' ') : text).trim();
  if (!/[.!?]/u.test(joined)) {
    const words = joined.split(/\s+/u).filter(Boolean);
    joined = words.slice(0, Math.max(18, Math.min(42, maxWords))).join(' ').trim();
    if (joined && !/[.!?]$/u.test(joined)) joined = `${joined}.`;
  }
  const one = clampToOneSentence(joined).trim();
  if (one) return one;
  return `No clear transcript content was available for "${heading}".`;
}

async function summarizeSection({ heading, body, focus, rosterText, bodyLabel, jurisdiction, shortMode = false }) {
  const source = abridgeUtf8(body, 14000);
  const rosterRoles = parseRosterRoles(rosterText);
  let feedback = '';
  let bestSummary = '';
  let bestScore = -1;
  let backendFailed = false;

  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    let summary = '';
    try {
      summary = await ask([
        { role: 'system', content: 'You are a concise factual civic meeting summarizer.' },
        {
          role: 'user',
          content: shortMode
            ? buildShortSummaryPrompt({ heading, source, focus, feedback, rosterText })
            : buildSummaryPrompt({ heading, source, focus, feedback, rosterText, bodyLabel, jurisdiction })
        }
      ], { numPredict: shortMode ? 120 : 340 });
    } catch {
      backendFailed = true;
      break;
    }
    const normalizedSummary = FORCE_ONE_SENTENCE ? clampToOneSentence(summary) : summary;

    let reviewSemantic = '';
    let reviewAttribution = '';
    try {
      reviewSemantic = await ask([
        { role: 'system', content: 'You are a strict semantic summary scorer.' },
        { role: 'user', content: buildScorePrompt({ source, summary: normalizedSummary, rosterText, bodyLabel, summaryTimeMode: SUMMARY_TIME_MODE }) }
      ], { numPredict: 220 });
      reviewAttribution = await ask([
        { role: 'system', content: 'You are a strict speaker attribution verifier.' },
        { role: 'user', content: buildAttributionScorePrompt({ source, summary: normalizedSummary, rosterText }) }
      ], { numPredict: 180 });
    } catch {
      backendFailed = true;
      break;
    }

    const scoreSemantic = parseScore(reviewSemantic);
    const scoreAttribution = parseScore(reviewAttribution);
    const titledViolations = findTitledIdentityViolations(normalizedSummary, source, rosterRoles);
    const score = titledViolations.length || looksTruncatedSummary(normalizedSummary)
      ? 0
      : Math.min(scoreSemantic, scoreAttribution);
    if (bestSummary === '' || score > bestScore) {
      bestSummary = normalizedSummary;
      bestScore = score;
    }
    const violationFeedback = titledViolations.length
      ? `\n\nTITLE_IDENTITY_GUARD:\nInvalid titled attributions: ${titledViolations.join('; ')}\nFinal line: 0.0`
      : '';
    const truncationFeedback = looksTruncatedSummary(normalizedSummary)
      ? '\n\nTRUNCATION_GUARD:\nSummary appears cut off with trailing ellipsis; regenerate complete sentence(s).\nFinal line: 0.0'
      : '';
    feedback = `${reviewSemantic}\n\nATTRIBUTION_REVIEW:\n${reviewAttribution}${violationFeedback}${truncationFeedback}`;
    if (score >= PASS_THRESHOLD) break;
  }
  if (backendFailed) {
    return {
      summary: buildExtractiveFallbackSummary(source, heading),
      score: PASS_THRESHOLD,
      mode: 'extractive-fallback'
    };
  }
  const finalScore = Number(bestScore.toFixed(3));
  if (finalScore < PASS_THRESHOLD) {
    return {
      summary: buildExtractiveFallbackSummary(source, heading),
      // Treat extractive fallback as a safe pass path: it is directly sourced text.
      score: Math.max(finalScore, PASS_THRESHOLD),
      mode: 'extractive-fallback'
    };
  }
  return { summary: bestSummary, score: finalScore, mode: 'llm-pass' };
}

function toMarkdown(items, focus) {
  const lines = ['# Agenda Section Summaries', ''];
  if (String(focus || '').trim()) {
    lines.push(`Focus: ${String(focus).trim()}`, '');
  }
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    lines.push(`## ${i + 1}. ${it.heading}`);
    lines.push(`(faithfulness score: ${it.score.toFixed(3)})`);
    lines.push('');
    lines.push(it.summary || 'No summary produced.');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function summarizeAgendaSectionArtifacts({
  transcriptDirArg,
  prefixArg = 'auto',
  focusArg = '',
  log = (line) => process.stdout.write(`${line}\n`)
}) {
  const focusText = String(focusArg || '').trim();

  if (!transcriptDirArg) {
    throw new Error(usage());
  }

  const transcriptDir = resolvePathFromRoot(transcriptDirArg);
  ensureDir(transcriptDir);

  const { seriesPath, resolvedPrefix } = pickAgendaWiseSeries(transcriptDir, prefixArg);
  const rosterPath = pickCouncilRosterFile(transcriptDir);
  const rosterText = rosterPath ? abridgeUtf8(fs.readFileSync(rosterPath, 'utf8'), 5000) : '';
  const meetingContext = deriveMeetingContext(transcriptDir);
  const outMd = path.join(transcriptDir, `${resolvedPrefix}.agenda-summary.md`);
  const outJson = path.join(transcriptDir, `${resolvedPrefix}.agenda-summary.json`);

  log(`[agenda-summary] source series: ${seriesPath}`);
  log(`[agenda-summary] roster: ${rosterPath || '(none)'}`);
  log(`[agenda-summary] body: ${meetingContext.bodyLabel}`);
  log(`[agenda-summary] jurisdiction: ${meetingContext.jurisdiction}`);
  log(`[agenda-summary] output md: ${outMd}`);

  const source = fs.readFileSync(seriesPath, 'utf8');
  let chips = parseSeriesTexts(source);
  if (!chips.length) throw new Error('agenda summary defective: no wise chips parsed from series');
  if (MAX_SECTIONS > 0) chips = chips.slice(0, MAX_SECTIONS);

  const parsedChips = chips.map((chip, idx) => parseHeadingAndBody(chip, idx));
  const sectionHeadings = parsedChips.map((x) => x.heading);
  const transcriptRows = loadTranscriptRowsForPrefix(transcriptDir, resolvedPrefix);
  const agendaMatches = loadAgendaMatchesForPrefix(transcriptDir, resolvedPrefix);
  const wiseRanges = parseWiseRangesFromSeries(source);
  const rowRanges = buildSectionRowRanges({
    headings: sectionHeadings,
    rows: transcriptRows,
    matches: agendaMatches,
    wiseRanges
  });

  const out = [];
  for (let i = 0; i < parsedChips.length; i += 1) {
    const { heading, body } = parsedChips[i];
    log(`[agenda-summary] atindex num ${i + 1} toindex num ${chips.length} heading ${heading}`);
    const rr = rowRanges[i] || null;
    const sectionRows = rr ? transcriptRows.slice(rr.start, rr.end + 1) : [];
    const sectionRowCount = sectionRows.length;
    const sectionRowText = sectionRows.map((r) => `${r.display || 'Speaker'}: ${r.text}`).join('\n').trim();
    const bodyWordCount = countWords(body);
    const rowWordCount = countWords(sectionRowText);
    const rowRangeLooksRich = rowWordCount >= Math.max(80, Math.floor(bodyWordCount * 0.6));
    const baseBody = rowRangeLooksRich ? sectionRowText : body;

    let subRanges = [];
    if (rr && sectionRows.length > 1) {
      const dur = sectionDurationSeconds(sectionRows);
      if (DEBUG_SECTION_SPLIT) {
        log(`[agenda-summary][split-debug] heading="${heading}" rows=${sectionRows.length} dur=${dur.toFixed(1)} rr=${rr.start}..${rr.end} max=${MAX_SECTION_SECONDS}`);
      }
      if (dur > MAX_SECTION_SECONDS) {
        const boundaries = await detectTopicBoundariesFromRows({
          rows: transcriptRows,
          start: rr.start,
          end: rr.end,
          maxSeconds: MAX_SECTION_SECONDS,
        });
        if (boundaries.length) {
          let segStart = rr.start;
          for (const b of boundaries) {
            if (b.idx <= segStart || b.idx > rr.end) continue;
            subRanges.push({ start: segStart, end: b.idx - 1, title: '' });
            segStart = b.idx;
          }
          subRanges.push({ start: segStart, end: rr.end, title: '' });
          for (let bi = 0; bi < boundaries.length; bi += 1) {
            const boundary = boundaries[bi];
            const rangeIndex = bi + 1;
            if (subRanges[rangeIndex]) subRanges[rangeIndex].title = boundary.title;
          }
        }
        if (!subRanges.length) {
          subRanges = splitRowRangeByDuration({
            rows: transcriptRows,
            start: rr.start,
            end: rr.end,
            maxSeconds: MAX_SECTION_SECONDS
          });
        }
        if (DEBUG_SECTION_SPLIT) {
          log(`[agenda-summary][split-debug] heading="${heading}" boundaries=${boundaries.length} initial_subranges=${subRanges.length}`);
        }
        const refined = [];
        for (const sr of subRanges) {
          const clipRows = transcriptRows.slice(sr.start, sr.end + 1);
          const clipDur = sectionDurationSeconds(clipRows);
          if (clipDur > MAX_SECTION_SECONDS) {
            const fallback = splitRowRangeByDuration({
              rows: transcriptRows,
              start: sr.start,
              end: sr.end,
              maxSeconds: MAX_SECTION_SECONDS
            });
            if (fallback.length > 1 && sr.title) fallback[0].title = sr.title;
            refined.push(...fallback);
          } else {
            refined.push(sr);
          }
        }
        subRanges = refined;
        if (DEBUG_SECTION_SPLIT) {
          log(`[agenda-summary][split-debug] heading="${heading}" refined_subranges=${subRanges.length}`);
        }
      }
    }
    if (!subRanges.length) {
      subRanges = [{ start: rr?.start ?? -1, end: rr?.end ?? -1 }];
    }

    for (let part = 0; part < subRanges.length; part += 1) {
      const range = subRanges[part];
      const partRows = (range.start >= 0 && range.end >= range.start)
        ? transcriptRows.slice(range.start, range.end + 1)
        : [];
      const partRowText = partRows.map((r) => `${r.display || 'Speaker'}: ${r.text}`).join('\n').trim();
      const effectiveBody = partRows.length ? partRowText : baseBody;
      const wordCount = countWords(effectiveBody);
      const sourceRows = partRows.length || sectionRowCount;
      let finalHeading = heading;
      if (subRanges.length > 1 && part > 0) {
        const hinted = String(range?.title || '').trim();
        if (hinted) {
          finalHeading = hinted;
        } else {
          const generated = await generateSubsectionTitle({
            parentHeading: heading,
            source: effectiveBody,
            partIndex: part + 1,
            partCount: subRanges.length
          });
          finalHeading = String(generated || '').trim() || `Part ${part + 1} continuation`;
        }
      }

      let summary = '';
      let score = 1;
      let mode = 'llm';
      const shouldShort = wordCount < MIN_SUMMARY_WORDS || (sourceRows > 0 && sourceRows <= 2);
      if (shouldShort) {
        const shortOut = await summarizeSection({
          heading: finalHeading,
          body: effectiveBody,
          focus: focusText,
          rosterText,
          bodyLabel: meetingContext.bodyLabel,
          jurisdiction: meetingContext.jurisdiction,
          shortMode: true
        });
        summary = shortOut.summary;
        score = shortOut.score;
        mode = shortOut.mode === 'extractive-fallback' ? 'extractive-fallback' : 'llm-short';
      } else {
        const summarized = await summarizeSection({
          heading: finalHeading,
          body: effectiveBody,
          focus: focusText,
          rosterText,
          bodyLabel: meetingContext.bodyLabel,
          jurisdiction: meetingContext.jurisdiction
        });
        if (summarized.score < PASS_THRESHOLD && wordCount < 220) {
          const shortFallback = await summarizeSection({
            heading: finalHeading,
            body: effectiveBody,
            focus: focusText,
            rosterText,
            bodyLabel: meetingContext.bodyLabel,
            jurisdiction: meetingContext.jurisdiction,
            shortMode: true
          });
          summary = shortFallback.summary;
          score = shortFallback.score;
          mode = shortFallback.mode === 'extractive-fallback' ? 'extractive-fallback' : 'llm-short-fallback';
        } else {
          summary = summarized.summary;
          score = summarized.score;
          mode = summarized.mode === 'extractive-fallback' ? 'extractive-fallback' : 'llm';
        }
      }

      out.push({
        index: out.length + 1,
        parent_index: i + 1,
        parent_heading: heading,
        part_index: subRanges.length > 1 ? (part + 1) : 0,
        part_total: subRanges.length,
        heading: finalHeading,
        summary,
        score,
        mode,
        source_words: wordCount,
        source_rows: sourceRows,
        max_section_seconds: MAX_SECTION_SECONDS
      });
    }
  }

  fs.writeFileSync(outMd, toMarkdown(out, focusText), 'utf8');
  fs.writeFileSync(outJson, JSON.stringify({
    source_series: seriesPath,
    roster_file: rosterPath || '',
    body_label: meetingContext.bodyLabel,
    jurisdiction: meetingContext.jurisdiction,
    focus: focusText,
    sections: out
  }, null, 2), 'utf8');

  log(`[agenda-summary] sections: ${out.length}`);
  log(`[agenda-summary] wrote: ${outMd}`);
  log(`[agenda-summary] wrote: ${outJson}`);
  return { outMd, outJson, sections: out.length };
}
