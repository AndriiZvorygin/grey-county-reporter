import fs from "node:fs";
import path from "node:path";

export function existsArtifact(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function loadJsonArtifact(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJsonArtifact(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizePyaName(key) {
  return String(key || "")
    .replace(/[^a-z0-9_ ]/giu, " ")
    .replace(/_/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function toPyaTextValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}

export function savePyaReportArtifact(filePath, payload, {
  rootName = "run report",
} = {}) {
  const lines = [];
  lines.push(`su name ${normalizePyaName(rootName)} be map def`);
  const obj = payload && typeof payload === "object" ? payload : {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = normalizePyaName(rawKey);
    if (!key) continue;
    const text = JSON.stringify(toPyaTextValue(rawValue));
    lines.push(`exists su name ${key} ob text ${text} ya`);
  }
  lines.push("prah");
  lines.push("");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

export function collectArtifactStates(artifactPaths = []) {
  return artifactPaths.map((p) => {
    const filePath = String(p || "");
    if (!filePath) return { path: filePath, exists: false };
    try {
      const st = fs.statSync(filePath);
      return {
        path: filePath,
        exists: st.isFile(),
        size_bytes: Number(st.size || 0),
        mtime_ms: Number(st.mtimeMs || 0),
      };
    } catch {
      return { path: filePath, exists: false };
    }
  });
}

export function buildGreyTranscriptArtifacts({ transcriptDir, basePrefix }) {
  const normPrefix = `${basePrefix}-normalized`;
  const canonicalStage = {
    agenda_gross_chunks_pya: path.join(transcriptDir, `${normPrefix}.agenda.gross-chunks.pya`),
    agenda_matches_pya: path.join(transcriptDir, `${normPrefix}.agenda.matches.pya`),
    agenda_wise_series_pya: path.join(transcriptDir, `${normPrefix}.agenda-wise.series.pya`),
    agenda_section_grounding_pya: path.join(transcriptDir, `${normPrefix}.agenda.section-grounding.pya`),
    agenda_summary_pya: path.join(transcriptDir, `${normPrefix}.agenda-summary.pya`),
  };
  return {
    base_prefix: basePrefix,
    normalized_prefix: normPrefix,
    base_timing_srt: path.join(transcriptDir, `${basePrefix}.timing.srt`),
    base_plain_txt: path.join(transcriptDir, `${basePrefix}.plain.txt`),
    base_merged_srt: path.join(transcriptDir, `${basePrefix}.merged.srt`),
    normalized_plain_txt: path.join(transcriptDir, `${normPrefix}.plain.txt`),
    normalized_meta_json: path.join(transcriptDir, `${normPrefix}.normalize.metadata.json`),
    normalized_sentence_merged_srt: path.join(transcriptDir, `${normPrefix}.sentences.merged.srt`),
    speaker_json: path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentences.json`),
    speaker_srt: path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentence.srt`),
    autoassign_report_json: path.join(transcriptDir, `${normPrefix}.sentences.speaker.autoassign.report.json`),
    ...canonicalStage,
    meeting_summary_md: path.join(transcriptDir, `${normPrefix}.meeting-summary.md`),
    meeting_hook_txt: path.join(transcriptDir, `${normPrefix}.meeting-hook.txt`),
    transcript_html: path.join(transcriptDir, "transcript-page.html"),
    cover_image: path.join(transcriptDir, `${normPrefix}.meeting-cover.png`),
    cover_image_stable: path.join(transcriptDir, "meeting-cover.png"),
    lemmy_payload_json: path.join(transcriptDir, `${normPrefix}.lemmy-post.json`),
    lemmy_post_md: path.join(transcriptDir, `${normPrefix}.lemmy-post.md`),
    full_pipeline_report_pya: path.join(transcriptDir, `${normPrefix}.full-pipeline.report.pya`),
    // Legacy JSON stage artifacts are intentionally outside canonical flow.
    legacy_stage_json: {
      agenda_matches_json: path.join(transcriptDir, `${normPrefix}.agenda.matches.json`),
      agenda_summary_json: path.join(transcriptDir, `${normPrefix}.agenda-summary.json`),
    },
  };
}
