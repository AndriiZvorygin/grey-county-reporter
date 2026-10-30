# Grey County Reporter: Publishing to Helpos/Lemmy

## Objective

Publish one complete meeting package:
1. transcript HTML page
2. Lemmy post title/body
3. optional cover image

Use the transcript endpoint (`meeting-publish`) so create/update is idempotent.

## Endpoint

- `POST https://helpos.ca/api/helpos/v1/meeting-publish`
- auth header: `Authorization: Bearer <MEETING_PUBLISH_AUTH_TOKEN>`
- content type: `multipart/form-data`

## Multipart parts

Required:
- `metadata` (JSON string)
- `transcript_html` (file)

Optional:
- `cover_image` (file)
- `extras_json` (JSON string)

## Metadata fields

Required fields:
- `idempotency_key`
- `jurisdiction` (slug, example `grey-county`)
- `body` (slug, example `council`, `committee-of-the-whole`)
- `date_iso` (`YYYY-MM-DD`)
- `post_title`
- `post_body`

Create mode (new Lemmy post):
- include `community_name`
- do not include `post_id`/`post_url`

Update mode (existing Lemmy post):
- include `post_id` or `post_url`
- `community_name` optional consistency check

## Transcript HTML requirements

HTML must include:
- `<title>`
- `<meta name="description" ...>`
- canonical link matching:
  - `https://helpos.ca/transcripts/<jurisdiction>/<body>/<date_iso>`
- literal placeholder `{{DISCUSSION_URL}}` (server replaces it)

Disallowed in HTML:
- `<script>`, `<iframe>`, `<object>`
- inline `on*=` handlers

## Idempotency

Use deterministic key pattern and bump version when payload changes.

Recommended key:
- `<jurisdiction>-<body>-<date>-v1`
- then `...-v2`, `...-v3`, etc on edits

## Minimal publish flow

1. Generate transcript page HTML from pipeline.
2. Build metadata JSON.
3. Call endpoint with multipart.
4. Store server response JSON in meeting transcript folder.

## Role guidance

- Keep Lemmy post body concise and news-forward.
- Link readers to transcript URL for full details.
- Do not duplicate full transcript in Lemmy body.
- If correcting title/body/transcript, publish as UPDATE with a new idempotency key.
