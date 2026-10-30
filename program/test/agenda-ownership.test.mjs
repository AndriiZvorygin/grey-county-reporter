import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCanonicalSourceBundles, parseCanonicalAgendaHtml, readCachedPdfText, reconcileCombinedPackage } from "../extract-escribe-agenda-items.mjs";
import {
  agendaSectionItemCode,
  assertAgendaPublishable,
  findAgendaStage3Section,
  hasCompleteAgendaStage3Checkpoint,
} from "../shared/agenda-publish-gate.mjs";
import {
  extractNativePageText,
  extractHybridPdfText,
  isPaginationOnlyPageText,
} from "../../../../../program/library/reporter_shared/hybrid-pdf-text.mjs";
import {
  pickRichestAgendaMarkdownPathFromConvertedDir,
  pickRichestAgendaPdfPathFromSourceDir,
} from "../../../../../program/library/agenda_preview_shared.mjs";
import { execFileSync } from "node:child_process";

const long = (label, count = 100) => Array.from({ length: count }, (_, i) => `${label} detail ${i + 1}`).join(" ");

const july13Html = `
<div class='AgendaItem AgendaItem401'>
  <div class='AgendaItemCounter'>4.c</div><div class='AgendaItemTitle'><a>Minutes of the June 23, 2026 Council Meeting</a></div>
</div>
<div class='AgendaItemDescription AgendaItemDescription401'>Council will consider the June 23 minutes.</div>
<div class='AgendaItemAttachment AgendaItemAttachment401'><a class='Link' href='/minutes-june-23.pdf'><span>June 23 Minutes PDF</span></a></div>
<div class='AgendaItem AgendaItem701'>
  <div class='AgendaItemCounter'>7.a</div><div class='AgendaItemTitle'><a>Glassworks Employment Lands Review</a></div>
</div>
<div class='AgendaItemDescription AgendaItemDescription701'>${long("Glassworks", 120)}</div>
<div class='AgendaItemAttachment AgendaItemAttachment701'><a class='Link' href='/glassworks-housing.pdf'><span>Affordable Ownership Housing</span></a></div>
<div class='AgendaItemAttachment AgendaItemAttachment701'><a class='Link' href='/glassworks-planning.pdf'><span>Planning Justification</span></a></div>
<div class='AgendaItemAttachment AgendaItemAttachment701'><a class='Link' href='/glassworks-capacity.pdf'><span>Employment Capacity</span></a></div>
<div class='AgendaItem AgendaItem800'>
  <div class='AgendaItemCounter'>8</div><div class='AgendaItemTitle'><a>Public Forum</a></div>
</div>`;

const malformedPackage = `
Pages
4.c
Minutes of the June 23, 2026 Council Meeting
7.a
Glassworks Employment Lands Review
8
Public Forum
74
Page 74 of 120
4.c Minutes of the June 23, 2026 Council Meeting
June 23 minutes decisions and recommendations.
Page 75 of 120
7.a Glassworks Employment Lands Review
Affordable ownership housing and employment-land conversion.
Planning justification and employment capacity analysis.
Page 115 of 120
8 Public Forum
Members of the public may address council.
`;

test("structured HTML supplies canonical July 13 identity, order, and attachment ownership", () => {
  const items = parseCanonicalAgendaHtml(july13Html, { baseUrl: "https://pub-owensound.escribemeetings.com/Meeting.aspx?Id=1" });
  assert.deepEqual(items.map(({ item, title }) => [item, title]), [
    ["4.c", "Minutes of the June 23, 2026 Council Meeting"],
    ["7.a", "Glassworks Employment Lands Review"],
    ["8", "Public Forum"],
  ]);
  assert.equal(items[0].attachments.length, 1);
  assert.equal(items[1].attachments.length, 3);
  assert.equal(items[2].attachments.length, 0);
  assert.equal(items[0].attachments[0].url, "https://pub-owensound.escribemeetings.com/minutes-june-23.pdf");
});

test("agenda selectors accept eScribe cover-labelled agenda files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-cover-selector-"));
  const converted = path.join(root, "converted");
  const source = path.join(root, "source");
  fs.mkdirSync(converted);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(converted, "agenda-cover-01.md"), "complete agenda\n", "utf8");
  fs.writeFileSync(path.join(source, "agenda-cover-01.pdf"), "pdf\n", "utf8");
  assert.equal(pickRichestAgendaMarkdownPathFromConvertedDir(converted), path.join(converted, "agenda-cover-01.md"));
  assert.equal(pickRichestAgendaPdfPathFromSourceDir(source), path.join(source, "agenda-cover-01.pdf"));
});

test("legacy agenda extraction preserves top-level item codes when no structured HTML is present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-parent-code-"));
  const input = path.join(root, "agenda.md");
  const outputDir = path.join(root, "subreports");
  const indexPath = path.join(root, "subreports.index.json");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(input, [
    "Pages",
    "1.", "Call to Order",
    "4.", "Delegations",
    "4.a", "Keystone Funding",
    "8.", "Closed Meeting Matters",
    "Page 2 of 2",
    "4.a Keystone Funding discussion",
  ].join("\n"), "utf8");
  execFileSync(process.execPath, [
    "/home/htaf/pyash/command/extract_escribe_subreports.mjs",
    input,
    outputDir,
    indexPath,
  ], { stdio: "ignore" });
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(index.items.map((row) => row.item), ["1", "4", "4.a", "8"]);
  assert.equal(index.items.find((row) => row.item === "4").title, "Delegations");
});

test("direct attachments outrank malformed combined-package ranges", async () => {
  const canonical = parseCanonicalAgendaHtml(july13Html, { baseUrl: "https://pub-owensound.escribemeetings.com/" });
  const reconciled = reconcileCombinedPackage(canonical, malformedPackage);
  assert.equal(reconciled.find((x) => x.item === "4.c").package_text, "");
  assert.equal(reconciled.find((x) => x.item === "7.a").package_text, "");
  assert.match(reconciled.find((x) => x.item === "8").package_text, /Public Forum/u);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-owner-"));
  const bundles = await buildCanonicalSourceBundles({ canonicalItems: canonical, packageMarkdown: malformedPackage, outputDir, downloadAttachments: false });
  const minutesText = fs.readFileSync(bundles.find((x) => x.item === "4.c").file, "utf8");
  assert.doesNotMatch(minutesText, /Glassworks|affordable ownership|employment capacity/iu);
  assert.deepEqual(bundles.find((x) => x.item === "7.a").attachments.map((x) => x.label), [
    "Affordable Ownership Housing", "Planning Justification", "Employment Capacity",
  ]);
});

test("canonical attachment extraction reuses a newer validated text cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-attachment-cache-"));
  const outputDir = path.join(root, "subreports");
  const attachmentDir = path.join(outputDir, "_attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  const pdfPath = path.join(attachmentDir, "1-1-report-pdf.pdf");
  const textPath = path.join(attachmentDir, "1-1-report-pdf.txt");
  fs.writeFileSync(pdfPath, "%PDF-1.7\nplaceholder", "ascii");
  fs.writeFileSync(textPath, "The cached report contains enough source words to be reused safely without reprocessing the original PDF attachment.", "utf8");
  assert.match(readCachedPdfText(pdfPath, textPath), /cached report contains enough source words/u);

  const bundles = await buildCanonicalSourceBundles({
    canonicalItems: [{
      item: "1",
      title: "Report",
      description: "",
      order: 0,
      attachments: [{ label: "Report PDF", url: "https://example.test/report.pdf" }],
    }],
    outputDir,
  });

  assert.equal(bundles[0].attachment_diagnostics[0].cached, true);
  assert.match(fs.readFileSync(bundles[0].file, "utf8"), /cached report contains enough source words/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("publish gate rejects empty overview and missing children for substantive long reports", () => {
  assert.throws(() => assertAgendaPublishable([{ item: "7.a", substantive: true, long_source: true, attachments: [{}], agenda_section_summary: "", stage3_chapters: [] }]), /no Stage 3 summary/u);
  assert.throws(() => assertAgendaPublishable([{ item: "7.a", substantive: true, long_source: true, attachments: [{}], agenda_section_summary: "Council will consider housing and employment land policy tradeoffs in the Glassworks proposal.", source_text: long("source"), stage3_chapters: [] }]), /no Stage 3 child summaries/u);
  assert.doesNotThrow(() => assertAgendaPublishable([{ item: "7.a", substantive: true, long_source: true, attachments: [{}], agenda_section_summary: "Council will consider housing and employment land policy tradeoffs in the Glassworks proposal.", source_text: long("source"), stage3_chapters: [
    { title: "Affordable ownership housing", text: "The proposal describes an affordable home-ownership component." },
    { title: "Employment-land conversion", text: "The report evaluates conversion of designated employment land." },
    { title: "Planning justification", text: "Planning analysis tests the proposal against applicable policy." },
    { title: "Employment capacity", text: "Capacity analysis considers the remaining employment land supply." },
  ] }]));
});

test("publish gate rejects duplicate Stage 3 child prose", () => {
  assert.throws(() => assertAgendaPublishable([{
    item: "7.a",
    substantive: true,
    long_source: true,
    attachments: [{}],
    agenda_section_summary: "The report presents the complete pilot programme.",
    source_text: long("source"),
    stage3_chapters: [
      { title: "Programme operations", text: "The team provided outreach and de-escalation support." },
      { title: "Community outcomes", text: "The team provided outreach and de-escalation support." },
    ],
  }]), /duplicate child summaries/u);
});

test("Stage 3 reuse requires complete child summaries for current long agenda items", () => {
  assert.equal(agendaSectionItemCode("a Accessibility strategy"), "a");
  const items = [{ item: "a", title: "Accessibility strategy", substantive: true, long_source: true }];
  assert.equal(hasCompleteAgendaStage3Checkpoint([
    { heading: "a Accessibility strategy", summary: "The committee will review the accessibility strategy.", chapters: [] },
  ], items), false);
  assert.equal(hasCompleteAgendaStage3Checkpoint([
    {
      heading: "a Accessibility strategy",
      summary: "The committee will review the accessibility strategy.",
      chapters: [{ title: "Current barriers", summary: "The agenda identifies current barriers and proposed responses." }],
    },
  ], items), true);
  assert.equal(findAgendaStage3Section([
    { heading: "a First report", summary: "First", chapters: [{ title: "One", summary: "One" }] },
    { heading: "a Second report", summary: "Second", chapters: [] },
  ], { item: "a", title: "First report" })?.heading, "a First report");
});

test("mixed PDFs recover scan-only trailing pages instead of silently truncating them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pdf-text-"));
  const ps = path.join(root, "mixed.ps");
  const pdf = path.join(root, "mixed.pdf");
  const output = path.join(root, "mixed.txt");
  fs.writeFileSync(ps, [
    "%!PS", "/Helvetica findfont 12 scalefont setfont", "72 720 moveto",
    "(Cover letter says the attached resolution follows.) show", "showpage", "showpage",
  ].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const previous = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({
    2: "Resolution No. 2026-0104 asks Ontario to regulate the sale and distribution of invasive plants.",
  });
  try {
    const result = await extractHybridPdfText({ pdfPath: pdf, textPath: output, minimumNativeWords: 4 });
    assert.deepEqual(result.ocrPages, [2]);
    assert.equal(result.totalPages, 2);
    assert.match(fs.readFileSync(output, "utf8"), /regulate the sale and distribution of invasive plants/u);
  } finally {
    if (previous === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = previous;
  }
});

test("scan-only page OCR retries an empty qwen response before failing extraction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pdf-retry-"));
  const ps = path.join(root, "scan.ps");
  const pdf = path.join(root, "scan.pdf");
  fs.writeFileSync(ps, ["%!PS", "showpage"].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const previous = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({
    1: {
      responses: [
        "",
        "Resolution No. 2026-0104 asks Ontario to regulate the sale and distribution of invasive plants.",
      ],
    },
  });
  try {
    const result = await extractHybridPdfText({ pdfPath: pdf, minimumNativeWords: 4 });
    assert.deepEqual(result.ocrPages, [1]);
    assert.match(result.text, /regulate the sale and distribution of invasive plants/u);
  } finally {
    if (previous === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = previous;
  }
});

test("short native title page is retained only after repeated visual transcription agreement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pdf-short-native-"));
  const ps = path.join(root, "title.ps");
  const pdf = path.join(root, "title.pdf");
  fs.writeFileSync(ps, [
    "%!PS", "/Helvetica findfont 20 scalefont setfont", "72 720 moveto",
    "(Pedestrian Infrastructure Opportunities) show", "showpage",
  ].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const previous = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({
    1: { responses: [
      "Pedestrian Infrastructure Opportunities",
      "Pedestrian Infrastructure Opportunities",
    ] },
  });
  try {
    const result = await extractHybridPdfText({ pdfPath: pdf });
    assert.match(result.text, /Pedestrian Infrastructure Opportunities/u);
    assert.deepEqual(result.verifiedShortNativePages, [1]);
    assert.deepEqual(result.ocrPages, []);
  } finally {
    if (previous === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = previous;
  }
});

test("mixed short-native pages get bounded varied qwen retries before failing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pdf-varied-retry-"));
  const ps = path.join(root, "title.ps");
  const pdf = path.join(root, "title.pdf");
  fs.writeFileSync(ps, [
    "%!PS", "/Helvetica findfont 20 scalefont setfont", "72 720 moveto",
    "(Questions?) show", "showpage",
  ].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const previousFixture = process.env.PDF_OCR_QWEN_FIXTURE;
  const previousAttempts = process.env.PDF_OCR_QWEN_ATTEMPTS;
  process.env.PDF_OCR_QWEN_ATTEMPTS = "4";
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({
    1: { responses: ["", "", "", "Questions? Please contact staff"] },
  });
  try {
    const result = await extractHybridPdfText({ pdfPath: pdf });
    assert.deepEqual(result.verifiedShortNativePages, []);
    assert.deepEqual(result.ocrPages, [1]);
    assert.match(result.text, /Questions\? Please contact staff/u);
  } finally {
    if (previousFixture === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = previousFixture;
    if (previousAttempts === undefined) delete process.env.PDF_OCR_QWEN_ATTEMPTS;
    else process.env.PDF_OCR_QWEN_ATTEMPTS = previousAttempts;
  }
});

test("repeated short OCR may extend matching native text without accepting an ungrounded fragment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pdf-short-agreement-"));
  const ps = path.join(root, "title.ps");
  const pdf = path.join(root, "title.pdf");
  fs.writeFileSync(ps, [
    "%!PS", "/Helvetica findfont 20 scalefont setfont", "72 720 moveto",
    "(Questions?) show", "showpage",
  ].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const previousFixture = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({
    1: { responses: ["Questions? N", "Questions? N"] },
  });
  try {
    const result = await extractHybridPdfText({ pdfPath: pdf });
    assert.deepEqual(result.verifiedShortNativePages, [1]);
    assert.deepEqual(result.ocrPages, []);
    assert.match(result.text, /Questions\? N/u);
  } finally {
    if (previousFixture === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = previousFixture;
  }
});

test("short OCR without native text remains retryable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-pdf-short-scan-"));
  const ps = path.join(root, "scan.ps");
  const pdf = path.join(root, "scan.pdf");
  fs.writeFileSync(ps, ["%!PS", "showpage"].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const previous = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({ 1: "Three scanned words" });
  try {
    await assert.rejects(() => extractHybridPdfText({ pdfPath: pdf }), /no usable transcription/u);
  } finally {
    if (previous === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = previous;
  }
});

test("pagination-only PDF pages are content-free rather than failed OCR", () => {
  assert.equal(isPaginationOnlyPageText("5", 5, 5), true);
  assert.equal(isPaginationOnlyPageText("Page 5 of 5", 5, 5), true);
  assert.equal(isPaginationOnlyPageText("5 Budget recommendation", 5, 5), false);
  assert.equal(isPaginationOnlyPageText("4", 5, 5), false);
});

test("native PDF page extraction retries a transient process termination", () => {
  let calls = 0;
  const text = extractNativePageText("/tmp/attachment.pdf", 3, {
    run: () => {
      calls += 1;
      return calls === 1
        ? { status: null, signal: "SIGTERM", error: new Error("timed out") }
        : { status: 0, stdout: "Report text from the recovered page" };
    },
  });
  assert.equal(text, "Report text from the recovered page");
  assert.equal(calls, 2);
});
