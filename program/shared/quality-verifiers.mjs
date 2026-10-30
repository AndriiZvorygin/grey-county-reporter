import fs from "node:fs";
import { readPyaTextValues } from "../../../../../command/pya_lookup.mjs";

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function safeJsonFromText(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return {};
  }
}

function readAgendaSummarySectionsFromPya(filePath) {
  const values = readPyaTextValues(filePath, ["sections"]);
  const raw = String(values.sections || "").trim();
  if (!raw) return [];
  const parsed = safeJsonFromText(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function words(text) {
  return String(text || "").split(/\s+/u).filter(Boolean).length;
}

export function verifyRequiredSections({ meetingSummaryMdPath = "", agendaSummaryPyaPath = "" } = {}) {
  const issues = [];
  const md = safeRead(meetingSummaryMdPath);
  const requiredHeadings = [
    "# Whole Meeting Summary",
    "## Top Newsworthy Developments",
    "## Why It Matters",
    "## Watch Next",
  ];
  for (const h of requiredHeadings) {
    if (!md.includes(h)) issues.push({ level: "error", code: "missing_heading", detail: h });
  }
  const sections = readAgendaSummarySectionsFromPya(agendaSummaryPyaPath);
  if (!sections.length) {
    issues.push({ level: "error", code: "missing_agenda_sections", detail: "agenda-summary sections missing" });
  }
  return {
    ok: !issues.some((x) => x.level === "error"),
    issues,
    metrics: {
      required_headings: requiredHeadings.length,
      agenda_sections: sections.length,
    },
  };
}

export function verifyTruncation({ meetingSummaryMdPath = "", agendaSummaryPyaPath = "" } = {}) {
  const issues = [];
  const md = safeRead(meetingSummaryMdPath);
  const sections = readAgendaSummarySectionsFromPya(agendaSummaryPyaPath);

  const mdLines = md.split(/\r?\n/u);
  const ellipsisLines = mdLines.filter((l) => /\.\.\.\s*$/u.test(String(l).trim()));
  if (ellipsisLines.length) {
    issues.push({ level: "warn", code: "ellipsis_tail", detail: `meeting-summary lines ending with ellipsis: ${ellipsisLines.length}` });
  }

  const brokenBullets = mdLines.filter((l) => /^\s*[-*]\s+$/u.test(l));
  if (brokenBullets.length) {
    issues.push({ level: "warn", code: "broken_bullets", detail: `empty bullet lines: ${brokenBullets.length}` });
  }

  let agendaEllipsis = 0;
  for (const s of sections) {
    const t = String(s?.summary || "").trim();
    if (/\.\.\.\s*$/u.test(t)) agendaEllipsis += 1;
  }
  if (agendaEllipsis > 0) {
    issues.push({ level: "warn", code: "agenda_ellipsis", detail: `agenda summaries ending with ellipsis: ${agendaEllipsis}` });
  }

  return {
    ok: !issues.some((x) => x.level === "error"),
    issues,
    metrics: {
      meeting_ellipsis_lines: ellipsisLines.length,
      broken_bullets: brokenBullets.length,
      agenda_ellipsis_summaries: agendaEllipsis,
    },
  };
}

export function verifyTense({ meetingSummaryMdPath = "", mode = "standard" } = {}) {
  const issues = [];
  const md = safeRead(meetingSummaryMdPath).toLowerCase();
  const pastHits = (md.match(/\b(was|were|voted|approved|presented|convened|held)\b/gu) || []).length;
  const futureHits = (md.match(/\b(will|upcoming|is expected|scheduled to|next meeting)\b/gu) || []).length;
  const wc = Math.max(1, words(md));

  if (mode === "upcoming") {
    if (pastHits > futureHits * 2 && pastHits > 8) {
      issues.push({ level: "warn", code: "past_tense_bias_in_upcoming", detail: `past=${pastHits} future=${futureHits}` });
    }
  } else {
    if (futureHits > pastHits * 1.5 && futureHits > 8) {
      issues.push({ level: "warn", code: "future_tense_bias_in_past_report", detail: `past=${pastHits} future=${futureHits}` });
    }
  }

  return {
    ok: true,
    issues,
    metrics: {
      mode,
      words: wc,
      past_hits: pastHits,
      future_hits: futureHits,
    },
  };
}

export function verifyIdentityScoping({
  meetingSummaryMdPath = "",
  writer = "",
  source = "",
  jurisdiction = "",
  body = "",
} = {}) {
  const issues = [];
  const md = safeRead(meetingSummaryMdPath);
  const text = md.toLowerCase();
  const j = String(jurisdiction || "").toLowerCase();

  if (writer.includes("grey") && /owen\s+sound/iu.test(text)) {
    issues.push({ level: "warn", code: "cross_writer_term", detail: "found 'Owen Sound' in Grey writer output" });
  }
  if (writer.includes("owen") && /grey\s+county/iu.test(text)) {
    issues.push({ level: "warn", code: "cross_writer_term", detail: "found 'Grey County' in Owen writer output" });
  }
  if (j.includes("grey") && /city\s+of\s+owen\s+sound/iu.test(text)) {
    issues.push({ level: "warn", code: "jurisdiction_bleed", detail: "found City of Owen Sound in Grey county summary" });
  }
  if (String(body || "").toLowerCase().includes("committee") && /county\s+council\s+meeting/iu.test(text)) {
    issues.push({ level: "warn", code: "body_label_bleed", detail: "meeting summary mentions county council meeting while configured body is committee" });
  }

  return {
    ok: !issues.some((x) => x.level === "error"),
    issues,
    metrics: {
      writer,
      source,
      jurisdiction,
      body,
    },
  };
}

export function runQualityVerifiers(args = {}) {
  const required = verifyRequiredSections(args);
  const truncation = verifyTruncation(args);
  const tense = verifyTense(args);
  const identity = verifyIdentityScoping(args);

  const checks = { required_sections: required, truncation, tense, identity_scoping: identity };
  const allIssues = Object.entries(checks).flatMap(([name, v]) =>
    (v.issues || []).map((it) => ({ check: name, ...it }))
  );

  const hasError = allIssues.some((x) => x.level === "error");
  const hasWarn = allIssues.some((x) => x.level === "warn");
  return {
    checks,
    issues: allIssues,
    summary: {
      has_error: hasError,
      has_warn: hasWarn,
      issue_count: allIssues.length,
    },
  };
}
