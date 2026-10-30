import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SUMMARY_FOCUS } from "./defaults.mjs";
import { defineWriterAdapter } from "../../../../program/library/reporter_shared/writer-adapter-interface.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");

export const GREY_ADAPTER = defineWriterAdapter({
  writer_id: "grey-county-reporter",
  source_id: "escribe",
  house_root: HOUSE_ROOT,
  artifacts_slug: "grey-county",
  refresh_calendar_cmd: ["node", path.join(PROGRAM_DIR, "extract-grey-county-calendar-monthly.mjs")],
  run_meeting_from_ref_cmd: ["node", path.join(PROGRAM_DIR, "run-grey-county-meeting-from-ref.mjs")],
  send_dm_cmd: ["node", path.join(PROGRAM_DIR, "send-executive-dm.mjs")],
  identity: {
    jurisdiction: "Grey County",
    default_body: "auto",
    community_name: "grey-county-council",
  },
  publish: {
    community_name: "grey-county-council",
    command_env_order: ["GREY_LEMMY_POST_COMMAND", "MEETING_POST_COMMAND"],
  },
  defaults: {
    base_prefix: "meeting-qwen-auto",
    focus: DEFAULT_SUMMARY_FOCUS,
    // Grey's eScribe agenda PDF/HTML is publishable on its own. Requiring
    // minutes or extra attachments suppresses valid upcoming agenda previews.
    require_upcoming_supporting_docs: false,
    jurisdiction: "Grey County",
    body: "auto",
    site_url: "https://helpos.ca",
    discussion_url: "",
    exec_mxid: "@operator:example.invalid",
    community_name: "grey-county-council",
    timezone: "America/Toronto",
    transcript_jurisdiction_slug: "grey-county",
  },
});
