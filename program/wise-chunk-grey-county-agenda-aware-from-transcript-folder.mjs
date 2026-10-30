#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLlmAgendaSegmentation } from "../../../../program/library/reporter_shared/agenda-llm-segmentation.mjs";
import { pickRichestAgendaPathFromMeetingDir } from "../../../../program/library/agenda_preview_shared.mjs";
import { resolveTextModel } from "../../../../program/runtime/gpu/text-model.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE = path.resolve(PROGRAM_DIR, "..");
const OLLAMA_URL = process.env.OLLAMA_HOST?.replace(/\/$/u, "")
  ? `${process.env.OLLAMA_HOST.replace(/\/$/u, "")}/api/chat`
  : "http://mriczo:11434/api/chat";
const LLM_MODEL = resolveTextModel("", { runtimePath: path.join(HOUSE, "conduct", "runtime.pya") });

function usage() {
  return [
    "Usage: node program/wise-chunk-grey-county-agenda-aware-from-transcript-folder.mjs <transcript_dir> [prefix]",
    "Example: node ... artifacts/grey-county/meetings/<meeting>/transcript auto",
  ].join("\n");
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`transcript directory not found: ${dirPath}`);
}

function resolveReporterPath(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(HOUSE, inputPath);
}

function readNormalizeCheckpoint(transcriptDir, prefix) {
  const metaPath = path.join(transcriptDir, `${prefix}.normalize.metadata.json`);
  if (!fs.existsSync(metaPath)) return { exists: false, complete: false };
  try {
    const obj = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const total = Number(obj?.chunks_total);
    const done = Number(obj?.chunks_processed);
    const complete = Number.isFinite(total) && total > 0 && done === total;
    return { exists: true, complete };
  } catch {
    return { exists: true, complete: false };
  }
}

function pickPlainTranscript(transcriptDir, prefix = "auto") {
  const wantsAuto = !prefix || /^auto$/iu.test(String(prefix));
  if (!wantsAuto) {
    const preferred = path.join(transcriptDir, `${prefix}.plain.txt`);
    if (fs.existsSync(preferred)) return { plainPath: preferred, resolvedPrefix: prefix };
  }

  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.endsWith(".plain.txt"));

  if (!candidates.length) throw new Error(`no *.plain.txt transcript found in ${transcriptDir}`);

  const ranked = candidates.map((name) => {
    const full = path.join(transcriptDir, name);
    const st = fs.statSync(full);
    const pfx = name.replace(/\.plain\.txt$/u, "");
    const cp = readNormalizeCheckpoint(transcriptDir, pfx);
    let score = 0;
    if (cp.complete) score += 400;
    if (cp.exists && !cp.complete) score -= 300;
    if (/normalized/iu.test(pfx)) score += 150;
    if (/test|tmp|partial/iu.test(pfx)) score -= 250;
    if (pfx === "meeting-qwen-auto") score += 10;
    return { name, full, pfx, score, mtimeMs: Number(st.mtimeMs || 0), size: Number(st.size || 0) };
  }).sort((a, b) =>
    b.score - a.score ||
    b.mtimeMs - a.mtimeMs ||
    b.size - a.size ||
    a.name.localeCompare(b.name)
  );

  const chosen = ranked[0];
  return { plainPath: chosen.full, resolvedPrefix: chosen.pfx };
}

function pickAgendaMarkdown(meetingDir) {
  const convertedDir = path.join(meetingDir, "converted");
  const preferred = [
    path.join(convertedDir, "agenda-99-from-pdf.pruned.md"),
    path.join(convertedDir, "agenda-pruned.md"),
    path.join(convertedDir, "agenda-01.md"),
  ];
  for (const candidate of preferred) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return pickRichestAgendaPathFromMeetingDir(meetingDir);
}

function parseItemLine(line) {
  const raw = String(line || "").trim();
  const m = raw.match(/^(\d{1,2})(?:\.([a-z]))?\.?$/iu);
  if (!m) return null;
  const mainNum = Number(m[1]);
  if (!Number.isFinite(mainNum) || mainNum < 1 || mainNum > 30) return null;
  const sub = String(m[2] || "").toLowerCase();
  const hasDot = raw.includes(".");
  if (!sub && !raw.endsWith(".") && !hasDot) return null;
  return sub ? `${mainNum}.${sub}` : `${mainNum}.`;
}

function parseInlineItemHeading(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})(?:\.([a-z]))?\.?\s+(.+)$/iu);
  if (!m) return null;
  const mainNum = Number(m[1]);
  const sub = String(m[2] || "").toLowerCase();
  const heading = String(m[3] || "").trim();
  if (!Number.isFinite(mainNum) || !heading) return null;
  // Wrapped lines like "97 and Proposed ..." are continuation text, not new agenda nodes.
  if (/^[a-z]/u.test(heading)) return null;
  const item = sub ? `${mainNum}.${sub}` : `${mainNum}.`;
  return { item, heading };
}

function itemMainNumber(item = "") {
  const m = String(item || "").trim().match(/^(\d{1,2})/u);
  return m ? Number(m[1]) : NaN;
}

function isResolutionStyleHeading(line = "") {
  const t = String(line || "").trim().toLowerCase();
  return (
    /^the actions of the council of the corporation/iu.test(t) ||
    /^the warden and proper officers of the corporation/iu.test(t) ||
    /^being a by-law to confirm/iu.test(t) ||
    /^by-law to confirm/iu.test(t)
  );
}

function buildTranscriptSkeletonAgendaText(raw = "") {
  const srcLines = String(raw || "").replace(/\f/gu, "\n").split(/\r?\n/u);
  const out = [];
  let inSection = false;
  let injectedCallToOrder = false;
  let seenAdjournment = false;
  let maxMainSeen = 0;

  const push = (line) => {
    const clean = String(line || "").replace(/\s+/gu, " ").trim();
    if (!clean) return;
    const prev = out[out.length - 1];
    if (prev && prev.toLowerCase() === clean.toLowerCase()) return;
    out.push(clean);
  };

  for (const rawLine of srcLines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (/^page\s+\d+\s+of\s+\d+/iu.test(line)) continue;
    if (/^\d+$/u.test(line)) continue;
    if (/^\d{1,2}\.[a-z]\.\d+$/iu.test(line)) continue;
    if (line === "•") continue;

    const parsedItem = parseItemLine(line);
    if (parsedItem) {
      const main = itemMainNumber(parsedItem);
      const restartAfterProgress = Number.isFinite(main) && maxMainSeen >= 8 && main <= 2;
      if (seenAdjournment || restartAfterProgress) continue;
      if (Number.isFinite(main) && main > maxMainSeen) maxMainSeen = main;
      push(parsedItem);
      inSection = true;
      continue;
    }

    const inline = parseInlineItemHeading(line);
    if (inline) {
      const main = itemMainNumber(inline.item);
      const restartAfterProgress = Number.isFinite(main) && maxMainSeen >= 8 && main <= 2;
      if (seenAdjournment || restartAfterProgress || isResolutionStyleHeading(inline.heading)) continue;
      if (Number.isFinite(main) && main > maxMainSeen) maxMainSeen = main;
      push(inline.item);
      push(inline.heading);
      if (/adjournment/iu.test(inline.heading)) seenAdjournment = true;
      inSection = true;
      continue;
    }

    // Some agendas omit "1." and start with CALL TO ORDER heading.
    if (!injectedCallToOrder && /^call to order$/iu.test(line)) {
      push("1.");
      push("CALL TO ORDER");
      injectedCallToOrder = true;
      inSection = false;
      continue;
    }

    if (!inSection) continue;
    if (isResolutionStyleHeading(line)) continue;
    if (/adjournment/iu.test(line)) seenAdjournment = true;
    push(line);
  }

  return out.join("\n").trim();
}

function countSkeletonItems(skeletonText = "") {
  const lines = String(skeletonText || "").split(/\r?\n/u);
  let count = 0;
  for (const line of lines) {
    if (/^\d{1,2}(?:\.[a-z])?\.?$/iu.test(String(line || "").trim())) count += 1;
  }
  return count;
}

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || "auto";
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const transcriptDir = resolveReporterPath(transcriptDirArg);
  ensureDir(transcriptDir);

  const meetingDir = path.dirname(transcriptDir);
  const { plainPath, resolvedPrefix } = pickPlainTranscript(transcriptDir, prefixArg);
  const agendaPath = pickAgendaMarkdown(meetingDir);
  if (!agendaPath) throw new Error(`agenda markdown not found under: ${meetingDir}/converted`);
  const agendaRaw = fs.readFileSync(agendaPath, "utf8");
  const skeletonText = buildTranscriptSkeletonAgendaText(agendaRaw);
  const transcriptAgendaPath = path.join(transcriptDir, `${resolvedPrefix}.agenda-skeleton.md`);
  fs.writeFileSync(
    transcriptAgendaPath,
    `${skeletonText || agendaRaw}\n`,
    "utf8",
  );

  const outputPath = path.join(transcriptDir, `${resolvedPrefix}.agenda-wise.series.pya`);
  const rowsJsonPath = path.join(transcriptDir, `${resolvedPrefix}.sentences.speaker.sentences.json`);
  const matchPath = path.join(transcriptDir, `${resolvedPrefix}.agenda.matches.pya`);
  const grossPyaPath = path.join(transcriptDir, `${resolvedPrefix}.agenda.gross-chunks.pya`);
  const sectionGroundingPath = path.join(transcriptDir, `${resolvedPrefix}.agenda.section-grounding.pya`);

  process.stdout.write(`[agenda-wise] transcript: ${plainPath}\n`);
  process.stdout.write(`[agenda-wise] agenda source: ${agendaPath}\n`);
  process.stdout.write(`[agenda-wise] agenda skeleton: ${transcriptAgendaPath}\n`);
  process.stdout.write(`[agenda-wise] output: ${outputPath}\n`);

  if (!fs.existsSync(rowsJsonPath)) {
    throw new Error(`speaker rows json not found: ${rowsJsonPath}`);
  }

  const canonicalIndexPath = path.join(meetingDir, "converted", "subreports.index.json");
  const meetingRecord = JSON.parse(fs.readFileSync(path.join(meetingDir, "meeting.json"), "utf8"));
  const meetingLabel = String(meetingRecord?.payload?.meeting_name || meetingRecord?.payload?.meeting_type || "").trim();
  process.stdout.write(`[agenda-boundaries] canonical agenda: ${fs.existsSync(canonicalIndexPath) ? canonicalIndexPath : agendaPath}\n`);
  process.stdout.write(`[agenda-boundaries] model: ${LLM_MODEL}\n`);
  process.stdout.write(`[agenda-boundaries] meeting scope: ${meetingLabel || "(unavailable)"}\n`);
  await runLlmAgendaSegmentation({
    rowsJsonPath,
    canonicalIndexPath,
    fallbackAgendaPath: agendaPath,
    candidatesPyaPath: grossPyaPath,
    matchesPyaPath: matchPath,
    wiseSeriesPyaPath: outputPath,
    sectionGroundingPyaPath: sectionGroundingPath,
    llmModel: LLM_MODEL,
    ollamaUrl: OLLAMA_URL,
    meetingLabel,
    log: (line) => process.stdout.write(`${line}\n`),
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
