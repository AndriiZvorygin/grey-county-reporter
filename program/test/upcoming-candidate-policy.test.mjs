import assert from "node:assert/strict";
import test from "node:test";
import { GREY_ADAPTER } from "../writer-adapter-grey-county.mjs";
import { buildRunNextConfig } from "../../../../../program/library/reporter_shared/writer-adapter-interface.mjs";

test("Grey upcoming agenda selection does not require extra supporting documents", () => {
  const config = buildRunNextConfig(GREY_ADAPTER, {
    basePrefix: "meeting-qwen-auto",
    focus: GREY_ADAPTER.defaults.focus,
    jurisdiction: GREY_ADAPTER.defaults.jurisdiction,
    body: GREY_ADAPTER.defaults.body,
    siteUrl: GREY_ADAPTER.defaults.site_url,
    discussionUrl: GREY_ADAPTER.defaults.discussion_url,
    execMxid: GREY_ADAPTER.defaults.exec_mxid,
    timezone: GREY_ADAPTER.defaults.timezone,
  });

  assert.equal(config.require_upcoming_supporting_docs, false);
});
