import "./test-helpers.js";
import { describe, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createMockWebListener,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("typing controller idle", () => {
  installWebAutoReplyUnitTestHooks();

  it("processes messages without error (AI runner removed)", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const mockConfig: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          accountId: "default",
          sendComposing,
          reply,
          sendMedia,
        });
        return createMockWebListener();
      },
      false,
    );

    resetLoadConfigMock();
  });
});
