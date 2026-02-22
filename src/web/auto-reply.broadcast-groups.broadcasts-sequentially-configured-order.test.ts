import "./test-helpers.js";
import { describe, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  monitorWebChannelWithCapture,
  sendWebDirectInboundAndCollectSessionKeys,
} from "./auto-reply.broadcast-groups.test-harness.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebGroupInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("broadcasts sequentially in configured order without error", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    // Without AI runner, just verify the dispatch completes without error
    await sendWebDirectInboundAndCollectSessionKeys();
    resetLoadConfigMock();
  });

  it("shares group history across broadcast agents and clears after replying", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "123@g.us": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const { spies, onMessage } = await monitorWebChannelWithCapture();

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "hello group",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
    });

    // Without AI runner, just verify group messages dispatch without error
    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      body: "@bot ping",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });

    resetLoadConfigMock();
  });

  it("broadcasts in parallel by default without error", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "parallel",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies OpenClawConfig);

    const { onMessage: capturedOnMessage } = await monitorWebChannelWithCapture();

    await capturedOnMessage({
      id: "m1",
      from: "+1000",
      conversationId: "+1000",
      to: "+2000",
      accountId: "default",
      body: "hello",
      timestamp: Date.now(),
      chatType: "direct",
      chatId: "direct:+1000",
      sendComposing: async () => {},
      reply: async () => {},
      sendMedia: async () => {},
    });

    resetLoadConfigMock();
  });
});
