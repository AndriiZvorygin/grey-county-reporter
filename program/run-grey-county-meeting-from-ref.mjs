#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyMeetingVideoUrls,
  fetchMeetingRecordById,
  isEscribePlayerUrl,
  resolveMeetingVideoUrls,
} from "./escribe-video-links.mjs";
import { selectLongestOfficialYoutubeRecording } from "./grey-county-youtube-recordings.mjs";
import { DEFAULT_SUMMARY_FOCUS } from "./defaults.mjs";
import { GREY_ADAPTER } from "./writer-adapter-grey-county.mjs";
import { normalizePublishConfig } from "../../../../program/publisher-interface.mjs";
import { readPyaTextValues } from "../../../../command/pya_lookup.mjs";
import {
  pickRichestAgendaMarkdownPathFromConvertedDir,
  pickRichestAgendaPdfPathFromSourceDir,
  pickRichestAgendaPrunedMarkdownPathFromConvertedDir,
} from "../../../../program/library/agenda_preview_shared.mjs";
import { writePyaMapArtifact } from "../../../../program/library/reporter_shared/agenda-stage-contracts.mjs";
import {
  agendaSectionItemCode,
  assertAgendaPublishable,
  findAgendaStage3Section,
  hasCompleteAgendaStage3Checkpoint,
} from "./shared/agenda-publish-gate.mjs";
import { renderAgendaPreviewToc } from "../../../../program/library/reporter_shared/agenda-preview-toc.mjs";
import { agendaPreviewPriorityAdjustment } from "../../../../program/library/reporter_shared/agenda-preview-priority.mjs";
import {
  buildAgendaPreviewChunkSpans,
  prepareAgendaPreviewSource,
} from "../../../../program/library/reporter_shared/agenda-preview-source-chunks.mjs";
import { selectAgendaPreviewCoverPath } from "../../../../program/library/reporter_shared/agenda-preview-cover.mjs";
import { hasWholeAgendaSummaryCheckpoint } from "../../../../program/library/reporter_shared/agenda-preview-checkpoint.mjs";
import { requestOllamaChat } from "../../../../program/library/reporter_shared/whole-meeting-synthesis.mjs";
import { resolveGpuHousekeeperUrl } from "../../../../program/runtime/gpu/managed-ollama.mjs";
import { requireRemoteOllamaHost } from "./shared/remote-ollama.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");
const PYASH_ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const SECRET_PATHS = [
  path.join(HOUSE_ROOT, "configure/secret.pya"),
  path.join(PYASH_ROOT, "configure/secret.pya"),
];
const SECRET_PATH = SECRET_PATHS.find((p) => fs.existsSync(p)) || SECRET_PATHS[0];
const MONTHLY_DIR = path.join(HOUSE_ROOT, "artifacts/grey-county/monthly");
const MEETINGS_DIR = path.join(HOUSE_ROOT, "artifacts/grey-county/meetings");
const RUN_BIN = path.join(PYASH_ROOT, "run");

const DEFAULT_BASE_PREFIX = GREY_ADAPTER.defaults.base_prefix || "meeting-qwen-auto";
const DEFAULT_FOCUS = GREY_ADAPTER.defaults.focus || DEFAULT_SUMMARY_FOCUS;
const DEFAULT_JURISDICTION = GREY_ADAPTER.defaults.jurisdiction || "Grey County";
const DEFAULT_BODY = GREY_ADAPTER.defaults.body || "auto";
const DEFAULT_SITE = GREY_ADAPTER.defaults.site_url || "https://helpos.ca";

const SECRET_VALUES = readPyaTextValues(SECRET_PATH, [
  "ollama host",
  "ai host",
  "relay local host",
  "host",
  "gpu housekeeper url",
  "draw host",
  "say host",
  "meeting publish auth token",
  "agenda publish auth token",
]);

function resolveOllamaHost() {
  const fromEnv = String(process.env.OLLAMA_HOST || "").trim();
  const configured = String(
    SECRET_VALUES["ollama host"]
    || SECRET_VALUES["ai host"]
    || SECRET_VALUES["relay local host"]
    || SECRET_VALUES.host
    || ""
  ).trim();
  return requireRemoteOllamaHost(fromEnv || configured || "http://mriczo:11434", {
    label: "Grey County Ollama host",
  });
}

function configureRemoteOllamaRuntime() {
  const ollamaHost = resolveOllamaHost();
  const managerUrl = resolveGpuHousekeeperUrl({ ollamaUrl: ollamaHost, env: process.env, cwd: HOUSE_ROOT });
  if (!managerUrl) throw new Error("Grey County pipeline requires the configured GPU housekeeper endpoint");
  process.env.OLLAMA_HOST = ollamaHost;
  process.env.PYA_GPU_HOUSEKEEPER_URL = managerUrl;
  process.env.PYA_GPU_MANAGER_REQUIRED = "1";
  process.env.PYA_GPU_MANAGER_ALLOW_DIRECT = "0";
  log(`[llm] ollama host: ${ollamaHost}`);
  log(`[gpu] housekeeper: ${managerUrl}`);
}

function resolveDrawHost() {
  const fromEnv = String(process.env.PYA_DRAW_HOST || process.env.GREY_DRAW_HOST || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, "");
  return String(SECRET_VALUES["draw host"] || SECRET_VALUES["say host"] || "").trim().replace(/\/$/u, "");
}

const RESOLVED_OLLAMA_HOST = resolveOllamaHost() || "http://mriczo:11434";
if (!process.env.OLLAMA_HOST && RESOLVED_OLLAMA_HOST) process.env.OLLAMA_HOST = RESOLVED_OLLAMA_HOST;
const RESOLVED_DRAW_HOST = resolveDrawHost();

function optionalHostEnv(name, value) {
  const v = String(value || "").trim();
  return v ? { [name]: v } : {};
}

function usage() {
  return [
    "Usage: node program/run-grey-county-meeting-from-ref.mjs <meeting_ref> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]",
    "meeting_ref can be meeting URL, full UUID meeting id, or 8-char meeting id prefix.",
    "Example: node ... \"https://pub-grey.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=035609ad-24d6-4d9a-9f7b-6b538b451231\"",
  ].join("\n");
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function assertPathWithin(baseDir, targetPath, label = "path") {
  const base = path.resolve(String(baseDir || ""));
  const target = path.resolve(String(targetPath || ""));
  if (!base || !target) throw new Error(`${label} invalid path`);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes meeting workspace: target=${target} base=${base}`);
  }
}

function scoreAgendaNewsworthiness({ title = "", summary = "", sourceText = "" } = {}) {
  const text = `${title} ${summary} ${sourceText}`.toLowerCase();
  let s = 0;
  if (/\b(declaration of interest|correspondence|adjournment|next meeting date|other business)\b/u.test(text)) s -= 18;
  if (/\b(items? for direction (or|and) discussion)\b/u.test(text)) s -= 12;
  if (/\b(verbal updates?|roundtable discussion)\b/u.test(text)) s += 8;
  if (/\b(wheelchair|accessibility|hospital|health|safety|food insecurity|housing|poverty)\b/u.test(text)) s += 14;
  if (/\b(budget|tax|funding|fee|cost|service change|policy)\b/u.test(text)) s += 10;
  if (/\b(by-?law|bylaws|amend|approve|adopt|vote|carried|deferred|rejected)\b/u.test(text)) s += 6;
  if (/\b(award|recognition|minutes|correspondence|consent|receipt|information only)\b/u.test(text)) s -= 8;
  return s + agendaPreviewPriorityAdjustment({ title, summary, sourceText });
}

// Report identifiers are useful for grounding but are not human-facing hook
// language. Grey uses families such as CSR-CS-19-26; keep this generic so new
// eScribe report prefixes/types are handled without a meeting-specific list.
function hasAgendaReportCode(text = "") {
  return /\b[A-Z]{2,8}-[A-Z]{2,8}-\d{1,3}-\d{2}\b/u.test(String(text || "").toUpperCase());
}

function isAgendaLabelHook(hook = "") {
  const h = String(hook || "").replace(/\s+/gu, " ").trim();
  if (!h) return true;
  const lower = h.toLowerCase();
  if (hasAgendaReportCode(h)) return true;
  if (/\bagenda item\b/u.test(lower)) return true;
  if (/\b(renewal|lease|minutes dated|information report|notice of termination)\b/u.test(lower) && h.split(/\s+/u).length <= 6) return true;
  return false;
}

function isGenericAgendaHook(hook = "") {
  const h = String(hook || "").toLowerCase().replace(/\s+/gu, " ").trim();
  return !h
    || h === "considers agenda items"
    || h.includes("agenda preview")
    || h.includes("meeting highlights")
    || isAgendaLabelHook(hook);
}

function extractFirstTopNewsBulletTitle(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/u);
  for (const raw of lines) {
    const line = String(raw || "").trim();
    const bold = line.match(/^(?:-\s+)?\*\*([^*]+)\*\*/u);
    const plain = line.startsWith("-") ? line.match(/^-\s+([^:.-][^:]{6,120})/u) : null;
    const candidate = String((bold?.[1] || plain?.[1] || "")).trim();
    if (!candidate) continue;
    return candidate.replace(/\s+/gu, " ").trim();
  }
  return "";
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "meeting";
}

function inferBodyFromPayload(payload = {}, fallback = "County Council") {
  const meetingName = String(payload?.meeting_name || "").trim();
  const meetingType = String(payload?.meeting_type || "").trim();
  const source = meetingType || meetingName;
  if (!source) return fallback;
  if (/committee of the whole/iu.test(source)) return "Committee of the Whole";
  if (/county council/iu.test(source)) return "County Council";
  if (/committee/iu.test(source)) return "Committee";
  if (/task force/iu.test(source)) return "Task Force";
  return fallback;
}

function parseSeriesLine(line) {
  const m = line.match(/^su name (.+?) since date (\S+) until date (\S+) ob text "(.+)" ya$/u);
  if (!m) return null;
  const [, suName, since, until, escapedJson] = m;
  let jsonText = "";
  let payload = null;
  try {
    jsonText = JSON.parse(`"${escapedJson}"`);
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }
  return { suName, since, until, payload };
}

function parseMeetingIdFromRef(ref) {
  const txt = String(ref || "").trim();
  if (!txt) return "";
  const idQuery = txt.match(/[?&]Id=([0-9a-fA-F-]{8,36})/u);
  if (idQuery) return idQuery[1].toLowerCase();
  const uuid = txt.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/u);
  if (uuid) return uuid[1].toLowerCase();
  const shortId = txt.match(/^([0-9a-fA-F]{8})$/u);
  if (shortId) return shortId[1].toLowerCase();
  return "";
}

function findMeetingByRef(allMeetings, ref) {
  const txt = String(ref || "").trim();
  const idHint = parseMeetingIdFromRef(txt);
  const normalizedRef = txt.toLowerCase();

  if (idHint && idHint.length === 36) {
    return allMeetings.find((m) => String(m?.payload?.meeting_id || "").toLowerCase() === idHint) || null;
  }

  if (idHint && idHint.length === 8) {
    return allMeetings.find((m) => String(m?.payload?.meeting_id || "").toLowerCase().startsWith(idHint)) || null;
  }

  if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) {
    return allMeetings.find((m) => String(m?.payload?.meeting_url || "").toLowerCase() === normalizedRef) || null;
  }

  return null;
}

function extFromUrl(url, fallback = ".bin") {
  const clean = String(url || "").split("?")[0];
  if (/filestream\.ashx$/iu.test(clean)) return ".pdf";
  if (/meeting\.aspx$/iu.test(clean)) return ".html";
  if (/isistandaloneplayer\.aspx$/iu.test(clean)) return ".html";
  const base = path.basename(clean);
  const ext = path.extname(base);
  return ext || fallback;
}

// eScribe meeting records commonly expose the post-minutes page in the
// payload, while the authoritative agenda tree is available from the same
// meeting's Meeting.aspx?Agenda=Agenda view.  Fetch that view when the
// payload did not include an agenda HTML document so canonical item codes,
// titles, order, and attachment ownership remain available to every run.
function deriveAgendaHtmlUrl(meetingUrl = "") {
  const raw = String(meetingUrl || "").trim();
  if (!raw || !/escribemeetings\.com/iu.test(raw)) return "";
  try {
    const url = new URL(raw);
    const id = url.searchParams.get("Id") || url.searchParams.get("id");
    if (!id) return "";
    url.pathname = "/Meeting.aspx";
    url.search = "";
    url.searchParams.set("Id", id);
    url.searchParams.set("Agenda", "Agenda");
    url.searchParams.set("lang", "English");
    return url.toString();
  } catch {
    return "";
  }
}

function extFromMediaUrl(url) {
  const base = String(url || "").split("?")[0].trim().toLowerCase();
  const ext = path.extname(base);
  return ext || "";
}

function isDirectAudioUrl(url) {
  const ext = extFromMediaUrl(url);
  return [".mp3", ".m4a", ".aac", ".opus", ".wav", ".flac", ".ogg"].includes(ext);
}

function isDirectVideoUrl(url) {
  const ext = extFromMediaUrl(url);
  return [".mp4", ".webm", ".mkv", ".mov", ".m4v"].includes(ext);
}

function docName(prefix, i, url) {
  const n = String(i + 1).padStart(2, "0");
  const ext = extFromUrl(url, ".pdf");
  return `${prefix}-${n}${ext}`;
}

function markdownName(sourceName) {
  const ext = path.extname(sourceName);
  const stem = sourceName.slice(0, sourceName.length - ext.length);
  return `${stem}.md`;
}

function pyaEsc(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildPipeline(meetingDir, row) {
  const payload = row.payload ?? {};
  const sourceDir = path.join(meetingDir, "source");
  const convertedDir = path.join(meetingDir, "converted");
  const reportDir = path.join(meetingDir, "report");
  const transcriptDir = path.join(meetingDir, "transcript");
  const subreportDir = path.join(convertedDir, "subreports");
  const subreportIndexPath = path.join(convertedDir, "subreports.index.json");

  const lines = [];
  const resilientDownloadCmd = (url, outputPath) =>
    `node ${pyaEsc(path.join(PYASH_ROOT, "command/resumable_download.mjs"))} '${pyaEsc(url)}' '${pyaEsc(outputPath)}' 5`;
  const diskPreflightCmd = () =>
    `node ${pyaEsc(path.join(PYASH_ROOT, "command/disk_housekeeping.mjs"))} --pre-download --required-bytes 0 --mount '${pyaEsc(transcriptDir)}'`;
  lines.push("su name sandbox configure be map def");
  lines.push("su name max output bytes ob num 8388608 ya");
  lines.push("su name timeout ms ob num 21600000 ya");
  lines.push("prah");
  lines.push("");

  lines.push(`be directory ob filename \"${pyaEsc(sourceDir)}\" do`);
  lines.push(`be directory ob filename \"${pyaEsc(convertedDir)}\" do`);
  lines.push(`be directory ob filename \"${pyaEsc(reportDir)}\" do`);
  lines.push(`be directory ob filename \"${pyaEsc(transcriptDir)}\" do`);
  lines.push("");

  const allDocs = [
    ...(Array.isArray(payload.agenda_cover) ? payload.agenda_cover.map((u, i) => ({ kind: "agenda-cover", url: u, i })) : []),
    ...(Array.isArray(payload.agenda) ? payload.agenda.map((u, i) => ({ kind: "agenda", url: u, i })) : []),
    ...(Array.isArray(payload.minutes) ? payload.minutes.map((u, i) => ({ kind: "minutes", url: u, i })) : []),
  ];
  let agendaHtmlPath = "";
  let fallbackMeetingHtmlPath = "";

  for (const doc of allDocs) {
    const fileName = docName(doc.kind, doc.i, doc.url);
    const srcPath = path.join(sourceDir, fileName);
    if (doc.kind === "agenda" && fileName.toLowerCase().endsWith(".html")) {
      agendaHtmlPath = srcPath;
    }
    if (!fallbackMeetingHtmlPath && fileName.toLowerCase().endsWith(".html") && /meeting\.aspx/iu.test(String(doc.url || ""))) {
      fallbackMeetingHtmlPath = srcPath;
    }
    lines.push(`be download from filename \"${pyaEsc(doc.url)}\" as wo file to filename \"${pyaEsc(srcPath)}\" do`);

    if (fileName.toLowerCase().endsWith(".pdf")) {
      const mdVar = `doc ${doc.kind} ${doc.i + 1} markdown`;
      const mdPath = path.join(convertedDir, markdownName(fileName));
      lines.push(`from filename \"${pyaEsc(srcPath)}\" fromstate wo pdf become wo markdown to name text ${mdVar} be read do`);
      lines.push(`ob name ${mdVar} to filename \"${pyaEsc(mdPath)}\" be write do`);
      lines.push(`ob text "node ${pyaEsc(path.join(HOUSE_ROOT, "program/ensure-agenda-markdown-from-pdf.mjs"))} '${pyaEsc(srcPath)}' '${pyaEsc(mdPath)}' '${pyaEsc(doc.url)}' '${pyaEsc(String(payload.meeting_url || payload.source_url || ""))}'" be command do`);
    }
  }

  lines.push("");
  // A Grey payload may contain only the agenda-cover PDF plus a post-minutes
  // HTML page.  Download the corresponding canonical agenda view explicitly
  // so the shared extractor never has to infer item identity from PDF layout.
  if (!agendaHtmlPath) {
    const canonicalAgendaUrl = deriveAgendaHtmlUrl(String(payload.meeting_url || payload.source_url || ""));
    if (canonicalAgendaUrl) {
      agendaHtmlPath = path.join(sourceDir, "agenda-structured.html");
      lines.push(`be download from filename "${pyaEsc(canonicalAgendaUrl)}" as wo file to filename "${pyaEsc(agendaHtmlPath)}" do`);
    } else if (fallbackMeetingHtmlPath) {
      agendaHtmlPath = fallbackMeetingHtmlPath;
    }
  }

  lines.push(`be directory ob filename \"${pyaEsc(subreportDir)}\" do`);
  lines.push(
    `ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/prepare_agenda_subreports_from_converted.mjs"))} '${pyaEsc(convertedDir)}' '${pyaEsc(subreportDir)}' '${pyaEsc(subreportIndexPath)}' '${pyaEsc(path.join(HOUSE_ROOT, "program/prune-grey-county-agenda.mjs"))}' '${pyaEsc(agendaHtmlPath)}' '${pyaEsc(String(payload.meeting_url || payload.source_url || ""))}'" be command do`,
  );

  lines.push("");
  const videos = Array.isArray(payload.video) ? payload.video : [];
  const videoPlayers = Array.isArray(payload.video_player) ? payload.video_player : [];
  const videoDirect = Array.isArray(payload.video_direct) ? payload.video_direct : [];
  if (videos.length > 0 || videoPlayers.length > 0 || videoDirect.length > 0) {
    const preferred = (
      videoDirect[0]
      || videos.find((url) => !isEscribePlayerUrl(url))
      || videoPlayers[0]
      || videos[0]
      || ""
    ).trim();
    const direct = (videoDirect[0] || videos[0] || "").trim();
    if (direct && isDirectAudioUrl(direct)) {
      const ext = extFromMediaUrl(direct) || ".opus";
      const outAudio = path.join(transcriptDir, `meeting-audio${ext}`);
      lines.push(`ob text "${resilientDownloadCmd(direct, outAudio)}" be command do`);
    } else if (direct && isDirectVideoUrl(direct)) {
      const ext = extFromMediaUrl(direct) || ".mp4";
      const outVideo = path.join(transcriptDir, `meeting-video${ext}`);
      const outAudio = path.join(transcriptDir, "meeting-audio.opus");
      lines.push(`ob text "${resilientDownloadCmd(direct, outVideo)}" be command do`);
      lines.push(`ob text "ffmpeg -nostdin -y -i '${pyaEsc(outVideo)}' -vn -ac 1 -ar 16000 -c:a libopus '${pyaEsc(outAudio)}'" be command do`);
    } else if (/youtu(?:\.be|be\.com)/iu.test(preferred)) {
      const outAudio = path.join(transcriptDir, "meeting-audio.opus");
      lines.push(`ob text "${diskPreflightCmd()}" be command do`);
      lines.push(
        `ob text "node ${pyaEsc(path.join(HOUSE_ROOT, "program/download-grey-youtube-audio.mjs"))} '${pyaEsc(preferred)}' '${pyaEsc(outAudio)}'" be command do`,
      );
    } else {
      lines.push(`ob text "${diskPreflightCmd()}" be command do`);
      lines.push(`be download ob wo all during month 1 from filename \"${pyaEsc(preferred)}\" as wo audio to filename \"${pyaEsc(transcriptDir)}\" do`);
    }
  } else {
    lines.push(`ob text \"No video link yet for this meeting. Audio download skipped.\" to filename \"${pyaEsc(path.join(transcriptDir, "note.txt"))}\" be write do`);
  }

  lines.push("");
  lines.push("ob text \"meeting workspace prep complete\" be write do");
  return `${lines.join("\n")}\n`;
}

function runWithStreaming({ cmd, args, cwd = PYASH_ROOT, env = {}, timeoutMs = 60 * 60 * 1000, label = "stage" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk ?? "");
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk ?? "");
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Math.max(10_000, Number(timeoutMs) || 10_000));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label} failed (code=${code ?? "null"} signal=${signal ?? ""})\n${stderr || stdout}`.trim()));
    });
  });
}

function loadAllMeetingsFromMonthlyFiles() {
  if (!fs.existsSync(MONTHLY_DIR)) return [];
  const files = fs.readdirSync(MONTHLY_DIR)
    .filter((name) => name.endsWith(".events.series.pya"))
    .map((name) => path.join(MONTHLY_DIR, name))
    .sort();

  const out = [];
  for (const filePath of files) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("su name grey county council events")) continue;
      if (line === "prah") continue;
      const row = parseSeriesLine(line);
      if (!row) continue;
      out.push(row);
    }
  }
  return out;
}

async function ensureMonthlyFresh() {
  await runWithStreaming({
    cmd: "node",
    args: [path.join(HOUSE_ROOT, "program/extract-grey-county-calendar-monthly.mjs")],
    cwd: PYASH_ROOT,
    timeoutMs: 5 * 60 * 1000,
    label: "refresh-monthly",
  });
}

function hasWorkspacePrepCheckpoint(meetingDir) {
  const sourceDir = path.join(meetingDir, "source");
  const convertedDir = path.join(meetingDir, "converted");
  const transcriptDir = path.join(meetingDir, "transcript");
  const hasSource = fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).some((n) => /\.(pdf|html)$/iu.test(n));
  const hasConverted = fs.existsSync(convertedDir) && fs.readdirSync(convertedDir).some((n) => /\.md$/iu.test(n));
  // Attachment-backed publication needs the canonical subreport index as
  // part of the prep checkpoint. Converted Markdown alone is insufficient:
  // an interrupted prep can leave documents present while the ownership
  // index is absent, and publishing must remain retryable until it exists.
  const subreportIndexPath = path.join(convertedDir, "subreports.index.json");
  let hasSubreportIndex = false;
  try {
    const index = JSON.parse(fs.readFileSync(subreportIndexPath, "utf8"));
    hasSubreportIndex = Array.isArray(index?.items) && index.items.length > 0;
    if (hasSubreportIndex) {
      const attachmentDirs = [...new Set([
        ...(index.items || [])
          .map((item) => String(item?.file || "").trim())
          .filter(Boolean)
          .map((file) => path.join(path.dirname(file), "_attachments")),
        path.join(convertedDir, "subreports", "_attachments"),
        path.join(convertedDir, "_attachments"),
      ].map((value) => path.resolve(value)))];
      for (const item of index.items || []) {
        const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
        const diagnostics = Array.isArray(item?.attachment_diagnostics) ? item.attachment_diagnostics : [];
        for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
          if (!String(attachments[attachmentIndex]?.url || "").trim()) continue;
          const explicit = String(
            diagnostics[attachmentIndex]?.local_file || diagnostics[attachmentIndex]?.local_path || "",
          ).trim();
          if (explicit && fs.existsSync(path.resolve(explicit))) continue;
          const prefix = `${String(item?.item || "").replace(/\./gu, "-")}-${attachmentIndex + 1}-`;
          const retained = attachmentDirs.some((dir) => {
            if (!fs.existsSync(dir)) return false;
            return fs.readdirSync(dir).some((name) => name.startsWith(prefix) && !name.endsWith(".txt"));
          });
          if (!retained) {
            hasSubreportIndex = false;
            break;
          }
        }
        if (!hasSubreportIndex) break;
      }
    }
  } catch {
    hasSubreportIndex = false;
  }
  const hasAudio = fs.existsSync(transcriptDir) && fs.readdirSync(transcriptDir).some((n) => {
    if (!/\.(opus|wav|m4a|mp3)$/iu.test(n)) return false;
    const full = path.join(transcriptDir, n);
    try {
      return fs.statSync(full).isFile() && Number(fs.statSync(full).size || 0) > 0;
    } catch {
      return false;
    }
  });
  return hasSource && hasConverted && hasSubreportIndex && hasAudio;
}

function hasAgendaPreviewArtifactsCheckpoint(transcriptDir, normPrefix) {
  const hasSummaryArtifact = [
    path.join(transcriptDir, `${normPrefix}.agenda-summary.json`),
    path.join(transcriptDir, `${normPrefix}.agenda-summary.pya`),
    path.join(transcriptDir, `${normPrefix}.agenda-summary.md`),
  ].some((filePath) => fs.existsSync(filePath) && String(fs.readFileSync(filePath, "utf8") || "").trim());
  if (!hasSummaryArtifact) return false;

  const required = [
    path.join(transcriptDir, `${normPrefix}.meeting-summary.md`),
    path.join(transcriptDir, `${normPrefix}.meeting-hook.txt`),
    path.join(transcriptDir, `${normPrefix}.lemmy-post.json`),
  ];
  for (const filePath of required) {
    if (!fs.existsSync(filePath)) return false;
    if (!String(fs.readFileSync(filePath, "utf8") || "").trim()) return false;
  }
  return true;
}

function hasTranscriptAudio(transcriptDir) {
  if (!fs.existsSync(transcriptDir)) return false;
  const files = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
  return files.some((name) => /\.(opus|wav|mp3|m4a|aac|flac)$/iu.test(name));
}

function parseDateInfoFromSince(sinceText) {
  const iso = String(sinceText || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return { iso: "", long: "Unknown date" };
  const dt = new Date(`${iso}T12:00:00Z`);
  return {
    iso,
    long: dt.toLocaleDateString("en-CA", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
  };
}

function scheduledMeetingHasStarted(sinceText = "") {
  const match = String(sinceText || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) return true;
  const [, year, month, day, hour, minute, second] = match;
  const scheduled = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0,
  );
  // eScribe exposes the live broadcast before and during the meeting. Give
  // the recording a short publication window before treating that URL as a
  // completed transcript source; agenda previews remain publishable during
  // the live interval and the next scheduled run can pick up the recording.
  const recordingGraceMs = 30 * 60 * 1000;
  return scheduled.getTime() + recordingGraceMs <= Date.now();
}

function formatMeetingTimeText(payload, sinceText) {
  const formattedStart = String(payload?.formatted_start || "").trim();
  const fromFormatted = formattedStart.match(/@\s*([0-9]{1,2}:[0-9]{2}\s*[AP]M)\b/i);
  if (fromFormatted) return fromFormatted[1].replace(/\s+/gu, " ").toUpperCase();
  const local = String(payload?.start_local || sinceText || "").trim();
  const m = local.match(/T(\d{2}):(\d{2})/u);
  if (!m) return "";
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return "";
  const suffix = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

function pickMeetingLocationText(payload) {
  const candidates = [
    payload?.location,
    payload?.meeting_location,
    payload?.meetingLocation,
    payload?.venue,
    payload?.meeting_venue,
    payload?.address,
    payload?.formatted_location,
    payload?.formattedLocation,
  ];
  for (const raw of candidates) {
    const text = String(raw || "").replace(/\s+/gu, " ").trim();
    if (text) return text;
  }
  return "";
}

function buildScheduleContext({ dateInfo, meetingTime, meetingLocation }) {
  const parts = [];
  if (dateInfo?.long) parts.push(`date: ${dateInfo.long}`);
  if (meetingTime) parts.push(`time: ${meetingTime}`);
  if (meetingLocation) parts.push(`location: ${meetingLocation}`);
  return parts.join("; ");
}

function pickAgendaMarkdownPath(meetingDir) {
  return pickRichestAgendaMarkdownPathFromConvertedDir(path.join(meetingDir, "converted"));
}

function pickAgendaPrunedMarkdownPath(meetingDir) {
  return pickRichestAgendaPrunedMarkdownPathFromConvertedDir(path.join(meetingDir, "converted"));
}

function pickAgendaPdfPath(meetingDir) {
  return pickRichestAgendaPdfPathFromSourceDir(path.join(meetingDir, "source"));
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeReadText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(text) {
  const escaped = escapeHtml(String(text || ""));
  return escaped
    .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/gu, "<em>$1</em>");
}

function markdownToHtmlBlock(markdownText) {
  const lines = String(markdownText || "").replace(/\r\n/gu, "\n").split("\n");
  const out = [];
  let inList = false;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${renderInlineMarkdown(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (!inList) return;
    out.push("</ul>");
    inList = false;
  };

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) {
      flushPara();
      closeList();
      continue;
    }
    const li = line.match(/^[-*]\s+(.+)$/u);
    if (li) {
      flushPara();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInlineMarkdown(li[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }

  flushPara();
  closeList();
  return out.join("\n");
}

async function runSubmitHook(command, payloadPath) {
  const escapedPayload = String(payloadPath).replace(/"/gu, "\\\"");
  await runWithStreaming({
    cmd: "bash",
    args: ["-lc", `${command} "${escapedPayload}"`],
    cwd: PYASH_ROOT,
    env: {
      // The writer's deployment secret lives beside the house adapter, while
      // the generic publish command runs from PYASH_ROOT. Pass the token only
      // to the child publisher; never print it or persist it in artifacts.
      ...(String(process.env.MEETING_PUBLISH_AUTH_TOKEN || process.env.AGENDA_PUBLISH_AUTH_TOKEN || "").trim()
        ? {}
        : {
          MEETING_PUBLISH_AUTH_TOKEN: String(
            SECRET_VALUES["meeting publish auth token"]
            || SECRET_VALUES["agenda publish auth token"]
            || "",
          ).trim(),
        }),
    },
    timeoutMs: 10 * 60 * 1000,
    label: "submit-hook",
  });
}

function uniqueNonEmptyStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function compactText(value, maxLen = 420) {
  const oneLine = String(value || "").replace(/\s+/gu, " ").trim();
  if (!oneLine) return "";
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function cleanSummaryForPost(value) {
  const stripInlineBoilerplate = (line) => String(line || "")
    .replace(/\bpage\s+\d+\s+of\s+\d+\b\.?/giu, " ")
    .replace(/\bpages?\s+\d+(\s*-\s*\d+)?\b\.?/giu, " ")
    .replace(/\bfollowing council\b[\s\S]*$/iu, " ")
    .replace(/\bcouncil chambers\b[\s\S]*$/iu, " ")
    .replace(/\bgrey county administration building\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const lines = String(value || "")
    .split(/\r?\n/u)
    .map((x) => stripInlineBoilerplate(x))
    .filter(Boolean)
    .filter((line) => !/\|\s*gender\s*:/iu.test(line))
    .filter((line) => !/\|\s*role\s*:/iu.test(line))
    .filter((line) => !/^page\s+\d+\s+of\s+\d+/iu.test(line))
    .filter((line) => !/committee of the whole agenda/iu.test(line))
    .filter((line) => !/following council council chambers/i.test(line))
    .filter((line) => !/^pages?\s+\d+(\s*-\s*\d+)?\.?$/iu.test(line));
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}

function tokenizeAgendaText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .split(/\s+/u)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 4);
}

function extractFirstMeaningfulSentence(text = "") {
  const src = cleanSummaryForPost(String(text || ""));
  if (!src) return "";
  const parts = src.split(/(?<=[.!?])\s+/u).map((x) => x.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.split(/\s+/u).filter(Boolean).length >= 8) return part;
  }
  return parts[0] || src;
}

function sanitizeAgendaItemSummaryIsolation(item = {}, peers = []) {
  const title = String(item?.title || "");
  const summary = cleanSummaryForPost(String(item?.active_summary || ""));
  if (!summary) return "";
  const sourceText = String(item?.source_text || "").trim();
  const ownTokens = new Set(tokenizeAgendaText(title));
  const otherTokenHits = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!peer || peer === item) continue;
    const ptitle = String(peer?.title || "");
    const ptokens = tokenizeAgendaText(ptitle).filter((t) => !ownTokens.has(t));
    let hits = 0;
    for (const t of ptokens) {
      if (summary.toLowerCase().includes(t)) hits += 1;
      if (hits >= 2) break;
    }
    if (hits >= 2) otherTokenHits.push(ptitle);
  }
  const contaminated = otherTokenHits.length > 0;
  if (!contaminated) return summary;

  if (sourceText) {
    const first = extractFirstMeaningfulSentence(sourceText);
    if (first && first.split(/\s+/u).filter(Boolean).length >= 8) return first;
  }

  const readerTitle = normalizeAgendaTitle(title) || title;
  return `Agenda item under review: ${readerTitle}.`;
}

function normalizeAgendaTitle(title = "") {
  let out = String(title || "")
    .replace(/\*\*/gu, "")
    .replace(/^page\s+\d+\s+of\s+\d+\s*/iu, "")
    .replace(/\bpage\s+\d+\s+of\s+\d+\b/giu, "")
    .replace(/\bpages?\s+\d+(\s*-\s*\d+)?\b/giu, "")
    .replace(/\bcommittee of the whole agenda\b[\s\S]*$/iu, "")
    .replace(/\bfollowing council[\s\S]*$/iu, "")
    .replace(/\bwhereas\b[\s\S]*$/iu, "")
    .replace(/\.{3,}$/u, "")
    .replace(/\s+That\s+report[\s\S]*$/iu, "")
    .replace(/\s+That\s+the[\s\S]*$/iu, "")
    .replace(/\s+Items\s+For\s+Direction\s+and\s+Discussion[\s\S]*$/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  out = out.replace(/^\d+(?:\.[a-z])?\s*/iu, "").trim();
  if (!out) return "";
  return out;
}

function parseAgendaSummaryMarkdownSections(mdText = "") {
  const src = String(mdText || "").replace(/\r\n/gu, "\n");
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || "").trim();
    if (!line.startsWith("## ")) continue;
    const heading = line.replace(/^##\s+/u, "").trim();
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = String(lines[j] || "");
      if (next.trim().startsWith("## ")) break;
      body.push(next);
    }
    const chapterAt = body.findIndex((x) => String(x || "").trim() === "Chapters");
    const summaryLines = chapterAt >= 0 ? body.slice(0, chapterAt) : body;
    const summary = summaryLines.map((x) => x.trim()).filter(Boolean).join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    const chapters = chapterAt < 0 ? [] : body.slice(chapterAt + 1).reduce((rows, raw) => {
      const line = String(raw || "").trim();
      const m = line.match(/^- \[[^\]]+\]\s+(.+)$/u);
      if (m) rows.push({ title: m[1].trim(), summary: "" });
      else if (line && rows.length) rows.at(-1).summary = `${rows.at(-1).summary} ${line}`.trim();
      return rows;
    }, []);
    if (heading && summary) out.push({ heading, summary, chapters });
  }
  return out;
}

function dedupeMarkdownBulletLines(text = "") {
  const lines = String(text || "").split(/\r?\n/u);
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = String(raw || "");
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      out.push(line);
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function trimTrailingConjunction(text = "") {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (!value) return "";
  return value.replace(/\s+(and|or|but|nor|yet|so)\s*$/iu, "").trim();
}

function buildAgendaPreviewGroundedFocus(focus = "") {
  const userFocus = String(focus || "").trim();
  const constraints = [
    "upcoming agenda preview",
    "strictly grounded in source text",
    "no claims of decisions already made",
    "no sensational framing",
    "avoid inferred motives or causal claims unless explicit",
  ].join("; ");
  return userFocus ? `${userFocus}; ${constraints}` : constraints;
}

function markdownSection(mdText, heading) {
  const lines = String(mdText || "").split(/\r?\n/u);
  const target = String(heading || "").trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/u);
    if (!m) continue;
    if (m[1].trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function markdownLeadSection(mdText) {
  const lines = String(mdText || "").split(/\r?\n/u);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#\s+Whole Meeting Summary\b/iu.test(String(lines[i] || "").trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (/^##\s+/u.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function toAgendaWiseSeriesText(items = []) {
  const lines = ["su name wise chips be series def"];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const heading = `${String(it?.item || "").trim()} ${String(it?.title || "").trim()}`.trim();
    const body = safeReadText(String(it?.file || ""), "").trim();
    if (!heading || !body) continue;
    const chip = `[Agenda Start] ${heading} | method agenda-package\n${body}`;
    lines.push(`ob text quoted.text.${chip}.text.quoted from num ${i + 1} be text ya`);
  }
  lines.push("prah");
  return `${lines.join("\n")}\n`;
}

function parseAgendaHeadingStart(line = "") {
  let s = String(line || "")
    .replace(/\u00a0/gu, " ")
    .replace(/\*\*/gu, "")
    .replace(/^#+\s*/u, "")
    .replace(/^[-*]\s+/u, "")
    .trim();
  if (!s) return null;
  const m = s.match(/^((?:\d+(?:\.[a-z])?)\.?)\s*(.*)$/iu);
  if (!m) return null;
  const rawCode = String(m[1] || "").trim();
  const code = rawCode.replace(/\.$/u, "");
  if (!code) return null;
  const numeric = Number(code.split(".")[0]);
  if (Number.isFinite(numeric) && numeric > 40) return null;
  const remainder = String(m[2] || "").trim();
  if (!/\.$/u.test(rawCode)) {
    if (!/^[A-Za-z][A-Za-z0-9"'()\-/,;&: ]*$/u.test(remainder)) return null;
    if (remainder.length < 3) return null;
  }
  return { code, remainder };
}

function parseAgendaOutlineItems(mdText = "") {
  const lines = String(mdText || "")
    .split(/\r?\n/u)
    .map((x) => x.trim());
  const isPageNumber = (s) => /^\d+$/u.test(String(s || "").trim()) || /^page\s+\d+\s+of\s+\d+$/iu.test(String(s || "").trim());
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseAgendaHeadingStart(lines[i]);
    if (!parsed) continue;
    const item = parsed.code;
    const sectionParts = [];
    if (parsed.remainder) sectionParts.push(parsed.remainder);
    for (let j = i + 1; j < lines.length; j += 1) {
      const s = lines[j];
      if (!s) continue;
      if (parseAgendaHeadingStart(s)) break;
      if (isPageNumber(s)) continue;
      sectionParts.push(s);
      if (sectionParts.join(" ").length > 6000) break;
    }
    const clippedParts = [];
    const itemNorm = normalizeAgendaItemCode(item);
    for (const part of sectionParts) {
      const nested = parseAgendaHeadingStart(part);
      if (nested && normalizeAgendaItemCode(nested.code) !== itemNorm) break;
      clippedParts.push(part);
    }
    const title = sectionParts
      .slice(0, 4)
      .join(" ")
      .replace(/\s+(?:\d+(?:\.[a-z])?)\.?\s+[A-Z][^]*$/u, "")
      .replace(/\s+/gu, " ")
      .trim();
    const embeddedCodes = title.match(/\b\d+(?:\.[a-z])?\b/giu) || [];
    if (!title || embeddedCodes.length > 2) continue;
    const excerpt = (clippedParts.length ? clippedParts : sectionParts).join("\n").trim();
    out.push({ item, title, excerpt });
  }
  return out;
}

function normalizeAgendaItemCode(code = "") {
  return String(code || "").trim().toLowerCase().replace(/\.$/u, "");
}

function buildAgendaFallbackOutlineItems({ meetingDir, agendaPath, transcriptDir, normPrefix }) {
  const prunedAgendaPath = pickAgendaPrunedMarkdownPath(meetingDir);
  const outlineSourcePath = prunedAgendaPath || agendaPath;
  const mdText = safeReadText(outlineSourcePath, "").trim();
  if (!mdText) return [];
  const parsed = parseAgendaOutlineItems(mdText);
  if (!parsed.length) return [];
  const outDir = path.join(transcriptDir, `${normPrefix}.agenda-outline`);
  fs.mkdirSync(outDir, { recursive: true });
  return parsed.map((it, idx) => {
    const stem = slugify(`${it.item}-${it.title}`) || `agenda-item-${idx + 1}`;
    const file = path.join(outDir, `${stem}.txt`);
    if (!fs.existsSync(file)) {
      const body = `${it.item} ${it.title}\n\nAgenda item noted in published package.\n`;
      fs.writeFileSync(file, body, "utf8");
    }
    return {
      item: String(it.item || "").trim(),
      title: String(it.title || "").trim(),
      file,
      has_page_slice: false,
    };
  });
}

function estimateSectionDurationSecondsFromText(text = "") {
  const words = String(text || "").trim().split(/\s+/u).filter(Boolean).length;
  if (!words) return 45;
  return Math.max(45, Math.min(45 * 60, Math.round(words * 0.42)));
}

function buildAgendaPreviewGroundingArtifact(items = []) {
  const groundedUnits = [];
  let rowCursor = 0;
  let timeCursor = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const agendaItem = String(item.item || "").trim().toLowerCase() || String(i + 1);
    const title = String(item.title || "").trim() || `Agenda item ${agendaItem}`;
    const sourceText = safeReadText(String(item.file || ""), "").trim();
    const excerpt = prepareAgendaPreviewSource(sourceText) || `Agenda section ${agendaItem}: ${title}.`;
    const baseSourceRows = Math.max(
      1,
      excerpt
        .split(/\n{2,}/u)
        .map((x) => x.trim())
        .filter(Boolean).length,
    );
    const durationSeconds = estimateSectionDurationSecondsFromText(excerpt);
    const rowStart = rowCursor;
    const since = timeCursor;
    const until = since + durationSeconds;
    const chunkId = `preview_chunk_${String(i + 1).padStart(3, "0")}`;

    const excerptWordCount = excerpt.split(/\s+/u).filter(Boolean).length;
    const sourceWordCount = Number(item.source_word_count || 0);
    const longSource = typeof item.long_source === "boolean"
      ? item.long_source
      : sourceWordCount >= 700 || excerptWordCount >= 700;
    const chapterSpans = longSource
      ? buildAgendaPreviewChunkSpans(excerpt, {
        rowStart,
        sourceRows: baseSourceRows,
        since,
        durationSeconds,
      })
      : [];
    const sourceRows = chapterSpans.length
      ? chapterSpans.at(-1).rowEnd - rowStart + 1
      : baseSourceRows;
    const rowEnd = rowStart + sourceRows - 1;
    const unitId = `ground_${String(i + 1).padStart(3, "0")}`;
    const childChapters = chapterSpans.map((chapter, chapterIndex) => {
      const chapterId = `${chunkId}_chapter_${String(chapterIndex + 1).padStart(2, "0")}`;
      return {
      "chapter id": chapterId,
      "parent unit id": unitId,
      "ordering index": chapterIndex + 1,
      "row start": chapter.rowStart,
      "row end": chapter.rowEnd,
      "source rows": chapter.sourceRows,
      since: chapter.since,
      until: chapter.until,
      "duration seconds": chapter.durationSeconds,
      "chunk ids": [chapterId],
      "trace row span": `${chapter.rowStart}..${chapter.rowEnd}`,
      "source excerpt": chapter.text,
      "source chars": chapter.text.length,
      };
    });

    groundedUnits.push({
      "unit id": unitId,
      "agenda item": agendaItem,
      "parent agenda item": agendaItem,
      label: `${agendaItem} ${title}`.trim(),
      "row start": rowStart,
      "row end": rowEnd,
      "source rows": sourceRows,
      since,
      until,
      "duration seconds": durationSeconds,
      "chunk ids": [chunkId],
      "chunk span": { first: chunkId, last: chunkId },
      "parent unit id": "",
      "split depth": 0,
      "grounding confidence": 0.82,
      "grounding status": "grounded-preview",
      "source excerpt": excerpt,
      "source words": excerpt.split(/\s+/u).filter(Boolean).length,
      "trace chunk ids": [chunkId],
      "trace row span": `${rowStart}..${rowEnd}`,
      "trace signals": {
        "likely agenda items": [agendaItem],
        "signal flow": ["agenda-package"],
        "topic transition": ["none"],
      },
      "part index": 0,
      "part total": 1,
      "source kind": item.attachments?.length ? "attachment-backed" : "agenda-package",
      substantive: Boolean(item.substantive) || sourceWordCount >= 80 || excerptWordCount >= 80,
      "long source": longSource,
      procedural: Boolean(item.procedural),
      "child chapters": childChapters,
    });

    rowCursor = rowEnd + 1;
    timeCursor = until;
  }
  return {
    "schema version": "agenda_section_grounding_v1",
    "generated time": new Date().toISOString(),
    "transcript rows total": Math.max(1, rowCursor),
    "grounded units": groundedUnits,
  };
}

function parseFirstJsonObject(text) {
  const src = String(text || "");
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = src.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function looksExtractiveFallbackSummary(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^page\s+\d+\s+of\s+\d+/iu.test(t)) return true;
  if (/page\s+\d+\s+of\s+\d+/iu.test(t) && /committee|meeting|report/iu.test(t)) return true;
  const words = t.split(/\s+/u).filter(Boolean).length;
  if (words < 12) return true;
  return false;
}

function splitTextIntoGrossChunks(text, { maxChars = 16_000, minChars = 3_500 } = {}) {
  const source = String(text || "").trim();
  if (!source) return [];
  const paras = source.split(/\n{2,}/u).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [source];
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    const next = cur ? `${cur}\n\n${p}` : p;
    if (next.length <= maxChars) {
      cur = next;
      continue;
    }
    if (cur && cur.length >= minChars) {
      chunks.push(cur);
      cur = p;
      continue;
    }
    // Paragraph is very large; split by sentence boundaries.
    const sentences = p.split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      const sentNext = cur ? `${cur} ${s}` : s;
      if (sentNext.length <= maxChars) {
        cur = sentNext;
      } else {
        if (cur) chunks.push(cur);
        cur = s;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}

function forceSplitLongTextInTwo(text) {
  const src = String(text || "").trim();
  if (!src) return [];
  const sentences = src.split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 6) return [src];
  const totalWords = sentences.reduce((n, s) => n + s.split(/\s+/u).filter(Boolean).length, 0);
  const target = Math.max(1, Math.floor(totalWords / 2));
  let seen = 0;
  let cut = -1;
  for (let i = 0; i < sentences.length; i += 1) {
    seen += sentences[i].split(/\s+/u).filter(Boolean).length;
    if (seen >= target) {
      cut = i;
      break;
    }
  }
  if (cut <= 0 || cut >= sentences.length - 1) return [src];
  return [
    sentences.slice(0, cut + 1).join(" ").trim(),
    sentences.slice(cut + 1).join(" ").trim(),
  ].filter(Boolean);
}

async function summarizeAgendaSubsectionChunkLlm({
  heading,
  chunkText,
  focus,
}) {
  const cleaned = String(chunkText || "").trim();
  if (!cleaned) return null;
  const prompt = [
    "Create one subsection for an upcoming civic agenda preview.",
    `Parent agenda heading: ${String(heading || "").trim() || "(unknown)"}`,
    `Focus: ${String(focus || "").trim() || "newsworthy civic impacts"}`,
    "Return JSON only with keys: title, summary.",
    "Rules:",
    "- title: 5-12 words, specific, no trailing period.",
    "- summary: one sentence, 18-40 words, concrete, future/present tense.",
    "- use only facts from chunk text.",
    "",
    "Chunk text:",
    cleaned.slice(0, 14_000),
  ].join("\n");

  try {
    const raw = await requestOllamaChat([
      { role: "system", content: "You write concise subsection summaries for civic agenda previews." },
      { role: "user", content: prompt },
    ], { numPredict: 180, retryAttempts: 3, retryDelayMs: 2500 });
    const parsed = parseFirstJsonObject(raw) || {};
    const title = String(parsed?.title || "").replace(/\s+/gu, " ").trim();
    const summary = String(parsed?.summary || "").replace(/\s+/gu, " ").trim();
    if (!title || !summary) throw new Error("qwen returned incomplete subsection summary");
    return { title, summary };
  } catch (error) {
    throw new Error(`agenda subsection summary generation failed; job remains retryable: ${String(error?.message || error)}`);
  }
}

async function buildAgendaPreviewSubsections({
  topItems,
  focus,
}) {
  const out = new Map();
  for (const it of Array.isArray(topItems) ? topItems : []) {
    const key = String(it?.item || "").trim();
    const text = String(it?.source_text || "").trim();
    if (!key || !text) continue;
    const words = text.split(/\s+/u).filter(Boolean).length;
    if (words < 700) continue;
    let chunks = splitTextIntoGrossChunks(text, { maxChars: 8_000, minChars: 2_200 }).slice(0, 5);
    if (chunks.length <= 1) {
      chunks = forceSplitLongTextInTwo(text).slice(0, 5);
    }
    if (chunks.length <= 1) continue;
    const rows = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const sub = await summarizeAgendaSubsectionChunkLlm({
        heading: `${it.item ? `${it.item} ` : ""}${it.title}`.trim(),
        chunkText: chunks[i],
        focus,
      });
      if (!sub) continue;
      rows.push({
        index: i + 1,
        title: String(sub.title || "").trim(),
        summary: String(sub.summary || "").trim(),
      });
    }
    if (rows.length > 1) out.set(key, rows);
  }
  return out;
}

async function generateOneSentenceSummaryLlm({
  transcriptDir,
  normPrefix,
  focus,
  fullAgendaSummary,
  topNewsMarkdown,
  scheduleContext,
}) {
  const full = String(fullAgendaSummary || "").trim();
  const top = String(topNewsMarkdown || "").trim();
  const sourceText = [
    full ? `WHOLE AGENDA SUMMARY:\n${full}` : "",
    top ? `TOP NEWSWORTHY AGENDA ITEMS:\n${top}` : "",
  ].filter(Boolean).join("\n\n").trim();
  if (!sourceText) return "";
  const sourcePath = path.join(transcriptDir, `${normPrefix}.one-sentence-source.txt`);
  fs.writeFileSync(sourcePath, `${sourceText}\n`, "utf8");
  const prompt = [
    "Write exactly one sentence for an upcoming civic agenda preview.",
    `Focus: ${String(focus || "").trim() || "newsworthy civic decisions"}.`,
    "Constraints: 18-32 words; present/future tense; concrete; no ellipses; no semicolons; no bullet/list format.",
    scheduleContext ? `Include these meeting details when possible: ${scheduleContext}.` : "If meeting date/time/location details are provided, include them naturally.",
    "Use distinct wording from the whole agenda summary.",
    "",
    sourceText,
  ].join("\n");
  try {
    let first = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        first = String(await requestOllamaChat([
          { role: "system", content: "You write concise civic agenda teasers." },
          { role: "user", content: prompt },
        ], { numPredict: 96, retryAttempts: 3, retryDelayMs: 2500 }))
          .split(/\r?\n/u)
          .map((x) => x.trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (first) break;
      } catch {
        // retry
      }
    }
    if (!first) throw new Error("qwen returned an empty one-sentence summary");
    return first;
  } catch {
    throw new Error("one-sentence summary generation failed; job remains retryable");
  }
}

async function verifyAgendaPreviewClaimsLlm({
  candidateText,
  sourceTopNews,
  sourceSections,
  scheduleContext,
}) {
  const candidate = String(candidateText || "").trim();
  if (!candidate) return "";
  const sources = [
    String(sourceTopNews || "").trim(),
    String(sourceSections || "").trim(),
  ].filter(Boolean).join("\n\n").trim();
  if (!sources) return candidate;
  const prompt = [
    "Validate and correct an upcoming civic agenda preview text.",
    scheduleContext ? `Meeting context: ${scheduleContext}.` : "",
    "Return only corrected text.",
    "Rules:",
    "- Keep only claims supported by SOURCE.",
    "- Remove speculation, loaded framing, and causal claims not explicit in SOURCE.",
    "- Keep upcoming tense (will/may/is scheduled to be considered).",
    "- Do not invent numbers, names, or outcomes.",
    "- Preserve concise style and readability.",
    "",
    `CANDIDATE:\n${candidate}`,
    "",
    `SOURCE:\n${sources}`,
  ].join("\n");
  try {
    const out = String(await requestOllamaChat([
      { role: "system", content: "You are a strict factual verifier for civic agenda previews." },
      { role: "user", content: prompt },
    ], { numPredict: 260, retryAttempts: 3, retryDelayMs: 2500 }))
      .split(/\r?\n/u)
      .map((x) => x.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!out) throw new Error("qwen returned empty verified agenda text");
    return out;
  } catch (error) {
    throw new Error(`agenda claim verification failed; job remains retryable: ${String(error?.message || error)}`);
  }
}

async function rewriteAgendaPreviewUpcomingTenseLlm({
  candidateText,
  sourceTopNews,
  sourceSections,
  scheduleContext,
}) {
  const candidate = String(candidateText || "").trim();
  if (!candidate) return "";
  const sources = [
    String(sourceTopNews || "").trim(),
    String(sourceSections || "").trim(),
  ].filter(Boolean).join("\n\n").trim();
  if (!sources) return candidate;
  const prompt = [
    "Rewrite this upcoming civic agenda preview text in future/present tense only.",
    scheduleContext ? `Meeting context: ${scheduleContext}.` : "",
    "Return only rewritten text.",
    "Rules:",
    "- Keep claims grounded in SOURCE only.",
    "- Use future/present tense for agenda items (will/may/is scheduled to/is expected to).",
    "- Do not imply events already happened.",
    "- Preserve concise style and key details.",
    "",
    `CANDIDATE:\n${candidate}`,
    "",
    `SOURCE:\n${sources}`,
  ].join("\n");
  try {
    const out = String(await requestOllamaChat([
      { role: "system", content: "You are a strict editor for upcoming agenda previews." },
      { role: "user", content: prompt },
    ], { numPredict: 300, retryAttempts: 3, retryDelayMs: 2500 }))
      .split(/\r?\n/u)
      .map((x) => x.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!out) throw new Error("qwen returned empty tense-reviewed agenda text");
    return out;
  } catch (error) {
    throw new Error(`agenda tense review failed; job remains retryable: ${String(error?.message || error)}`);
  }
}

async function buildAgendaSummarySourcePath({ meetingDir, transcriptDir, normPrefix }) {
  const prunedAgendaMdPath = pickAgendaPrunedMarkdownPath(meetingDir);
  const prunedText = prunedAgendaMdPath ? safeReadText(prunedAgendaMdPath, "").trim() : "";
  if (prunedAgendaMdPath && prunedText) return prunedAgendaMdPath;

  const agendaMdPath = pickAgendaMarkdownPath(meetingDir);
  const mdText = agendaMdPath ? safeReadText(agendaMdPath, "").trim() : "";
  if (agendaMdPath && mdText) return agendaMdPath;

  const agendaPdfPath = pickAgendaPdfPath(meetingDir);
  if (!agendaPdfPath || !fs.existsSync(agendaPdfPath)) return "";

  const extractedPath = path.join(transcriptDir, `${normPrefix}.agenda-source.txt`);
  try {
    await runWithStreaming({
      cmd: "pdftotext",
      args: [agendaPdfPath, extractedPath],
      cwd: PYASH_ROOT,
      timeoutMs: 2 * 60 * 1000,
      label: "extract-agenda-pdf-text",
    });
    const txt = safeReadText(extractedPath, "").trim();
    if (!txt) return "";
    const clipped = `${txt.slice(0, 120000)}\n`;
    fs.writeFileSync(extractedPath, clipped, "utf8");
    return extractedPath;
  } catch {
    return "";
  }
}

async function writeAgendaPreviewArtifacts({
  meetingDir,
  row,
  payload,
  focus,
  jurisdiction,
  body,
  siteUrl,
  discussionUrl,
  basePrefix,
}) {
  const transcriptDir = path.join(meetingDir, "transcript");
  const normPrefix = `${basePrefix}-normalized`;
  const forceAgendaRebuild = /^(1|true|yes)$/iu.test(String(process.env.GREY_AGENDA_FORCE_REBUILD || ""));
  const skipAgendaPreviewSubmit = /^(1|true|yes)$/iu.test(String(process.env.GREY_SKIP_AGENDA_PREVIEW_SUBMIT || "0"));
  const lemmyPayloadPath = path.join(transcriptDir, `${normPrefix}.lemmy-post.json`);
  if (!forceAgendaRebuild && hasAgendaPreviewArtifactsCheckpoint(transcriptDir, normPrefix)) {
    log("[meeting-ref] skip agenda-preview generation (checkpoint exists)");
    if (skipAgendaPreviewSubmit) {
      log("[meeting-ref] no transcript audio: submit skipped for agenda preview (GREY_SKIP_AGENDA_PREVIEW_SUBMIT=1)");
      return;
    }
    const submitCommand = String(
      process.env.GREY_AGENDA_POST_COMMAND
      || process.env.AGENDA_POST_COMMAND
      || `node ${path.join(PYASH_ROOT, "command/publish_agenda_to_helpos_from_payload.mjs")}`
    ).trim();
    if (submitCommand) {
      log(`[meeting-ref] submit command: ${submitCommand}`);
      await runSubmitHook(submitCommand, lemmyPayloadPath);
    } else {
      log("[meeting-ref] submit skipped (set GREY_AGENDA_POST_COMMAND or AGENDA_POST_COMMAND)");
    }
    return;
  }

  const agendaFocus = buildAgendaPreviewGroundedFocus(focus);
  const agendaPath = await buildAgendaSummarySourcePath({ meetingDir, transcriptDir, normPrefix });
  const subreportIndexPath = path.join(meetingDir, "converted", "subreports.index.json");
  const subreportIndex = safeReadJson(subreportIndexPath, {});
  const dateInfo = parseDateInfoFromSince(row?.since || "");
  const agendaCanonicalUrl = `${siteUrl.replace(/\/+$/u, "")}/agendas/${slugify(jurisdiction)}/${slugify(body)}/${dateInfo.iso || "unknown-date"}`;
  const transcriptCanonicalUrl = `${siteUrl.replace(/\/+$/u, "")}/transcripts/${slugify(jurisdiction)}/${slugify(body)}/${dateInfo.iso || "unknown-date"}`;
  const meetingName = String(payload?.meeting_name || body || "Meeting").trim();
  const meetingSummaryPath = path.join(transcriptDir, `${normPrefix}.meeting-summary.md`);
  const meetingHookPath = path.join(transcriptDir, `${normPrefix}.meeting-hook.txt`);
  const coverImagePath = path.join(transcriptDir, `${normPrefix}.meeting-cover.png`);
  const coverImageStablePath = path.join(transcriptDir, "meeting-cover.png");

  const items = Array.isArray(subreportIndex?.items) ? subreportIndex.items : [];
  const agendaWisePath = path.join(transcriptDir, `${normPrefix}.agenda-wise.series.pya`);
  const agendaSummaryPath = path.join(transcriptDir, `${normPrefix}.agenda-summary.json`);
  const agendaSummaryMdPath = path.join(transcriptDir, `${normPrefix}.agenda-summary.md`);
  const canonicalAgendaSectionGroundingPath = path.join(transcriptDir, `${normPrefix}.agenda.section-grounding.pya`);
  const transcriptStyleItems = items
    .map((it) => ({
      item: String(it?.item || "").trim(),
      title: normalizeAgendaTitle(String(it?.title || "").trim()),
      file: String(it?.file || "").trim(),
      has_page_slice: Boolean(it?.has_page_slice),
      attachments: Array.isArray(it?.attachments) ? it.attachments : [],
      substantive: Boolean(it?.substantive),
      long_source: typeof it?.long_source === "boolean" ? it.long_source : Number(it?.source_word_count || 0) >= 700,
      source_word_count: Number(it?.source_word_count || 0),
      procedural: Boolean(it?.procedural),
    }))
    .filter((it) => it.item && it.title && it.file && fs.existsSync(it.file));
  const sectionFallbackItems = (Array.isArray(subreportIndex?.sections) ? subreportIndex.sections : [])
    .map((sec) => ({
      item: String(sec?.item || "").trim(),
      title: normalizeAgendaTitle(String(sec?.title || "").trim()),
      file: String(sec?.file || "").trim(),
      has_page_slice: true,
      attachments: [],
    }))
    .filter((it) => it.item && it.title && it.file && fs.existsSync(it.file))
    ;
  const fallbackOutlineItems = agendaPath
    ? buildAgendaFallbackOutlineItems({ meetingDir, agendaPath, transcriptDir, normPrefix })
    : [];
  // If we have true page-sliced subreports, keep agenda-wise strictly subreport-driven.
  const mergedAgendaItems = (
    transcriptStyleItems.length
      ? transcriptStyleItems
      : (sectionFallbackItems.length ? sectionFallbackItems : fallbackOutlineItems)
  );
  const existingStage3Sections = (() => {
    const fromMarkdown = parseAgendaSummaryMarkdownSections(safeReadText(agendaSummaryMdPath, ""));
    if (fromMarkdown.length) return fromMarkdown;
    const fromJson = safeReadJson(agendaSummaryPath, {});
    return Array.isArray(fromJson?.sections) ? fromJson.sections : [];
  })();
  const reuseStage3 = /^(1|true|yes)$/iu.test(String(process.env.GREY_AGENDA_REUSE_STAGE3 || ""))
    && fs.existsSync(agendaSummaryMdPath)
    && fs.existsSync(path.join(transcriptDir, `${normPrefix}.agenda-summary.pya`))
    && hasCompleteAgendaStage3Checkpoint(existingStage3Sections, mergedAgendaItems);
  if (mergedAgendaItems.length) {
    fs.writeFileSync(agendaWisePath, toAgendaWiseSeriesText(mergedAgendaItems), "utf8");
    const previewGrounding = buildAgendaPreviewGroundingArtifact(mergedAgendaItems);
    writePyaMapArtifact(
      canonicalAgendaSectionGroundingPath,
      "agenda section grounding artifact",
      previewGrounding,
    );
    if (reuseStage3) {
      log("[meeting-ref] reuse existing Stage 3 agenda summaries (GREY_AGENDA_REUSE_STAGE3=1)");
    } else try {
      await runWithStreaming({
        cmd: "node",
        args: [path.join(HOUSE_ROOT, "program/summarize-agenda-wise-sections-from-transcript-folder.mjs"), transcriptDir, normPrefix, agendaFocus],
        cwd: PYASH_ROOT,
        env: {
          ...optionalHostEnv("OLLAMA_HOST", RESOLVED_OLLAMA_HOST),
          AGENDA_SUMMARY_TIME_MODE: "upcoming",
        },
        timeoutMs: 2 * 60 * 60 * 1000,
        label: "agenda-wise-section-summaries",
      });
    } catch (error) {
      throw new Error(`Stage 3 agenda summary generation failed; job remains retryable: ${String(error?.message || error)}`);
    }
  }
  const agendaSummaryJson = safeReadJson(agendaSummaryPath, {});
  const agendaSummarySections = (() => {
    const fromStage3Markdown = parseAgendaSummaryMarkdownSections(safeReadText(agendaSummaryMdPath, ""));
    if (fromStage3Markdown.length) return fromStage3Markdown;
    return Array.isArray(agendaSummaryJson?.sections) ? agendaSummaryJson.sections : [];
  })();
  const agendaSummarySectionForItem = (item) => findAgendaStage3Section(agendaSummarySections, item);
  const summaryIndexPath = "";
  const displayItems = (() => {
    if (!mergedAgendaItems.length) return items;
    if (transcriptStyleItems.length) {
      return items;
    }
    const byItem = new Map();
    for (const it of mergedAgendaItems) {
      const key = normalizeAgendaItemCode(it.item);
      if (!key) continue;
      byItem.set(key, it);
    }
    // Re-apply real subreport files so they override any outline-only placeholders.
    for (const it of items) {
      const key = normalizeAgendaItemCode(String(it?.item || ""));
      if (!key) continue;
      byItem.set(key, {
        item: String(it?.item || "").trim(),
        title: normalizeAgendaTitle(String(it?.title || "").trim()),
        file: String(it?.file || "").trim(),
        has_page_slice: Boolean(it?.has_page_slice),
        attachments: Array.isArray(it?.attachments) ? it.attachments : [],
        substantive: Boolean(it?.substantive),
        long_source: typeof it?.long_source === "boolean" ? it.long_source : Number(it?.source_word_count || 0) >= 700,
        source_word_count: Number(it?.source_word_count || 0),
        procedural: Boolean(it?.procedural),
      });
    }
    return [...byItem.values()];
  })();
  const topItems = displayItems
    .map((it) => {
      const stage3Section = agendaSummarySectionForItem(it);
      return {
        item: String(it?.item || "").trim(),
        title: normalizeAgendaTitle(String(it?.title || "").trim()),
        source_text: safeReadText(String(it?.file || ""), "").trim(),
        agenda_section_summary: String(stage3Section?.summary || "").trim(),
        generated_summary: "",
        stage3_chapters: stage3Section?.chapters || [],
        substantive: Boolean(it?.substantive) || Number(it?.source_word_count || 0) >= 80,
        long_source: typeof it?.long_source === "boolean" ? it.long_source : Number(it?.source_word_count || 0) >= 700,
        procedural: Boolean(it?.procedural),
        attachments: Array.isArray(it?.attachments)
          ? it.attachments
            .map((a) => ({
              label: String(a?.label || "").trim(),
              url: String(a?.url || "").trim(),
            }))
            .filter((a) => a.label && a.url)
          : [],
      };
    })
    .filter((it) => it.title)
    .map((it) => ({
      ...it,
      newsworthiness_score: scoreAgendaNewsworthiness({
        title: it.title,
        summary: it.agenda_section_summary || it.generated_summary,
        sourceText: it.source_text,
      }),
    }))
    ;
  assertAgendaPublishable(topItems);
  const subsectionRowsByItem = new Map(topItems.map((item) => [String(item.item || "").trim(), item.stage3_chapters]));
  const subsectionHighlightsMarkdown = topItems
    .map((it) => {
      const key = String(it.item || "").trim();
      const subs = subsectionRowsByItem.get(key) || [];
      if (!subs.length) return "";
      const heading = `${it.item ? `${it.item} ` : ""}${it.title}`.trim();
      const merged = subs
        .map((sub) => `${String(sub.title || "").trim()}: ${String(sub.summary || sub.text || "").trim()}`)
        .filter(Boolean)
        .join(" ");
      if (!merged) return "";
      return `- **${heading} (Subsections):** ${merged}`;
    })
    .filter(Boolean)
    .join("\n");
  const agendaLinks = uniqueNonEmptyStrings([
    ...(Array.isArray(payload?.agenda_cover) ? payload.agenda_cover : []),
    ...(Array.isArray(payload?.agenda) ? payload.agenda : []),
  ]);
  const localSourceAttachments = [
    ...(Array.isArray(payload?.agenda_cover)
      ? payload.agenda_cover.map((url, index) => ({ kind: "agenda-cover", url, index }))
      : []),
    ...(Array.isArray(payload?.agenda)
      ? payload.agenda.map((url, index) => ({ kind: "agenda", url, index }))
      : []),
  ]
    .filter((row) => /\/filestream\.ashx(?:[?#]|$)/iu.test(String(row.url || "")))
    .map((row) => ({
      item: "agenda-source",
      label: row.kind === "agenda-cover" ? "Official agenda cover" : "Official agenda package",
      url: row.url,
      local_file: path.join(meetingDir, "source", docName(row.kind, row.index, row.url)),
    }));

  const allSummaryItems = topItems
    .map((it) => ({
      ...it,
      active_summary: cleanSummaryForPost(String(it.agenda_section_summary || it.generated_summary || "").trim()),
    }))
    .filter((it) => it.active_summary)
    .map((it, _idx, arr) => ({
      ...it,
      active_summary: sanitizeAgendaItemSummaryIsolation(it, arr),
    }))
    .filter((it) => it.active_summary);
  const rankedSummaryItems = [...allSummaryItems].sort((a, b) =>
    Number(b.newsworthiness_score || 0) - Number(a.newsworthiness_score || 0)
    || Number(a.order || 0) - Number(b.order || 0));
  const summaryItems = rankedSummaryItems.filter((it) => Number(it.newsworthiness_score || 0) >= 0).slice(0, 8);
  if (!summaryItems.length) summaryItems.push(...rankedSummaryItems.slice(0, Math.min(4, rankedSummaryItems.length)));
  const selectedSummaryItemKeys = new Set(summaryItems.map((it) => String(it.item || "").trim()));
  const newsworthySubsectionHighlightsMarkdown = topItems
    .filter((it) => selectedSummaryItemKeys.has(String(it.item || "").trim()))
    .map((it) => {
      const subs = subsectionRowsByItem.get(String(it.item || "").trim()) || [];
      const merged = subs
        .map((sub) => `${String(sub.title || "").trim()}: ${String(sub.summary || sub.text || "").trim()}`)
        .filter(Boolean)
        .join(" ");
      if (!merged) return "";
      return `- **${it.item ? `${it.item} ` : ""}${it.title} (Subsections):** ${merged}`;
    })
    .filter(Boolean)
    .join("\n");
  let hook = "";
  const sourceByItemCode = new Map(
    topItems
      .map((it) => [String(it.item || "").trim().toLowerCase(), String(it.source_text || "").trim()])
      .filter(([k, v]) => k && v),
  );
  const deterministicBreakdown = agendaSummarySections
    .map((sec) => ({
      heading: String(sec?.heading || "").trim(),
      summary: cleanSummaryForPost(String(sec?.summary || "").trim()),
    }))
    .filter((it) => it.heading && it.summary);
  if (topItems.length > 0 && summaryItems.length === 0 && deterministicBreakdown.length === 0) {
    throw new Error("agenda preview missing section summaries (regression guard)");
  }
  const forceWholeSummary = /^(1|true|yes)$/iu.test(String(
    process.env.GREY_AGENDA_FORCE_WHOLE_SUMMARY || process.env.GREY_PIPELINE_FORCE_WHOLE_SUMMARY || "",
  ));
  const reuseWholeSummary = hasWholeAgendaSummaryCheckpoint(meetingSummaryPath, agendaSummarySections);
  const drawStartedAt = Date.now();
  let drawCoverOk = false;
  try {
    if (reuseWholeSummary) {
      log("[meeting-ref] reuse complete whole-agenda summary checkpoint");
    } else {
      await runWithStreaming({
        cmd: "node",
        args: [
          path.join(HOUSE_ROOT, "program/summarize-whole-meeting-from-agenda-summary.mjs"),
          transcriptDir,
          normPrefix,
          agendaFocus,
        ],
        cwd: PYASH_ROOT,
        env: {
          ...optionalHostEnv("OLLAMA_HOST", RESOLVED_OLLAMA_HOST),
          AGENDA_SUMMARY_TIME_MODE: "upcoming",
        },
        timeoutMs: 60 * 60 * 1000,
        label: "agenda-whole-summary",
      });
    }
  } catch (error) {
    throw new Error(`agenda whole summary generation failed; job remains retryable: ${String(error?.message || error)}`);
  }
  const meetingSummaryMd = safeReadText(meetingSummaryPath, "").trim();
  if (!meetingSummaryMd) throw new Error("agenda whole summary artifact is empty; job remains retryable");
  const llmTopNews = markdownSection(meetingSummaryMd, "Top Newsworthy Developments");
  const llmWhyMatters = markdownSection(meetingSummaryMd, "Why It Matters");
  const deterministicTopNewsMarkdown = summaryItems.length
    ? summaryItems.map((it) => `- **${it.item ? `${it.item} ` : ""}${it.title}** ${it.active_summary}`).join("\n")
    : "";
  const mergedTopNewsMarkdown = dedupeMarkdownBulletLines([
    llmTopNews,
    newsworthySubsectionHighlightsMarkdown,
    (!llmTopNews ? deterministicTopNewsMarkdown : ""),
  ].filter(Boolean).join("\n\n").trim());
  try {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(PYASH_ROOT, "command/generate_meeting_hook_from_transcript_folder.mjs"),
        transcriptDir,
        normPrefix,
        agendaFocus,
        jurisdiction,
        body,
      ],
      cwd: PYASH_ROOT,
      env: {
        ...optionalHostEnv("OLLAMA_HOST", RESOLVED_OLLAMA_HOST),
      },
      timeoutMs: 30 * 60 * 1000,
      label: "agenda-preview-hook",
    });
  } catch (error) {
    throw new Error(`agenda hook generation failed; job remains retryable: ${String(error?.message || error)}`);
  }
  const hookJsonPath = path.join(transcriptDir, `${normPrefix}.meeting-hook.json`);
  const hookTextCandidate = trimTrailingConjunction(safeReadText(meetingHookPath, "").trim());
  const hookJsonCandidate = trimTrailingConjunction(String(safeReadJson(hookJsonPath, {})?.hook || "").trim());
  // The JSON artifact is the generator's structured result. Prefer it so a
  // stale text artifact cannot overwrite a fresh hook; reject report-code
  // fragments before accepting either artifact.
  const generatedHookCandidates = [hookJsonCandidate, hookTextCandidate];
  const generatedHook = generatedHookCandidates
    .map((candidate) => trimTrailingConjunction(candidate))
    .find((candidate) => candidate && !isAgendaLabelHook(candidate));
  if (!generatedHook || isGenericAgendaHook(generatedHook)) {
    throw new Error("agenda preview hook generation returned no substantive hook; job remains retryable");
  }
  hook = generatedHook;
  // Keep the structured hook artifact in lockstep with the value used in the
  // page title/payload.
  const hookJsonArtifact = safeReadJson(hookJsonPath, null);
  if (hookJsonArtifact && typeof hookJsonArtifact === "object" && hookJsonArtifact.hook !== hook) {
    fs.writeFileSync(hookJsonPath, `${JSON.stringify({ ...hookJsonArtifact, hook }, null, 2)}\n`, "utf8");
  }
  const title = `${hook} - ${meetingName} Agenda Preview - ${dateInfo.long}`;
  const meetingTime = formatMeetingTimeText(payload, row?.since || "");
  const meetingLocation = pickMeetingLocationText(payload);
  const scheduleContext = buildScheduleContext({ dateInfo, meetingTime, meetingLocation });

  const llmLead = markdownLeadSection(meetingSummaryMd);
  const narrativeWholeSummary = cleanSummaryForPost(llmLead || llmWhyMatters || "");
  if (!narrativeWholeSummary || narrativeWholeSummary.length < 90) {
    throw new Error("agenda whole summary is empty or too short; job remains retryable");
  }
  const fullAgendaSummary = narrativeWholeSummary;
  const verifiedWholeAgendaSummary = await verifyAgendaPreviewClaimsLlm({
    candidateText: fullAgendaSummary,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
  });
  const enforcedWholeAgendaSummary = await rewriteAgendaPreviewUpcomingTenseLlm({
    candidateText: verifiedWholeAgendaSummary,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
  });
  const llmOneSentence = await generateOneSentenceSummaryLlm({
    transcriptDir,
    normPrefix,
    focus: agendaFocus,
    fullAgendaSummary: enforcedWholeAgendaSummary,
    topNewsMarkdown: mergedTopNewsMarkdown || llmTopNews,
    scheduleContext,
  });
  const verifiedOneSentenceSummary = String(await verifyAgendaPreviewClaimsLlm({
    candidateText: llmOneSentence,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
  }) || "").trim();
  const oneSentenceSummary = await rewriteAgendaPreviewUpcomingTenseLlm({
    candidateText: verifiedOneSentenceSummary,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
  });
  const safeOneSentenceFinal = String(oneSentenceSummary || "").trim();
  if (!safeOneSentenceFinal) throw new Error("one-sentence summary generation returned empty text; job remains retryable");
  const whenWhere = [
    dateInfo.long ? `**${dateInfo.long}**` : "",
    meetingTime ? `**${meetingTime}**` : "",
    meetingLocation ? `at **${meetingLocation}**` : "",
  ].filter(Boolean).join(" ");
  const bodyParts = [
    whenWhere ? `Upcoming meeting preview for **${meetingName}** on ${whenWhere}.` : `Upcoming meeting preview for **${meetingName}**.`,
    "This preview is based on the published agenda package and supporting reports.",
  ];
  bodyParts.push("## One-Sentence Summary");
  bodyParts.push(safeOneSentenceFinal);
  bodyParts.push("## Whole Agenda Summary");
  bodyParts.push(enforcedWholeAgendaSummary);
  const topNewsForBodyRaw = mergedTopNewsMarkdown || llmTopNews;
  const topNewsForBody = topNewsForBodyRaw
    ? await rewriteAgendaPreviewUpcomingTenseLlm({
      candidateText: topNewsForBodyRaw,
      sourceTopNews: topNewsForBodyRaw,
      sourceSections: deterministicTopNewsMarkdown,
      scheduleContext,
    })
    : "";
  if (topNewsForBody) {
    bodyParts.push("## Most Newsworthy Agenda Items");
    bodyParts.push(topNewsForBody);
  } else {
    throw new Error("agenda newsworthy summary generation returned empty text; job remains retryable");
  }
  bodyParts.push("## What To Watch");
  bodyParts.push("- Which agenda items move forward to formal recommendations.");
  bodyParts.push("- Whether staff proposals trigger additional public consultation or revisions.");
  bodyParts.push("- Follow-up actions, timelines, and any deferred items.");
  bodyParts.push(`Read full agenda archive page: ${agendaCanonicalUrl}`);
  bodyParts.push(`Transcript will be published here: ${transcriptCanonicalUrl}`);
  bodyParts.push("Share accessibility feedback with Grey County: https://www.grey.ca/government/accessibility");
  if (agendaLinks.length) {
    bodyParts.push("## Original Agenda Package Links");
    bodyParts.push(agendaLinks.map((url, idx) => `- [Agenda source ${idx + 1}](${url})`).join("\n"));
  }
  const attachmentLinks = topItems
    .flatMap((it) => it.attachments.map((a) => ({
      label: a.label,
      url: a.url,
    })));
  if (payload?.meeting_url) bodyParts.push(`Official meeting page: ${payload.meeting_url}`);
  if (discussionUrl) bodyParts.push(`HelpOS discussion: ${discussionUrl}`);
  const bodyMarkdown = bodyParts.join("\n\n").trim();

  const jurisdictionSlug = slugify(jurisdiction);
  const bodySlug = slugify(body);
  const archiveJurUrl = `/agendas/${jurisdictionSlug}`;
  const archiveBodyUrl = `/agendas/${jurisdictionSlug}/${bodySlug}`;
  const summaryText = enforcedWholeAgendaSummary;
  const description = `Agenda preview and section summaries for the ${meetingName} meeting on ${dateInfo.long}.`;
  const summaryTextByItem = new Map(summaryItems.map((it) => [String(it.item || "").trim(), String(it.active_summary || "").trim()]));
  const sectionRows = topItems
    .filter((it) => String(it.source_text || "").trim())
    .map((it, idx) => ({
      id: `section-${idx + 1}`,
      heading: `${it.item ? `${it.item} ` : ""}${it.title}`.trim(),
      summary: summaryTextByItem.get(String(it.item || "").trim()) || cleanSummaryForPost(String(it.agenda_section_summary || it.generated_summary || "").trim()),
      fullText: String(it.source_text || "").trim(),
      subsections: (subsectionRowsByItem.get(String(it.item || "").trim()) || []).map((sub, subIndex) => ({
        ...sub,
        id: `section-${idx + 1}-child-${subIndex + 1}`,
      })),
    }));
  const tocRows = [
    { href: "#summary", label: "Summary" },
    { href: "#key-topics", label: "Key Topics & Sections" },
    { href: "#details", label: "Meeting Details" },
    { href: "#discussion", label: "Related Discussion" },
    { href: "#transcript-notice", label: "Transcript Notice" },
    { href: "#full-transcript", label: "Full Transcript" },
    { href: "#related-links", label: "Related Links" },
  ];
  const tocHtml = renderAgendaPreviewToc({ utilityRows: tocRows, sections: sectionRows });
  const topNewsHtml = llmTopNews
    ? `<div class="newsworthy-md">${markdownToHtmlBlock(llmTopNews)}</div>`
    : "";
  const sectionsHtml = sectionRows.length
    ? sectionRows.map((s) => {
      const subsectionsHtml = Array.isArray(s.subsections) && s.subsections.length
        ? `<div class="section-subsections">${s.subsections.map((sub) => `<article id="${escapeHtml(sub.id || "")}" class="subsection"><h4>${escapeHtml(sub.title || "Subsection")}</h4><p>${escapeHtml(sub.summary || sub.text || "")}</p></article>`).join("")}</div>`
        : "";
      return `<section id="${escapeHtml(s.id)}" class="transcript-section"><h3>${escapeHtml(s.heading)}</h3><p class="section-summary">${escapeHtml(s.summary)}</p>${subsectionsHtml}<pre>${escapeHtml(s.fullText)}</pre></section>`;
    }).join("\n")
    : "<p>No section text available.</p>";
  const schemaTopics = sectionRows.flatMap((section) => [
    section.heading,
    ...section.subsections.map((sub) => String(sub.title || "").trim()),
  ]).filter(Boolean);
  const ld = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    headline: title,
    datePublished: `${dateInfo.iso || "1970-01-01"}T00:00:00-05:00`,
    dateModified: new Date().toISOString(),
    mainEntityOfPage: agendaCanonicalUrl,
    publisher: { "@type": "Organization", name: "HelpOS", url: DEFAULT_SITE },
    about: schemaTopics.slice(0, 10),
    description,
  };

  const htmlLines = [
    "<!doctype html>",
    "<html lang=\"en-CA\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `  <title>${escapeHtml(title)}</title>`,
    `  <meta name=\"description\" content="${escapeHtml(description)}" />`,
    `  <link rel="canonical" href="${escapeHtml(agendaCanonicalUrl)}" />`,
    `  <meta property="og:title" content="${escapeHtml(title)}" />`,
    `  <meta property="og:description" content="${escapeHtml(description)}" />`,
    "  <meta property=\"og:type\" content=\"article\" />",
    `  <meta property="og:url" content="${escapeHtml(agendaCanonicalUrl)}" />`,
    `  <meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `  <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `  <script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    "  <style>",
    "    :root { --bg:#faf8f2; --fg:#1c1f24; --muted:#5c6670; --line:#d7d2c6; --accent:#0f5f8f; }",
    "    * { box-sizing:border-box; }",
    "    body { margin:0; font-family: \"Source Serif 4\", Georgia, serif; background:var(--bg); color:var(--fg); line-height:1.6; }",
    "    .wrap { max-width: 860px; margin: 0 auto; padding: 1.25rem 1rem 3rem; }",
    "    nav.breadcrumbs { font-size:.95rem; color:var(--muted); margin-bottom:1rem; }",
    "    nav.breadcrumbs a { color:var(--accent); text-decoration:none; }",
    "    header h1 { margin:.2rem 0 .4rem; font-size:1.9rem; line-height:1.2; }",
    "    .subtitle { color:var(--muted); margin:0 0 1rem; }",
    "    .hook { display:inline-block; margin:.2rem 0 .55rem; padding:.2rem .5rem; border:1px solid var(--line); background:#fff; font-family:\"IBM Plex Sans\", Arial, sans-serif; font-size:.92rem; font-weight:700; }",
    "    section { margin: 1.25rem 0 1.4rem; padding-top:.3rem; }",
    "    h2 { font-family: \"IBM Plex Sans\", Arial, sans-serif; font-size:1.25rem; margin:0 0 .6rem; }",
    "    h3 { font-family: \"IBM Plex Sans\", Arial, sans-serif; margin:.6rem 0 .4rem; font-size:1.02rem; }",
    "    .toc { margin:.3rem 0 .9rem; padding:.6rem .75rem; border:1px solid var(--line); background:#fff; }",
    "    .toc ol { margin:.25rem 0 .1rem 1.2rem; }",
    "    .toc .toc-children { margin:.2rem 0 .35rem 1.15rem; font-size:.94rem; }",
    "    .toc a { color:var(--accent); text-decoration:none; }",
    "    .details dl { display:grid; grid-template-columns: 160px 1fr; gap:.25rem .75rem; margin:0; }",
    "    .details dt { font-weight:700; font-family:\"IBM Plex Sans\", Arial, sans-serif; }",
    "    .details dd { margin:0; }",
    "    .notice { border:1px solid var(--line); background:#fff; padding:.75rem .85rem; }",
    "    .section-summary { margin:.1rem 0 .5rem; color:#26323e; background:#fff; border-left:3px solid var(--line); padding:.35rem .55rem; }",
    "    .transcript-section { margin: 1.1rem 0 1.25rem; }",
    "    .section-subsections { margin:.5rem 0 .7rem; display:grid; gap:.45rem; }",
    "    .subsection { background:#fff; border:1px solid var(--line); padding:.45rem .55rem; }",
    "    .subsection h4 { margin:.05rem 0 .2rem; font-family:\"IBM Plex Sans\", Arial, sans-serif; font-size:.95rem; }",
    "    .subsection p { margin:0; color:#26323e; }",
    "    pre { white-space:pre-wrap; background:#fff; border:1px solid var(--line); padding:.7rem; }",
    "    .discussion a, .links a { color:var(--accent); }",
    "    ul { margin:.25rem 0 .25rem 1.2rem; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main class=\"wrap\">",
    "    <nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\">",
    "      <a href=\"/\">Home</a> / <a href=\"/agendas\">Agendas</a> / " +
      `<a href="${escapeHtml(archiveJurUrl)}">${escapeHtml(jurisdiction)}</a> / ` +
      `<a href="${escapeHtml(archiveBodyUrl)}">${escapeHtml(body)}</a> / <span>${escapeHtml(dateInfo.long)}</span>`,
    "    </nav>",
    "    <header>",
    `      <h1>${escapeHtml(meetingName)} Agenda Preview — ${escapeHtml(dateInfo.long)}</h1>`,
    `      ${hook ? `<p class="hook">Hook: ${escapeHtml(hook)}</p>` : ""}`,
    `      <p class="subtitle">${escapeHtml(jurisdiction)} · ${escapeHtml(body)} · ${escapeHtml(dateInfo.long)}</p>`,
    "    </header>",
    "    <section id=\"summary\">",
    "      <h2>Summary</h2>",
    `      <p><strong>One-sentence summary:</strong> ${escapeHtml(safeOneSentenceFinal)}</p>`,
    `      <p>${escapeHtml(summaryText)}</p>`,
    `      ${topNewsHtml ? `<h3>Top Newsworthy Developments</h3>${topNewsHtml}` : ""}`,
    "    </section>",
    "    <section id=\"key-topics\">",
    "      <h2>Key Topics &amp; Sections</h2>",
    `      ${tocHtml}`,
    "    </section>",
    "    <section id=\"details\" class=\"details\">",
    "      <h2>Meeting Details</h2>",
    "      <dl>",
    `        <dt>Jurisdiction</dt><dd>${escapeHtml(jurisdiction)}</dd>`,
    `        <dt>Body</dt><dd>${escapeHtml(body)}</dd>`,
    `        <dt>Date</dt><dd>${escapeHtml(dateInfo.long)}</dd>`,
    "        <dt>Transcript Status</dt><dd>Agenda package summary and extracted subreport text</dd>",
    `        <dt>Transcript URL</dt><dd><a href="${escapeHtml(transcriptCanonicalUrl)}">${escapeHtml(transcriptCanonicalUrl)}</a></dd>`,
    `        <dt>Official Source</dt><dd>${payload?.meeting_url ? `<a href="${escapeHtml(String(payload.meeting_url))}">View official meeting page</a>` : "Not provided"}</dd>`,
    "      </dl>",
    "    </section>",
    "    <section id=\"discussion\" class=\"discussion\">",
    "      <h2>Related Discussion</h2>",
    `      <p>${discussionUrl ? `<a href="${escapeHtml(discussionUrl)}">Discuss this meeting on HelpOS</a>` : "HelpOS discussion thread link pending."}</p>`,
    "    </section>",
    "    <section id=\"transcript-notice\" class=\"notice\" aria-labelledby=\"transcript-notice-title\">",
    "      <h2 id=\"transcript-notice-title\">Transcript Notice</h2>",
    "      <p>This page is an accessibility-focused summary and extracted agenda text intended to promote civic accessibility.</p>",
    "      <p>It is an unofficial convenience copy and may contain extraction or summarization errors.</p>",
    "      <p>For the authoritative record, try to access the original source materials from Grey County using the original link below.</p>",
    `      <p>${payload?.meeting_url ? `<a href="${escapeHtml(String(payload.meeting_url))}">Original meeting link</a>` : "Original meeting link unavailable."}</p>`,
    "    </section>",
    "    <section id=\"full-transcript\">",
    "      <h2>Full Transcript</h2>",
    `      ${sectionsHtml}`,
    "    </section>",
    "    <section id=\"related-links\" class=\"links\">",
    "      <h2>Related Links</h2>",
    "      <ul>",
    `        <li><a href="${escapeHtml(archiveJurUrl)}">More ${escapeHtml(jurisdiction)} agendas</a></li>`,
    `        <li><a href="${escapeHtml(archiveBodyUrl)}">More ${escapeHtml(body)} agendas</a></li>`,
    `        <li><a href="${escapeHtml(transcriptCanonicalUrl)}">Transcript URL</a></li>`,
    `        ${payload?.meeting_url ? `<li><a href="${escapeHtml(String(payload.meeting_url))}">Official eScribe meeting page</a></li>` : ""}`,
    ...agendaLinks.map((url, idx) => `        <li><a href="${escapeHtml(url)}">Agenda source ${idx + 1}</a></li>`),
    "      </ul>",
    "    </section>",
    "  </main>",
    "</body>",
    "</html>",
    "",
  ].filter(Boolean);
  const html = htmlLines.join("\n");

  const htmlPath = path.join(transcriptDir, "transcript-page.html");
  const lemmyBodyPath = path.join(transcriptDir, `${normPrefix}.lemmy-post.md`);

  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(meetingHookPath, `${hook}\n`, "utf8");

  try {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(PYASH_ROOT, "command/draw_meeting_cover_from_transcript_folder.mjs"),
        transcriptDir,
        normPrefix,
        process.env.GREY_DRAW_STYLE || "",
      ],
      cwd: PYASH_ROOT,
      env: {
        ...optionalHostEnv("PYA_DRAW_HOST", RESOLVED_DRAW_HOST),
        COVER_JURISDICTION: jurisdiction,
        COVER_MEETING_TYPE: `${body} agenda preview`,
        COVER_PROMPT_PROFILE: "teaching_video_scene",
      },
      timeoutMs: 45 * 60 * 1000,
      label: "draw-meeting-cover",
    });
    drawCoverOk = true;
  } catch (err) {
    log(`[meeting-ref] warn draw-meeting-cover failed: ${String(err?.message || err)}`);
    for (const stalePath of [coverImageStablePath, coverImagePath]) {
      try {
        if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
      } catch {}
    }
  }

  const isFreshFile = (filePath) => {
    try {
      const st = fs.statSync(filePath);
      return st.isFile() && Number(st.size || 0) > 0 && Number(st.mtimeMs || 0) >= (drawStartedAt - 1500);
    } catch {
      return false;
    }
  };
  const chosenCoverPath = selectAgendaPreviewCoverPath({
    drawCompleted: drawCoverOk,
    stablePath: coverImageStablePath,
    preferredPath: coverImagePath,
    isFreshFile,
  });
  if (chosenCoverPath) assertPathWithin(transcriptDir, chosenCoverPath, "cover image");
  else log("[meeting-ref] warn agenda preview continuing without a cover image");

  fs.writeFileSync(lemmyBodyPath, `${bodyMarkdown}\n`, "utf8");
  fs.writeFileSync(
    lemmyPayloadPath,
    `${JSON.stringify({
      title,
      body_markdown: bodyMarkdown,
      agenda_url: agendaCanonicalUrl,
      transcript_url: transcriptCanonicalUrl,
      local_agenda_html: htmlPath,
      local_transcript_html: htmlPath,
      local_cover_image: chosenCoverPath,
      local_attachment_index: subreportIndexPath,
      local_source_attachments: localSourceAttachments,
      jurisdiction,
      body,
      date_iso: dateInfo.iso,
      hook,
      focus,
      source: {
        meeting_url: String(payload?.meeting_url || ""),
        video_url: "",
        agenda_urls: agendaLinks,
        subreport_summaries_file: summaryIndexPath,
        agenda_wise_series_file: agendaWisePath,
        agenda_summary_file: agendaSummaryMdPath,
      },
      discussion_url: discussionUrl,
      content_type: "agenda",
      generated_at_utc: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );

  const publishCfg = normalizePublishConfig({
    env: process.env,
    adapter: GREY_ADAPTER,
    fallbackCommand: "",
  });
  const submitCommand = String(
    process.env.GREY_AGENDA_POST_COMMAND
    || process.env.AGENDA_POST_COMMAND
    || `node ${path.join(PYASH_ROOT, "command/publish_agenda_to_helpos_from_payload.mjs")}`
  ).trim();
  if (skipAgendaPreviewSubmit) {
    log("[meeting-ref] no transcript audio: submit skipped for agenda preview (GREY_SKIP_AGENDA_PREVIEW_SUBMIT=1)");
    return;
  }
  if (submitCommand) {
    log(`[meeting-ref] submit command: ${submitCommand}`);
    await runSubmitHook(submitCommand, lemmyPayloadPath);
  } else {
    log("[meeting-ref] submit skipped (set GREY_LEMMY_POST_COMMAND or MEETING_POST_COMMAND)");
  }
}

async function main() {
  if (!process.env.PYA_RUNTIME_FILE) process.env.PYA_RUNTIME_FILE = path.join(HOUSE_ROOT, "conduct", "runtime.pya");
  configureRemoteOllamaRuntime();
  const meetingRef = process.argv[2];
  const basePrefix = process.argv[3] || DEFAULT_BASE_PREFIX;
  const focus = process.argv[4] || DEFAULT_FOCUS;
  const jurisdiction = process.argv[5] || DEFAULT_JURISDICTION;
  const bodyArg = process.argv[6] || DEFAULT_BODY;
  const siteUrl = process.argv[7] || DEFAULT_SITE;
  const discussionUrl = process.argv[8] || "";
  const forcePrep = /^(1|true|yes)$/iu.test(String(process.env.GREY_PREP_FORCE || ""));
  const skipPrep = /^(1|true|yes)$/iu.test(String(process.env.GREY_PIPELINE_SKIP_PREP || ""));
  const skipFull = /^(1|true|yes)$/iu.test(String(process.env.GREY_PIPELINE_SKIP_FULL || ""));

  if (!meetingRef) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  fs.mkdirSync(MEETINGS_DIR, { recursive: true });

  log("[meeting-ref] refreshing Grey County monthly calendar cache");
  await ensureMonthlyFresh();

  const allMeetings = loadAllMeetingsFromMonthlyFiles();
  if (!allMeetings.length) throw new Error("no meetings found in monthly cache");

  const row = findMeetingByRef(allMeetings, meetingRef);
  if (!row) {
    throw new Error(`meeting not found for ref: ${meetingRef}`);
  }

  const payload = { ...(row.payload || {}) };
  const meetingId = String(payload.meeting_id || "").trim();
  const videoFromPayload = Array.isArray(payload.video) ? payload.video : [];
  let videoFromMeetingRecord = [];
  if (meetingId) {
    const meetingRecord = await fetchMeetingRecordById(meetingId, "2020-01-01", "2030-12-31");
    videoFromMeetingRecord = classifyMeetingVideoUrls(meetingRecord?.MeetingDocumentLink || []);
  }
  let videoCandidates = [...videoFromPayload, ...videoFromMeetingRecord];
  const selectedYoutube = selectLongestOfficialYoutubeRecording(videoCandidates);
  if (selectedYoutube) {
    videoCandidates.unshift(selectedYoutube.url);
    log(`[meeting-ref] selected official YouTube recording ${selectedYoutube.id} duration=${selectedYoutube.duration}s`);
  } else if (videoCandidates.some((url) => /youtu\.?be/iu.test(String(url || "")))) {
    // Do not pass a live/upcoming YouTube broadcast through as if it were a
    // completed recording. The selector has already checked the official
    // channel metadata; unresolved live candidates are left for a later run
    // while this run remains eligible to publish the agenda preview.
    const liveCandidates = videoCandidates.filter((url) => /youtu\.?be/iu.test(String(url || "")));
    videoCandidates = videoCandidates.filter((url) => !/youtu\.?be/iu.test(String(url || "")));
    log(`[meeting-ref] ignoring unresolved/live YouTube candidate(s): ${liveCandidates.join(", ")}`);
  }
  const videoResolved = await resolveMeetingVideoUrls(videoCandidates);
  // eScribe commonly exposes the live stream before an upcoming meeting. It
  // is not a completed recording and must not block the agenda-preview path
  // on an indefinitely growing HLS download. A later scheduled run will use
  // the recording once the meeting has started and the source is available.
  if (!scheduledMeetingHasStarted(row.since) && videoResolved.all.length) {
    log(`[meeting-ref] scheduled meeting has not started; ignoring live video for agenda preview`);
    videoResolved.all = [];
    videoResolved.direct = [];
    videoResolved.player = [];
  }
  payload.video_candidates = videoCandidates;
  payload.video = videoResolved.all;
  payload.video_direct = videoResolved.direct;
  payload.video_player = videoResolved.player;
  payload.video_resolved_at_utc = new Date().toISOString();
  const body = /^(auto)?$/iu.test(String(bodyArg || "").trim())
    ? inferBodyFromPayload(payload, "County Council")
    : bodyArg;

  const day = String(row.since || "").slice(0, 10);
  const id = String(payload.meeting_id || "unknown-id");
  const folder = `${day}_${slugify(payload.meeting_name)}_${id.slice(0, 8)}`;
  const meetingDir = path.join(MEETINGS_DIR, folder);

  fs.mkdirSync(meetingDir, { recursive: true });
  fs.mkdirSync(path.join(meetingDir, "source"), { recursive: true });
  fs.mkdirSync(path.join(meetingDir, "converted"), { recursive: true });
  fs.mkdirSync(path.join(meetingDir, "report"), { recursive: true });
  fs.mkdirSync(path.join(meetingDir, "transcript"), { recursive: true });

  fs.writeFileSync(
    path.join(meetingDir, "meeting.json"),
    `${JSON.stringify({
      su_name: row.suName,
      since: row.since,
      until: row.until,
      payload,
      generated_at_utc: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(meetingDir, "video-resolution.json"),
    `${JSON.stringify(
      {
        meeting_id: payload.meeting_id || "",
        meeting_url: payload.meeting_url || "",
        source_video_urls: videoFromPayload,
        source_record_video_urls: videoFromMeetingRecord,
        resolved: videoResolved,
        generated_at_utc: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const prepPipelinePath = path.join(meetingDir, "run-meeting-pipeline.pya");
  fs.writeFileSync(prepPipelinePath, buildPipeline(meetingDir, { ...row, payload }), "utf8");

  log(`[meeting-ref] workspace: ${meetingDir}`);
  if (skipPrep) {
    log("[meeting-ref] skip prep-workspace (GREY_PIPELINE_SKIP_PREP=1)");
  } else {
    if (forcePrep || !hasWorkspacePrepCheckpoint(meetingDir)) {
      log("[meeting-ref] downloading agenda/minutes/audio");
      await runWithStreaming({
        cmd: RUN_BIN,
        args: [prepPipelinePath],
        cwd: PYASH_ROOT,
        timeoutMs: 6 * 60 * 60 * 1000,
        label: "prep-workspace",
      });
    } else {
      log("[meeting-ref] skip prep-workspace (checkpoint exists)");
    }
  }

  if (skipFull) {
    log("[meeting-ref] skip full pipeline (GREY_PIPELINE_SKIP_FULL=1)");
  } else {
    const transcriptDir = path.join(meetingDir, "transcript");
    if (!hasTranscriptAudio(transcriptDir)) {
      if (videoResolved.all.length) {
        throw new Error(
          `video sources were selected but no transcript audio was produced; refusing agenda-only fallback: ${videoResolved.all.join(", ")}`,
        );
      }
      log("[meeting-ref] no transcript audio; generating agenda preview artifacts");
      await writeAgendaPreviewArtifacts({
        meetingDir,
        row,
        payload,
        focus,
        jurisdiction,
        body,
        siteUrl,
        discussionUrl,
        basePrefix,
      });
    } else {
    log("[meeting-ref] running full transcript pipeline");
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(HOUSE_ROOT, "program/run-full-transcript-pipeline-from-meeting-folder.mjs"),
        meetingDir,
        basePrefix,
        focus,
        jurisdiction,
        body,
        siteUrl,
        discussionUrl,
      ],
      cwd: PYASH_ROOT,
      env: {
        PYA_COMMAND_TIMEOUT_MS: process.env.PYA_COMMAND_TIMEOUT_MS || "28800000",
      },
      timeoutMs: 8 * 60 * 60 * 1000,
      label: "full-pipeline",
    });
    }
  }

  const transcriptDir = path.join(meetingDir, "transcript");
  const payloadPath = path.join(transcriptDir, `${basePrefix}-normalized.lemmy-post.json`);
  log("[meeting-ref] done");
  log(`[meeting-ref] meeting_dir: ${meetingDir}`);
  log(`[meeting-ref] transcript_dir: ${transcriptDir}`);
  if (fs.existsSync(payloadPath)) {
    log(`[meeting-ref] payload: ${payloadPath}`);
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
