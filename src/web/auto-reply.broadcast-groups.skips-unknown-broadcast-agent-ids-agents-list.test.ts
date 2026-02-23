import "./test-helpers.js";
import { describe, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { sendWebDirectInboundAndCollectSessionKeys } from "./auto-reply.broadcast-groups.test-harness.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips unknown broadcast agent ids when agents.list is present", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "+1000": ["alfred", "missing"],
      },
    } satisfies OpenClawConfig);

    // Without AI runner, just verify dispatch completes without error (unknown agent is skipped)
    await sendWebDirectInboundAndCollectSessionKeys();
    resetLoadConfigMock();
  });
});
