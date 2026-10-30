const tokens = (value) => String(value || "").toLowerCase().match(/[a-z0-9]+/gu) || [];
const proseKey = (value) => tokens(value).join(" ");

function agendaCode(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\.$/u, "");
}

export function agendaSectionItemCode(value = "") {
  return agendaCode(String(value || "").match(/^([0-9]+(?:\.[a-z])?|[a-z])\.?(?:\s|$)/iu)?.[1] || "");
}

function agendaSectionTitleKey(value = "") {
  const text = String(value || "");
  const codePrefix = text.match(/^(?:[0-9]+(?:\.[a-z])?|[a-z])\.(?:\s+|$)|^(?:[0-9]+(?:\.[a-z])?|[a-z])\s+/iu)?.[0] || "";
  return proseKey(text.slice(codePrefix.length));
}

export function findAgendaStage3Section(sections = [], item = {}) {
  const itemCode = agendaCode(item?.item);
  const candidates = (Array.isArray(sections) ? sections : [])
    .filter((section) => agendaSectionItemCode(section?.heading) === itemCode);
  if (!candidates.length) return null;
  const itemTitle = agendaSectionTitleKey(item?.title);
  return candidates.find((section) => agendaSectionTitleKey(section?.heading) === itemTitle)
    || (candidates.length === 1 ? candidates[0] : null);
}

export function hasCompleteAgendaStage3Checkpoint(sections = [], items = []) {
  if (!items.length) return true;
  return items.every((item) => {
    const sourceWordCount = Number(item?.source_word_count || 0);
    const substantive = Boolean(item?.substantive) || sourceWordCount >= 80;
    const longSource = typeof item?.long_source === "boolean" ? item.long_source : sourceWordCount >= 700;
    const section = findAgendaStage3Section(sections, item);
    const summary = String(section?.summary || "").trim();
    const chapters = Array.isArray(section?.chapters) ? section.chapters : [];
    if (!section || !summary) return false;
    if (longSource && substantive && !Boolean(item?.procedural) && !chapters.length) return false;
    const seenTitles = new Set();
    const seenSummaries = new Set();
    for (const chapter of chapters) {
      const title = String(chapter?.title || "").trim();
      const text = String(chapter?.summary || chapter?.text || "").trim();
      if (!title || !text) return false;
      const titleKey = proseKey(title);
      const summaryKey = proseKey(text);
      if (seenTitles.has(titleKey) || seenSummaries.has(summaryKey)) return false;
      seenTitles.add(titleKey);
      seenSummaries.add(summaryKey);
    }
    return true;
  });
}

export function resemblesOpeningFragment(summary = "", source = "") {
  const summaryTokens = tokens(summary).slice(0, 18);
  const sourceTokens = tokens(source).slice(0, 80);
  if (summaryTokens.length < 10 || sourceTokens.length < 10) return false;
  return sourceTokens.join(" ").includes(summaryTokens.slice(0, Math.min(14, summaryTokens.length)).join(" "));
}

export function assertAgendaPublishable(items = []) {
  for (const item of items) {
    const attachmentBacked = Array.isArray(item.attachments) && item.attachments.length > 0;
    const summary = String(item.agenda_section_summary || "").trim();
    const chapters = Array.isArray(item.stage3_chapters) ? item.stage3_chapters : [];
    if (attachmentBacked && item.substantive && !summary) {
      throw new Error(`publish gate: substantive attachment-backed agenda item ${item.item} has no Stage 3 summary`);
    }
    if (item.substantive && !summary) throw new Error(`publish gate: substantive agenda item ${item.item} has no Stage 3 summary`);
    if (item.substantive && resemblesOpeningFragment(summary, item.source_text)) {
      throw new Error(`publish gate: Stage 3 summary for agenda item ${item.item} resembles an extractive opening-fragment fallback`);
    }
    if (item.long_source && item.substantive && !item.procedural && chapters.length === 0) {
      throw new Error(`publish gate: long agenda item ${item.item} has no Stage 3 child summaries`);
    }
    const seenTitles = new Set();
    const seenSummaries = new Set();
    for (const [index, chapter] of chapters.entries()) {
      const title = String(chapter?.title || "").trim();
      const text = String(chapter?.summary || chapter?.text || "").trim();
      if (!title || !text) {
        throw new Error(`publish gate: agenda item ${item.item} has an empty Stage 3 child summary at index ${index + 1}`);
      }
      const titleKey = proseKey(title);
      const summaryKey = proseKey(text);
      if (seenTitles.has(titleKey) || seenSummaries.has(summaryKey)) {
        throw new Error(`publish gate: agenda item ${item.item} has duplicate child summaries`);
      }
      seenTitles.add(titleKey);
      seenSummaries.add(summaryKey);
    }
  }
}
