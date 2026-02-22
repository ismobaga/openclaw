import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const content =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "";
  const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    void hookRunner
      .runMessageReceived(
        {
          from: ctx.From ?? "",
          content,
          timestamp,
          metadata: {
            to: ctx.To,
            provider: ctx.Provider,
            surface: ctx.Surface,
            threadId: ctx.MessageThreadId,
            originatingChannel: ctx.OriginatingChannel,
            originatingTo: ctx.OriginatingTo,
            messageId: messageIdForHook,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
          },
        },
        {
          channelId,
          accountId: ctx.AccountId,
          conversationId,
        },
      )
      .catch((err) => {
        logVerbose(`dispatch-from-config: message_received plugin hook failed: ${String(err)}`);
      });
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    void triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        from: ctx.From ?? "",
        content,
        timestamp,
        channelId,
        accountId: ctx.AccountId,
        conversationId,
        messageId: messageIdForHook,
        metadata: {
          to: ctx.To,
          provider: ctx.Provider,
          surface: ctx.Surface,
          threadId: ctx.MessageThreadId,
          senderId: ctx.SenderId,
          senderName: ctx.SenderName,
          senderUsername: ctx.SenderUsername,
          senderE164: ctx.SenderE164,
        },
      }),
    ).catch((err) => {
      logVerbose(`dispatch-from-config: message_received internal hook failed: ${String(err)}`);
    });
  }

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  const originatingChannel = ctx.OriginatingChannel;
  const originatingTo = ctx.OriginatingTo;
  const currentSurface = (ctx.Surface ?? ctx.Provider)?.toLowerCase();
  const shouldRouteToOriginating =
    isRoutableChannel(originatingChannel) && originatingTo && originatingChannel !== currentSurface;

  markProcessing();

  try {
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
