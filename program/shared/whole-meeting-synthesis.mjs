import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTextModel } from '../../../../../program/runtime/gpu/text-model.mjs';
import { requestManagedOllamaChat } from '../../../../../program/runtime/gpu/managed-ollama.mjs';

// LEGACY MODULE: JSON-era whole-meeting synthesis retained for compatibility.
// Canonical pipeline uses program/library/reporter_shared/whole-meeting-synthesis.mjs.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOUSE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLLAMA_URL = process.env.OLLAMA_HOST?.replace(/\/$/u, '')
  ? `${process.env.OLLAMA_HOST.replace(/\/$/u, '')}/api/chat`
  : 'http://mriczo:11434/api/chat';
const MODEL = resolveTextModel(
  process.env.MEETING_SUMMARY_MODEL
    || process.env.SUMMARY_MODEL
    || process.env.OWEN_MEETING_SUMMARY_MODEL
    || process.env.OWEN_SUMMARY_MODEL,
  { runtimePath: path.join(HOUSE_ROOT, 'conduct', 'runtime.pya') },
);
const MAX_ATTEMPTS = 3;
const PASS_THRESHOLD = 0.8;
const SUMMARY_TIME_MODE = String(process.env.AGENDA_SUMMARY_TIME_MODE || 'standard').trim().toLowerCase();

function usage() {
  return [
    'Usage: node command/summarize_whole_meeting_from_agenda_summary.mjs <transcript_dir> [prefix] [focus]',
    'Example: node command/summarize_whole_meeting_from_agenda_summary.mjs artifacts/.../transcript auto "the newsworthy juicy bits and whats unusual"'
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

function pickAgendaSummaryJson(transcriptDir, prefix = 'auto') {
  const wantsAuto = !prefix || /^auto$/iu.test(String(prefix));
  if (!wantsAuto) {
    const preferred = path.join(transcriptDir, `${prefix}.agenda-summary.json`);
    const canonicalPya = path.join(transcriptDir, `${prefix}.agenda-summary.pya`);
    if (!fs.existsSync(preferred) && fs.existsSync(canonicalPya)) {
      throw new Error("legacy whole-meeting-synthesis requires .agenda-summary.json; canonical .pya summaries use reporter_shared/whole-meeting-synthesis");
    }
    if (fs.existsSync(preferred)) return { summaryPath: preferred, resolvedPrefix: prefix };
  }

  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.endsWith('.agenda-summary.json'));
  if (!candidates.length) throw new Error(`no *.agenda-summary.json found in ${transcriptDir}`);

  const ranked = candidates.map((name) => {
    const full = path.join(transcriptDir, name);
    const st = fs.statSync(full);
    const pfx = name.replace(/\.agenda-summary\.json$/u, '');
    const cp = readNormalizeCheckpoint(transcriptDir, pfx);
    let score = 0;
    if (cp.complete) score += 400;
    if (cp.exists && !cp.complete) score -= 300;
    if (/normalized/iu.test(pfx)) score += 150;
    if (/test|tmp|partial/iu.test(pfx)) score -= 250;
    if (pfx === 'meeting-qwen-auto') score += 10;
    return { full, pfx, score, mtimeMs: Number(st.mtimeMs || 0), size: Number(st.size || 0), name };
  }).sort((a, b) =>
    b.score - a.score ||
    b.mtimeMs - a.mtimeMs ||
    b.size - a.size ||
    a.name.localeCompare(b.name)
  );

  const chosen = ranked[0];
  return { summaryPath: chosen.full, resolvedPrefix: chosen.pfx };
}

function abridgeUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) return String(text ?? '');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  if (end <= 0) end = maxBytes;
  return buf.slice(0, end).toString('utf8');
}

async function ask(messages, { numPredict = 520 } = {}) {
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

function sectionContent(mdText, heading) {
  const lines = String(mdText || '').split(/\r?\n/u);
  const target = String(heading || '').trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/u);
    if (!m) continue;
    if (m[1].trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function hasCompleteRequiredSections(mdText) {
  const text = String(mdText || '');
  const hasH1 = /^#\s+Whole Meeting Summary\b/mu.test(text);
  const hasTop = /^##\s+Top Newsworthy Developments\b/mu.test(text);
  const hasWhy = /^##\s+Why It Matters\b/mu.test(text);
  const hasWatch = /^##\s+Watch Next\b/mu.test(text);
  if (!hasH1 || !hasTop || !hasWhy || !hasWatch) return false;
  const top = sectionContent(text, 'Top Newsworthy Developments');
  const why = sectionContent(text, 'Why It Matters');
  const watch = sectionContent(text, 'Watch Next');
  return top.length >= 300 && why.length >= 80 && watch.length >= 80;
}

function buildSummaryPrompt({ sourceJson, focus, feedback, meetingDateIso, meetingDateLong, bodyLabel, jurisdiction, referenceContext }) {
  const focusLine = String(focus || '').trim() || 'the newsworthy, juicy, and unusual bits';
  return [
    'Create a compelling whole-meeting local-news summary from this agenda-section summary JSON.',
    '',
    `Meeting date (authoritative): ${meetingDateLong || meetingDateIso || 'unknown'}`,
    `Governing body (authoritative): ${bodyLabel || 'unknown'}`,
    `Jurisdiction (authoritative): ${jurisdiction || 'unknown'}`,
    '',
    `Focus: ${focusLine}`,
    '',
    'Return markdown with exactly these sections and titles:',
    '1) # Whole Meeting Summary',
    '2) ## Top Newsworthy Developments',
    '3) ## Why It Matters',
    '4) ## Watch Next',
    '',
    'Rules:',
    '- Use only facts present in SOURCE_JSON.',
    '- Prioritize the most consequential, unusual, contentious, costly, or politically sensitive developments.',
    '- Prefer concrete details (numbers, thresholds, votes, dates) when available.',
    '- Keep total length under 900 words.',
    '- Do not invent votes, participants, or outcomes.',
    '- If REFERENCE_CONTEXT includes a canonical spelling for an organization/person/place and SOURCE_JSON has an obvious transcription misspelling, use the canonical spelling.',
    `- Use the exact meeting date "${meetingDateLong || meetingDateIso || 'unknown'}" whenever you mention the meeting date.`,
    `- Refer to the governing body as "${bodyLabel || 'unknown'}", not a different body.`,
    `- Refer to the jurisdiction as "${jurisdiction || 'unknown'}".`,
    '- In the opening sentence, explicitly name the correct governing body and jurisdiction.',
    '- Do not substitute a different date.',
    '- Keep each section concise and readable.',
    '- Write in a clear, punchy local-news tone (not dry boilerplate).',
    '- In Top Newsworthy Developments, use bold subheads and specific facts.',
    '- If a claim is only a proposal/presentation and not adopted, say so explicitly.',
    '- Never assign titled identities (Mayor/Deputy Mayor/Councillor) to a person unless that title is supported by roster and source context.',
    ...(SUMMARY_TIME_MODE === 'upcoming'
      ? [
        '- This is an upcoming agenda preview before the meeting occurs.',
        '- Write primarily in present/future tense.',
        '- Do not imply agenda items have already been debated, voted, approved, or presented unless SOURCE_JSON explicitly states a historical completed event.',
      ]
      : []),
    '',
    'RETRY_FEEDBACK:',
    feedback || '',
    '',
    'REFERENCE_CONTEXT:',
    referenceContext || '(none)',
    '',
    'SOURCE_JSON:',
    sourceJson
  ].join('\n');
}

function buildScorePrompt({ sourceJson, summaryMd, bodyLabel, jurisdiction, meetingDateIso, meetingDateLong }) {
  return [
    'Score WHOLE_MEETING_SUMMARY for semantic faithfulness to SOURCE_JSON.',
    '',
    'Scoring:',
    '- 1.0 = fully faithful and well-prioritized',
    '- 0.8 = mostly faithful with minor drift',
    '- 0.5 = mixed',
    '- 0.0 = unusable',
    '',
    'Rules:',
    '- Penalize invented claims, wrong attributions, or nonexistent outcomes.',
    `- Penalize incorrect governing body label; required body is "${bodyLabel || 'unknown'}".`,
    `- Penalize incorrect jurisdiction label; required jurisdiction is "${jurisdiction || 'unknown'}".`,
    `- Penalize incorrect meeting date; required date is "${meetingDateLong || meetingDateIso || 'unknown'}".`,
    '- Penalize titled identity errors (wrong role/title attached to a person).',
    ...(SUMMARY_TIME_MODE === 'upcoming'
      ? [
        '- This is an upcoming agenda preview.',
        '- Penalize past-tense framing that implies this meeting already happened (for example "debated", "approved", "presented"), unless SOURCE_JSON clearly indicates a distinct historical completed event.',
      ]
      : []),
    '- Penalize omission of obviously major/high-impact events in SOURCE_JSON.',
    '- Penalize vague wording where concrete figures exist in SOURCE_JSON.',
    '',
    'Output:',
    '- First line: one short feedback sentence.',
    '- Final line: exactly PASS, FAIL, or a numeric score from 0 to 1.',
    '',
    'SOURCE_JSON:',
    sourceJson,
    '',
    'WHOLE_MEETING_SUMMARY:',
    summaryMd
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

function pickRosterFile(transcriptDir) {
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
    path.join(path.dirname(meetingDir), '2022-2026-council.txt'),
    path.join(path.dirname(meetingDir), 'roster.txt'),
    path.join(meetingDir, '2022-2026-council.txt'),
    path.join(meetingDir, 'roster.txt')
  ];
  for (const filePath of candidates) {
    if (filePath && fs.existsSync(filePath)) return filePath;
  }
  return '';
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
      if (!directRole.includes(expected)) out.push(`${title} ${rawName} (role mismatch: roster=${directRole})`);
      if (!sourceMentionsName(source, rawName)) out.push(`${title} ${rawName} (not explicit in source)`);
      continue;
    }
    const last = fullKey.split(' ').filter(Boolean).at(-1) || '';
    const candidates = rosterRoles.byLast.get(last) || [];
    const roleMatches = candidates.filter((c) => c.role.includes(expected));
    if (roleMatches.length !== 1) {
      out.push(`${title} ${rawName} (unknown titled person)`);
      continue;
    }
    if (!sourceMentionsName(source, rawName)) out.push(`${title} ${rawName} (not explicit in source)`);
  }
  return out;
}

function extractHeadings(mdText) {
  return String(mdText || '').split(/\r?\n/u)
    .filter((line) => /^#{1,2}\s+/u.test(line))
    .map((line) => line.trim());
}

function deriveMeetingDateFromTranscriptDir(transcriptDir) {
  const meetingDir = path.basename(path.dirname(String(transcriptDir || '')));
  const m = meetingDir.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!m) return { iso: '', long: '' };
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  const long = dt.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
  return { iso, long };
}

function deriveMeetingContext(transcriptDir) {
  const meetingDir = path.dirname(String(transcriptDir || ''));
  const meetingJsonPath = path.join(meetingDir, 'meeting.json');
  let bodyLabel = '';
  let jurisdiction = '';
  const normalizeBodyLabel = (label) => {
    let out = String(label || '').trim().replace(/\s+/gu, ' ');
    out = out.replace(/^((?:Council Meeting|Committee|Board))\s*-\s*\1\s*-\s*/iu, '$1 - ');
    out = out.replace(/^Committee\s*-\s*Committee of\s+/iu, 'Committee of ');
    out = out.replace(/^Board\s*-\s*Board of\s+/iu, 'Board of ');
    out = out.replace(/\s*-\s*/gu, ' - ');
    return out.trim();
  };
  const envJurisdiction = String(process.env.MEETING_JURISDICTION || process.env.JURISDICTION || '').trim();
  if (envJurisdiction) jurisdiction = envJurisdiction;
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
    else if (/council/iu.test(dirName)) bodyLabel = 'Council Meeting - Regular';
    else bodyLabel = 'Council';
  }
  bodyLabel = normalizeBodyLabel(bodyLabel);
  return { bodyLabel, jurisdiction };
}

async function summarizeWholeMeeting({ summaryJsonObj, focus, meetingDateIso, meetingDateLong, bodyLabel, jurisdiction, rosterText }) {
  const sourceJson = abridgeUtf8(JSON.stringify(summaryJsonObj, null, 2), 24000);
  const rosterRoles = parseRosterRoles(rosterText);
  let feedback = '';
  let bestText = '';
  let bestScore = -1;
  let bestReview = '';

  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    const draft = await ask([
      { role: 'system', content: 'You are a strict local-news meeting brief writer.' },
      { role: 'user', content: buildSummaryPrompt({ sourceJson, focus, feedback, meetingDateIso, meetingDateLong, bodyLabel, jurisdiction, referenceContext: rosterText }) }
    ], { numPredict: 1200 });

    const review = await ask([
      { role: 'system', content: 'You are a strict semantic verifier for civic summaries.' },
      { role: 'user', content: buildScorePrompt({ sourceJson, summaryMd: draft, bodyLabel, jurisdiction, meetingDateIso, meetingDateLong }) }
    ], { numPredict: 220 });

    const completenessPenalty = hasCompleteRequiredSections(draft) ? 0 : 0.4;
    const titledViolations = findTitledIdentityViolations(draft, sourceJson, rosterRoles);
    const titledPenalty = titledViolations.length ? 1 : 0;
    const score = Math.max(0, parseScore(review) - completenessPenalty - titledPenalty);
    if (bestText === '' || score > bestScore) {
      bestText = draft;
      bestScore = score;
      bestReview = review;
    }
    feedback = titledViolations.length
      ? `${review}\n\nTITLE_IDENTITY_GUARD:\nInvalid titled attributions: ${titledViolations.join('; ')}\nFinal line: 0.0`
      : review;
    if (score >= PASS_THRESHOLD) break;
  }

  return {
    markdown: bestText,
    score: Number(bestScore.toFixed(3)),
    verifier_feedback: bestReview
  };
}

export async function summarizeWholeMeetingArtifacts({
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

  const { summaryPath, resolvedPrefix } = pickAgendaSummaryJson(transcriptDir, prefixArg);
  const outMd = path.join(transcriptDir, `${resolvedPrefix}.meeting-summary.md`);
  const outJson = path.join(transcriptDir, `${resolvedPrefix}.meeting-summary.json`);
  const rosterPath = pickRosterFile(transcriptDir);
  const rosterText = rosterPath ? abridgeUtf8(fs.readFileSync(rosterPath, 'utf8'), 5000) : '';
  const meetingDate = deriveMeetingDateFromTranscriptDir(transcriptDir);
  const meetingContext = deriveMeetingContext(transcriptDir);

  log(`[meeting-summary] source agenda summary: ${summaryPath}`);
  log(`[meeting-summary] output md: ${outMd}`);

  const sourceObj = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const out = await summarizeWholeMeeting({
    summaryJsonObj: sourceObj,
    focus: focusText,
    meetingDateIso: meetingDate.iso,
    meetingDateLong: meetingDate.long,
    bodyLabel: meetingContext.bodyLabel,
    jurisdiction: meetingContext.jurisdiction,
    rosterText
  });

  fs.writeFileSync(outMd, `${String(out.markdown || '').trim()}\n`, 'utf8');
  fs.writeFileSync(outJson, JSON.stringify({
    source_agenda_summary: summaryPath,
    focus: focusText,
    score: out.score,
    headings: extractHeadings(out.markdown),
    verifier_feedback: out.verifier_feedback,
    markdown: out.markdown
  }, null, 2), 'utf8');

  log(`[meeting-summary] score: ${out.score.toFixed(3)}`);
  log(`[meeting-summary] wrote: ${outMd}`);
  log(`[meeting-summary] wrote: ${outJson}`);
  return { outMd, outJson, score: out.score };
}
