import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const GREY_COUNTY_YOUTUBE_CHANNEL_ID = "UCw_WmatPnvP6MqyUBlCAYpw";
export const GREY_COUNTY_YOUTUBE_STREAMS_URL =
  `https://www.youtube.com/channel/${GREY_COUNTY_YOUTUBE_CHANNEL_ID}/streams`;

const DEFAULT_PLAYLIST_END = 1000;

const MONTHS = new Map([
  ["january", "01"], ["february", "02"], ["march", "03"], ["april", "04"],
  ["may", "05"], ["june", "06"], ["july", "07"], ["august", "08"],
  ["september", "09"], ["october", "10"], ["november", "11"], ["december", "12"],
]);

function normalize(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export function dateIsoFromYoutubeTitle(title = "", fallbackYear = "") {
  const match = normalize(title).match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(\d{4}))?\b/u,
  );
  if (!match) return "";
  const year = String(match[3] || fallbackYear || "").trim();
  if (!/^\d{4}$/u.test(year)) return "";
  return `${year}-${MONTHS.get(match[1])}-${String(match[2]).padStart(2, "0")}`;
}

function dateIsoFromYoutubeUploadDate(uploadDate = "") {
  const value = String(uploadDate || "").trim();
  if (/^\d{8}$/u.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function readYoutubeMetadataCache(cachePath = "") {
  const target = String(cachePath || "").trim();
  if (!target) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch {
    return {};
  }
}

function writeYoutubeMetadataCache(cachePath = "", entries = {}) {
  const target = String(cachePath || "").trim();
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({
      schema_version: 1,
      fetched_at_utc: new Date().toISOString(),
      entries,
    }, null, 2)}\n`, "utf8");
  } catch {
    // Metadata caching is an optimization; discovery must remain usable if
    // the artifact directory is temporarily read-only.
  }
}

function probeYoutubeMetadata(entry, execFileSyncImpl) {
  try {
    const raw = execFileSyncImpl("yt-dlp", [
      "--quiet",
      "--no-warnings",
      "--extractor-args",
      "youtube:player_client=android",
      "--dump-single-json",
      "--skip-download",
      String(entry.url),
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const metadata = JSON.parse(String(raw || "{}"));
    if (String(metadata?.channel_id || "") && String(metadata.channel_id) !== GREY_COUNTY_YOUTUBE_CHANNEL_ID) {
      return null;
    }
    return {
      upload_date: String(metadata?.upload_date || "").trim(),
      title: String(metadata?.title || entry.title || "").trim(),
    };
  } catch {
    return null;
  }
}

export function youtubeStreamMatchesMeeting(stream = {}, meeting = {}) {
  const streamDate = String(stream?.date_iso || dateIsoFromYoutubeTitle(stream?.title) || "");
  const meetingDate = String(meeting?.start_local || meeting?.since || "").slice(0, 10);
  if (!streamDate || streamDate !== meetingDate) return false;
  const title = normalize(stream?.title);
  const meetingName = normalize(meeting?.meeting_name || meeting?.meeting_type);
  if (!title || !meetingName) return false;
  if (title.includes(meetingName)) return true;
  const combinedCouncil = title.includes("council") && title.includes("committee of the whole");
  return combinedCouncil && (
    meetingName.includes("county council")
    || meetingName.includes("committee of the whole")
  );
}

export function discoverGreyCountyYoutubeStreams({
  execFileSyncImpl = execFileSync,
  playlistEnd = Number(process.env.GREY_COUNTY_YOUTUBE_PLAYLIST_END || DEFAULT_PLAYLIST_END),
  metadataCachePath = process.env.GREY_COUNTY_YOUTUBE_METADATA_CACHE || "",
} = {}) {
  try {
    const args = ["--flat-playlist"];
    const limit = Number(playlistEnd);
    if (Number.isFinite(limit) && limit > 0) args.push("--playlist-end", String(Math.floor(limit)));
    args.push("--dump-single-json", GREY_COUNTY_YOUTUBE_STREAMS_URL);
    const raw = execFileSyncImpl("yt-dlp", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(String(raw || "{}"));
    const metadataEntries = readYoutubeMetadataCache(metadataCachePath);
    let metadataCacheChanged = false;
    const rows = (Array.isArray(parsed?.entries) ? parsed.entries : [])
      .map((entry) => ({
        id: String(entry?.id || "").trim(),
        title: String(entry?.title || "").trim(),
        url: String(entry?.url || (entry?.id ? `https://www.youtube.com/watch?v=${entry.id}` : "")).trim(),
        date_iso: dateIsoFromYoutubeTitle(entry?.title),
      }))
      .filter((entry) => entry.id && entry.url);

    for (const entry of rows) {
      if (entry.date_iso) continue;
      let metadata = metadataEntries[entry.id];
      if (!metadata || typeof metadata !== "object") {
        metadata = probeYoutubeMetadata(entry, execFileSyncImpl);
        metadataEntries[entry.id] = metadata || { upload_date: "", title: entry.title };
        metadataCacheChanged = true;
      }
      const uploadDate = String(metadata?.upload_date || "").trim();
      const uploadIso = dateIsoFromYoutubeUploadDate(uploadDate);
      entry.date_iso = dateIsoFromYoutubeTitle(entry.title, uploadIso.slice(0, 4)) || uploadIso;
    }
    if (metadataCacheChanged) writeYoutubeMetadataCache(metadataCachePath, metadataEntries);
    return rows.filter((entry) => entry.date_iso);
  } catch {
    return [];
  }
}

export function selectLongestOfficialYoutubeRecording(urls = [], {
  execFileSyncImpl = execFileSync,
} = {}) {
  const rows = [];
  const playerClients = ["android_vr", "android"];
  for (const url of [...new Set((Array.isArray(urls) ? urls : []).map(String).filter((value) => /youtu\.?be/iu.test(value)))]) {
    for (const playerClient of playerClients) {
      try {
        const raw = execFileSyncImpl("yt-dlp", [
          "--extractor-args",
          `youtube:player_client=${playerClient}`,
          "--dump-single-json",
          "--skip-download",
          url,
        ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        const metadata = JSON.parse(String(raw || "{}"));
        if (String(metadata?.channel_id || "") !== GREY_COUNTY_YOUTUBE_CHANNEL_ID) continue;
        // A scheduled YouTube broadcast can expose a duration while it is
        // still live. Treat live/upcoming entries as operationally unresolved;
        // downloading them would block the agenda-preview path indefinitely.
        const liveStatus = String(metadata?.live_status || "").trim().toLowerCase();
        if (metadata?.is_live === true || liveStatus === "is_live" || liveStatus === "live" || liveStatus === "is_upcoming" || liveStatus === "upcoming") continue;
        const duration = Number(metadata?.duration || 0);
        if (!Number.isFinite(duration) || duration <= 0) continue;
        rows.push({
          url: String(metadata?.webpage_url || url),
          id: String(metadata?.id || ""),
          title: String(metadata?.title || ""),
          duration,
        });
        break;
      } catch {}
    }
  }
  return rows.sort((a, b) => b.duration - a.duration)[0] || null;
}
