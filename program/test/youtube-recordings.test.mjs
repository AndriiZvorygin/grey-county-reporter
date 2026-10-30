import assert from "node:assert/strict";
import test from "node:test";

import {
  dateIsoFromYoutubeTitle,
  discoverGreyCountyYoutubeStreams,
  selectLongestOfficialYoutubeRecording,
  youtubeStreamMatchesMeeting,
} from "../grey-county-youtube-recordings.mjs";

test("Grey County stream titles map to the meeting date and combined bodies", () => {
  const stream = {
    title: "Council and Committee of the Whole July 23 2026",
    date_iso: "2026-07-23",
  };
  assert.equal(dateIsoFromYoutubeTitle(stream.title), "2026-07-23");
  assert.equal(youtubeStreamMatchesMeeting(stream, {
    meeting_name: "County Council",
    start_local: "2026-07-23T10:00:00",
  }), true);
  assert.equal(youtubeStreamMatchesMeeting(stream, {
    meeting_name: "Committee of the Whole",
    start_local: "2026-07-23T10:15:00",
  }), true);
  assert.equal(youtubeStreamMatchesMeeting(stream, {
    meeting_name: "County Council",
    start_local: "2026-07-09T10:00:00",
  }), false);
});

test("titles with ordinal dates use the YouTube upload year when the title omits it", () => {
  assert.equal(dateIsoFromYoutubeTitle("Council and Committee of the Whole September 22nd"), "");
  assert.equal(
    dateIsoFromYoutubeTitle("Council and Committee of the Whole September 22nd", "2026"),
    "2026-09-22",
  );
});

test("stream discovery reads the official Live playlist", () => {
  const rows = discoverGreyCountyYoutubeStreams({
    execFileSyncImpl: (_command, args) => {
      assert.ok(String(args.at(-1)).endsWith("/streams"));
      return JSON.stringify({
        entries: [{
          id: "video1",
          title: "Council and Committee of the Whole July 23 2026",
          url: "https://www.youtube.com/watch?v=video1",
        }],
      });
    },
  });
  assert.deepEqual(rows, [{
    id: "video1",
    title: "Council and Committee of the Whole July 23 2026",
    url: "https://www.youtube.com/watch?v=video1",
    date_iso: "2026-07-23",
  }]);
});

test("stream discovery resolves older title-only uploads through cached YouTube metadata", () => {
  const calls = [];
  const rows = discoverGreyCountyYoutubeStreams({
    metadataCachePath: "",
    execFileSyncImpl: (_command, args) => {
      calls.push(args);
      if (args.includes("--flat-playlist")) {
        return JSON.stringify({
          entries: [{
            id: "old-video",
            title: "Council & Committee of the Whole",
            url: "https://www.youtube.com/watch?v=old-video",
          }],
        });
      }
      return JSON.stringify({
        id: "old-video",
        channel_id: "UCw_WmatPnvP6MqyUBlCAYpw",
        upload_date: "20200423",
      });
    },
  });
  assert.deepEqual(rows, [{
    id: "old-video",
    title: "Council & Committee of the Whole",
    url: "https://www.youtube.com/watch?v=old-video",
    date_iso: "2020-04-23",
  }]);
  assert.equal(calls.length, 2);
});

test("duplicate or reconnected streams select the longest official recording", () => {
  const durations = new Map([["short", 109], ["long", 8178]]);
  const selected = selectLongestOfficialYoutubeRecording([
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=long",
  ], {
    execFileSyncImpl: (_command, args) => {
      assert.ok(args.includes("youtube:player_client=android_vr"));
      const id = String(args.at(-1)).split("=").at(-1);
      return JSON.stringify({
        id,
        webpage_url: args.at(-1),
        channel_id: "UCw_WmatPnvP6MqyUBlCAYpw",
        duration: durations.get(id),
      });
    },
  });
  assert.equal(selected.id, "long");
  assert.equal(selected.duration, 8178);
});

test("live official broadcasts are not selected as completed recordings", () => {
  const selected = selectLongestOfficialYoutubeRecording([
    "https://www.youtube.com/watch?v=live",
    "https://www.youtube.com/watch?v=recording",
  ], {
    execFileSyncImpl: (_command, args) => {
      const id = String(args.at(-1)).split("=").at(-1);
      return JSON.stringify({
        id,
        webpage_url: args.at(-1),
        channel_id: "UCw_WmatPnvP6MqyUBlCAYpw",
        duration: id === "live" ? 99999 : 8178,
        is_live: id === "live",
        live_status: id === "live" ? "is_live" : "was_live",
      });
    },
  });
  assert.equal(selected.id, "recording");
});

test("metadata probing falls back when the preferred YouTube client rejects a recording", () => {
  const clients = [];
  const selected = selectLongestOfficialYoutubeRecording([
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=full",
  ], {
    execFileSyncImpl: (_command, args) => {
      const client = String(args[args.indexOf("--extractor-args") + 1]);
      const id = String(args.at(-1)).split("=").at(-1);
      clients.push(`${client}:${id}`);
      if (id === "full" && client.endsWith("android_vr")) throw new Error("client rejected");
      return JSON.stringify({
        id,
        webpage_url: args.at(-1),
        channel_id: "UCw_WmatPnvP6MqyUBlCAYpw",
        duration: id === "full" ? 15603 : 85,
        live_status: "was_live",
      });
    },
  });
  assert.equal(selected.id, "full");
  assert.deepEqual(clients, [
    "youtube:player_client=android_vr:short",
    "youtube:player_client=android_vr:full",
    "youtube:player_client=android:full",
  ]);
});
