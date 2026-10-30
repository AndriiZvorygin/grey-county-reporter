#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPyaTextValues } from "../../../../command/pya_lookup.mjs";
import {
  buildSupportingAttachmentMirrorPlan,
  DEFAULT_ATTACHMENT_ENDPOINT,
  mirrorSupportingAttachments,
  rewriteSupportingAttachmentUrls,
} from "../../../../program/library/reporter_shared/supporting-attachment-mirror.mjs";

const DEFAULT_ENDPOINT = 'https://helpos.ca/api/helpos/v1/meeting-publish';
const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE = path.resolve(PROGRAM_DIR, "..");
const ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const SECRET_PATHS = [
  path.join(HOUSE, "configure/secret.pya"),
  path.join(ROOT, "configure/secret.pya"),
];
const SECRET_PATH = SECRET_PATHS.find((p) => fs.existsSync(p)) || SECRET_PATHS[0];
const SECRET_VALUES = readPyaTextValues(SECRET_PATH, [
  "meeting publish auth token",
  "grey county reporter username",
  "grey county reporter password",
  "meeting publish community name",
  "meeting publish site url",
]);

function parseDotEnvText(src) {
  const out = {};
  const lines = String(src || '').split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFileIfExists(filePath) {
  if (!filePath) return {};
  if (!fs.existsSync(filePath)) return {};
  return parseDotEnvText(fs.readFileSync(filePath, 'utf8'));
}

function loadEnvFallbacks(cwdDir) {
  const hereEnv = readEnvFileIfExists(path.join(cwdDir, '.env'));
  const repoRoot = path.resolve(cwdDir, '../../..');
  const rootEnv = readEnvFileIfExists(path.join(repoRoot, '.env'));
  return { ...rootEnv, ...hereEnv };
}

function usage() {
  return [
    'Usage: node program/publish-meeting-to-helpos-from-payload.mjs <lemmy_payload_json> [community_name] [idempotency_key] [post_ref] [extras_json] [dry_run]',
    'Examples:',
    '  node ... transcript/meeting-qwen-auto-normalized.lemmy-post.json greycounty',
    '  node ... transcript/...lemmy-post.json greycounty grey-county-county-council-2026-03-26-v2 https://lemmy.ca/post/3540',
  ].join('\n');
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'unknown';
}

function resolveMaybeRelative(baseDir, rawPath) {
  const p = String(rawPath || '').trim();
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}

function parsePostRef(postRefRaw) {
  const postRef = String(postRefRaw || '').trim();
  if (!postRef) return { post_id: '', post_url: '' };
  if (/^\d+$/u.test(postRef)) return { post_id: String(Number(postRef)), post_url: '' };
  if (/^https?:\/\//iu.test(postRef)) return { post_id: '', post_url: postRef };
  return { post_id: '', post_url: '' };
}

function buildIdempotencyKey({ jurisdiction, body, dateIso, postTitle, postBody, explicit }) {
  const ex = String(explicit || '').trim();
  if (ex) return ex;
  const base = `${slugify(jurisdiction)}-${slugify(body)}-${String(dateIso || '').trim() || 'unknown-date'}`;
  const digest = crypto
    .createHash('sha256')
    .update(`${String(postTitle || '')}\n${String(postBody || '')}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return `${base}-${digest}-v1`;
}

function extractCanonicalHref(html) {
  const m = String(html || '').match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/iu);
  return m ? String(m[1]).trim() : '';
}

function hasMetaDescription(html) {
  return /<meta\s+name=["']description["']\s+content=["'][^"']+["']/iu.test(String(html || ''));
}

function hasTitleTag(html) {
  return /<title>[\s\S]*?<\/title>/iu.test(String(html || ''));
}

function stripDisallowedTags(html) {
  let out = String(html || '');
  out = out.replace(/<script\b[\s\S]*?<\/script>/giu, '');
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/giu, '');
  out = out.replace(/<object\b[\s\S]*?<\/object>/giu, '');
  out = out.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/giu, '');
  return out;
}

function ensureDiscussionPlaceholder(html) {
  const src = String(html || '');
  if (src.includes('{{DISCUSSION_URL}}')) return src;

  const discussionAnchor = /(<section[^>]+id=["']discussion["'][\s\S]*?<a[^>]+href=["'])([^"']*)(["'])/iu;
  if (discussionAnchor.test(src)) {
    return src.replace(discussionAnchor, `$1{{DISCUSSION_URL}}$3`);
  }

  if (/<\/main>/iu.test(src)) {
    return src.replace(/<\/main>/iu, '<p><a href="{{DISCUSSION_URL}}">Discuss this meeting on HelpOS</a></p>\n</main>');
  }
  if (/<\/body>/iu.test(src)) {
    return src.replace(/<\/body>/iu, '<p><a href="{{DISCUSSION_URL}}">Discuss this meeting on HelpOS</a></p>\n</body>');
  }
  return `${src}\n<p><a href="{{DISCUSSION_URL}}">Discuss this meeting on HelpOS</a></p>\n`;
}

function parseExtras(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  if (txt.startsWith('@')) {
    const fp = path.resolve(process.cwd(), txt.slice(1));
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  return JSON.parse(txt);
}

function toAbsUrl(siteUrl, jurisdiction, body, dateIso) {
  return `${String(siteUrl || 'https://helpos.ca').replace(/\/+$/u, '')}/transcripts/${slugify(jurisdiction)}/${slugify(body)}/${dateIso}`;
}

async function main() {
  const payloadArg = process.argv[2];
  const communityArg = process.argv[3] || '';
  const idempotencyArg = process.argv[4] || '';
  const postRefArg = process.argv[5] || '';
  const extrasArg = process.argv[6] || '';
  const dryRunArg = process.argv[7] || '';

  if (!payloadArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const endpoint = String(process.env.MEETING_PUBLISH_ENDPOINT || DEFAULT_ENDPOINT).trim();
  const envFallback = loadEnvFallbacks(process.cwd());
  const token = String(
    process.env.MEETING_PUBLISH_AUTH_TOKEN
    || envFallback.MEETING_PUBLISH_AUTH_TOKEN
    || SECRET_VALUES["meeting publish auth token"]
    || ''
  ).trim();
  const dryRun = /^(1|true|yes)$/iu.test(String(process.env.MEETING_PUBLISH_DRY_RUN || dryRunArg || '0'));

  const payloadPath = path.resolve(process.cwd(), payloadArg);
  const payloadDir = path.dirname(payloadPath);
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

  const jurisdiction = String(payload?.jurisdiction || '').trim();
  const body = String(payload?.body || '').trim();
  const dateIso = String(payload?.date_iso || '').trim();
  const postTitle = String(payload?.title || '').trim();
  let postBody = String(payload?.body_markdown || '').trim();
  const communityName = String(
    process.env.MEETING_PUBLISH_COMMUNITY_NAME
    || envFallback.MEETING_PUBLISH_COMMUNITY_NAME
    || SECRET_VALUES["meeting publish community name"]
    || communityArg
    || payload?.community_name
    || ''
  ).trim();
  const siteUrl = String(
    process.env.MEETING_PUBLISH_SITE_URL
    || envFallback.MEETING_PUBLISH_SITE_URL
    || SECRET_VALUES["meeting publish site url"]
    || 'https://helpos.ca'
  ).trim();
  const publishUsername = String(
    process.env.MEETING_PUBLISH_USERNAME ||
    envFallback.MEETING_PUBLISH_USERNAME ||
    process.env.GREY_COUNTY_REPORTER_USERNAME ||
    envFallback.GREY_COUNTY_REPORTER_USERNAME ||
    SECRET_VALUES["grey county reporter username"] ||
    payload?.publish_username ||
    payload?.metadata?.publish_username ||
    ''
  ).trim();
  const publishPassword = String(
    process.env.MEETING_PUBLISH_PASSWORD ||
    envFallback.MEETING_PUBLISH_PASSWORD ||
    process.env.GREY_COUNTY_REPORTER_PASSWORD ||
    envFallback.GREY_COUNTY_REPORTER_PASSWORD ||
    SECRET_VALUES["grey county reporter password"] ||
    payload?.publish_password ||
    payload?.metadata?.publish_password ||
    ''
  ).trim();

  if (!jurisdiction || !body || !dateIso || !postTitle || !postBody) {
    throw new Error('payload missing required fields: jurisdiction/body/date_iso/title/body_markdown');
  }

  const postRefEnv = String(process.env.MEETING_PUBLISH_POST_REF || envFallback.MEETING_PUBLISH_POST_REF || '').trim();
  const parsedRef = parsePostRef(postRefEnv || postRefArg || payload?.post_id || payload?.post_url || '');
  const updateMode = Boolean(parsedRef.post_id || parsedRef.post_url);

  if (!updateMode && !communityName) {
    throw new Error('CREATE mode requires community_name (arg2 or MEETING_PUBLISH_COMMUNITY_NAME)');
  }

  const htmlSourcePath = resolveMaybeRelative(payloadDir, payload?.local_transcript_html);
  if (!htmlSourcePath || !fs.existsSync(htmlSourcePath)) {
    throw new Error(`transcript html not found: ${String(payload?.local_transcript_html || '')}`);
  }
  const imageSourcePath = resolveMaybeRelative(payloadDir, payload?.local_cover_image);

  let html = fs.readFileSync(htmlSourcePath, 'utf8');
  html = stripDisallowedTags(html);
  html = ensureDiscussionPlaceholder(html);

  if (!hasTitleTag(html)) throw new Error('transcript_html missing <title>');
  if (!hasMetaDescription(html)) throw new Error('transcript_html missing meta description');

  const expectedCanonical = toAbsUrl(siteUrl, jurisdiction, body, dateIso);
  const foundCanonical = extractCanonicalHref(html);
  if (!foundCanonical) throw new Error('transcript_html missing canonical link');
  if (foundCanonical !== expectedCanonical) {
    throw new Error(`canonical mismatch: found=${foundCanonical} expected=${expectedCanonical}`);
  }

  const attachmentIndexPath = resolveMaybeRelative(payloadDir, payload?.local_attachment_index);
  const sourceAttachments = Array.isArray(payload?.local_source_attachments) ? payload.local_source_attachments : [];
  const attachmentPlan = buildSupportingAttachmentMirrorPlan({ payloadDir, attachmentIndexPath, sourceAttachments });
  process.stdout.write(`[meeting-publish] supporting attachments: ${attachmentPlan.length}\n`);
  if (!dryRun && attachmentPlan.length) {
    if (!token) throw new Error('MEETING_PUBLISH_AUTH_TOKEN is required to mirror attachments');
    const mirrored = await mirrorSupportingAttachments({
      payloadDir,
      attachmentIndexPath,
      sourceAttachments,
      endpoint: String(
        process.env.ATTACHMENT_PUBLISH_ENDPOINT
        || envFallback.ATTACHMENT_PUBLISH_ENDPOINT
        || DEFAULT_ATTACHMENT_ENDPOINT
      ).trim(),
      token,
      jurisdiction,
      body,
      dateIso,
      responsePath: path.join(
        payloadDir,
        `${path.basename(payloadPath, path.extname(payloadPath))}.supporting-attachments.mirror.response.json`,
      ),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    postBody = rewriteSupportingAttachmentUrls(postBody, mirrored.mapping);
    html = rewriteSupportingAttachmentUrls(html, mirrored.mapping);
    const survivors = attachmentPlan
      .map((entry) => entry.sourceUrl)
      .filter((sourceUrl) => postBody.includes(sourceUrl) || html.includes(sourceUrl));
    if (survivors.length) {
      throw new Error(`official supporting attachment URLs survived mirror rewrite: ${survivors.join(', ')}`);
    }
  }

  const idempotencyKey = buildIdempotencyKey({
    jurisdiction,
    body,
    dateIso,
    postTitle,
    postBody,
    explicit: process.env.MEETING_PUBLISH_IDEMPOTENCY_KEY || envFallback.MEETING_PUBLISH_IDEMPOTENCY_KEY || idempotencyArg,
  });

  const uploadHtmlPath = path.join(payloadDir, `${path.basename(htmlSourcePath, path.extname(htmlSourcePath))}.meeting-publish.html`);
  fs.writeFileSync(uploadHtmlPath, html, 'utf8');

  const metadata = {
    idempotency_key: idempotencyKey,
    jurisdiction: slugify(jurisdiction),
    body: slugify(body),
    date_iso: dateIso,
    post_title: postTitle,
    post_body: postBody,
  };
  if (communityName) metadata.community_name = communityName;
  if (parsedRef.post_id) metadata.post_id = parsedRef.post_id;
  if (parsedRef.post_url) metadata.post_url = parsedRef.post_url;
  if (publishUsername) metadata.publish_username = publishUsername;
  if (publishPassword) metadata.publish_password = publishPassword;

  const extras = parseExtras(process.env.MEETING_PUBLISH_EXTRAS_JSON || envFallback.MEETING_PUBLISH_EXTRAS_JSON || extrasArg);

  process.stdout.write(`[meeting-publish] mode: ${updateMode ? 'UPDATE' : 'CREATE'}\n`);
  process.stdout.write(`[meeting-publish] endpoint: ${endpoint}\n`);
  process.stdout.write(`[meeting-publish] transcript_html: ${uploadHtmlPath}\n`);
  if (imageSourcePath && fs.existsSync(imageSourcePath)) {
    process.stdout.write(`[meeting-publish] cover_image: ${imageSourcePath}\n`);
  } else {
    process.stdout.write('[meeting-publish] cover_image: (none)\n');
  }
  process.stdout.write(`[meeting-publish] idempotency_key: ${idempotencyKey}\n`);
  process.stdout.write(`[meeting-publish] publish_username: ${publishUsername ? publishUsername : '(none)'}\n`);
  process.stdout.write(`[meeting-publish] publish_password: ${publishPassword ? '(set)' : '(none)'}\n`);

  if (dryRun) {
    process.stdout.write('[meeting-publish] dry-run enabled, request not sent.\n');
    process.exit(0);
  }
  if (!token) throw new Error('MEETING_PUBLISH_AUTH_TOKEN is required unless dry-run');

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('transcript_html', new Blob([html], { type: 'text/html; charset=utf-8' }), path.basename(uploadHtmlPath));

  if (imageSourcePath && fs.existsSync(imageSourcePath)) {
    const imageBuf = fs.readFileSync(imageSourcePath);
    const ext = path.extname(imageSourcePath).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream');
    form.append('cover_image', new Blob([imageBuf], { type: contentType }), path.basename(imageSourcePath));
  }

  if (extras) {
    form.append('extras_json', JSON.stringify(extras));
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });

  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}

  const responsePath = path.join(payloadDir, `${path.basename(payloadPath, path.extname(payloadPath))}.meeting-publish.response.json`);
  fs.writeFileSync(responsePath, `${parsed ? JSON.stringify(parsed, null, 2) : raw}\n`, 'utf8');
  process.stdout.write(`[meeting-publish] response saved: ${responsePath}\n`);

  if (!res.ok) {
    throw new Error(`meeting-publish failed (${res.status}): ${raw.slice(0, 1200)}`);
  }

  if (parsed && typeof parsed === 'object') {
    if (parsed.post_url) process.stdout.write(`[meeting-publish] post_url: ${parsed.post_url}\n`);
    if (parsed.transcript_url) process.stdout.write(`[meeting-publish] transcript_url: ${parsed.transcript_url}\n`);
    if (typeof parsed.idempotent_replay === 'boolean') {
      process.stdout.write(`[meeting-publish] idempotent_replay: ${String(parsed.idempotent_replay)}\n`);
    }
  } else {
    process.stdout.write(`[meeting-publish] response: ${raw.slice(0, 600)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
