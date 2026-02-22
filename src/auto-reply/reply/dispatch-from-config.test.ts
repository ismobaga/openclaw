import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp"].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;
type DispatchReplyArgs = Parameters<typeof dispatchReplyFromConfig>[0];

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

async function dispatchTwiceWithFreshDispatchers(params: Omit<DispatchReplyArgs, "dispatcher">) {
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    resetInboundDedupe();
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageReceived.mockClear();
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
  });

  it("fast-aborts and sends abort reply via dispatcher", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("fast-abort reply includes stopped subagent count when provided", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
      stoppedSubagents: 2,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted. Stopped 2 sub-agents.",
    });
  });

  it("fast-abort routes to originating channel when different from current surface", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Body: "/stop",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
        threadId: 123,
      }),
    );
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-1",
    });

    await dispatchTwiceWithFreshDispatchers({ ctx, cfg });

    // Second call should be skipped (dedup)
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "duplicate" }),
    );
  });

  it("emits message_received hook with originating channel metadata", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "Telegram",
      OriginatingTo: "telegram:999",
      CommandBody: "/search hello",
      RawBody: "raw text",
      Body: "body text",
      Timestamp: 1710000000000,
      MessageSidFull: "sid-full",
      SenderId: "user-1",
      SenderName: "Alice",
      SenderUsername: "alice",
      SenderE164: "+15555550123",
      AccountId: "acc-1",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: ctx.From,
        content: "/search hello",
        timestamp: 1710000000000,
        metadata: expect.objectContaining({
          originatingChannel: "Telegram",
          originatingTo: "telegram:999",
          messageId: "sid-full",
          senderId: "user-1",
          senderName: "Alice",
          senderUsername: "alice",
          senderE164: "+15555550123",
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acc-1",
        conversationId: "telegram:999",
      }),
    );
  });

  it("emits internal message:received hook when a session key is available", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:main",
      CommandBody: "/help",
      MessageSid: "msg-42",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:main",
      expect.objectContaining({
        from: ctx.From,
        content: "/help",
        channelId: "telegram",
        messageId: "msg-42",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("skips internal message:received hook when session key is unavailable", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandBody: "/help",
    });
    (ctx as MsgContext).SessionKey = undefined;

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits diagnostics when enabled", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-dup",
    });

    await dispatchTwiceWithFreshDispatchers({ ctx, cfg });

    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        outcome: "skipped",
        reason: "duplicate",
      }),
    );
  });
});
