import { resolveWhatsAppHeartbeatRecipients } from "../../channels/plugins/whatsapp-heartbeat.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  updateSessionStore,
} from "../../config/sessions.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "../../infra/heartbeat-events.js";
import { resolveHeartbeatVisibility } from "../../infra/heartbeat-visibility.js";
import { getChildLogger } from "../../logging.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { sendMessageWhatsApp } from "../outbound.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappHeartbeatLog } from "./loggers.js";
import { getSessionSnapshot } from "./session-snapshot.js";
import { elide } from "./util.js";

export async function runWebHeartbeatOnce(opts: {
  cfg?: ReturnType<typeof loadConfig>;
  to: string;
  verbose?: boolean;
  sender?: typeof sendMessageWhatsApp;
  sessionId?: string;
  overrideBody?: string;
  dryRun?: boolean;
}) {
  const { cfg: cfgOverride, to, verbose = false, sessionId, overrideBody, dryRun = false } = opts;
  const sender = opts.sender ?? sendMessageWhatsApp;
  const runId = newConnectionId();
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to,
  });

  const cfg = cfgOverride ?? loadConfig();

  // Resolve heartbeat visibility settings for WhatsApp
  const visibility = resolveHeartbeatVisibility({ cfg, channel: "whatsapp" });

  const maybeSendHeartbeatOk = async (): Promise<boolean> => {
    if (!visibility.showOk) {
      return false;
    }
    if (dryRun) {
      whatsappHeartbeatLog.info(`[dry-run] heartbeat ok -> ${to}`);
      return false;
    }
    const okText = "HEARTBEAT_OK";
    const sendResult = await sender(to, okText, { verbose });
    heartbeatLogger.info(
      {
        to,
        messageId: sendResult.messageId,
        chars: okText.length,
        reason: "heartbeat-ok",
      },
      "heartbeat ok sent",
    );
    whatsappHeartbeatLog.info(`heartbeat ok sent to ${to} (id ${sendResult.messageId})`);
    return true;
  };

  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const sessionKey = resolveSessionKey(sessionScope, { From: to }, mainKey);
  if (sessionId) {
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const current = store[sessionKey] ?? {};
    store[sessionKey] = {
      ...current,
      sessionId,
      updatedAt: Date.now(),
    };
    await updateSessionStore(storePath, (nextStore) => {
      const nextCurrent = nextStore[sessionKey] ?? current;
      nextStore[sessionKey] = {
        ...nextCurrent,
        sessionId,
        updatedAt: Date.now(),
      };
    });
  }
  const sessionSnapshot = getSessionSnapshot(cfg, to, true);
  if (verbose) {
    heartbeatLogger.info(
      {
        to,
        sessionKey: sessionSnapshot.key,
        sessionId: sessionId ?? sessionSnapshot.entry?.sessionId ?? null,
        sessionFresh: sessionSnapshot.fresh,
        resetMode: sessionSnapshot.resetPolicy.mode,
        resetAtHour: sessionSnapshot.resetPolicy.atHour,
        idleMinutes: sessionSnapshot.resetPolicy.idleMinutes ?? null,
        dailyResetAt: sessionSnapshot.dailyResetAt ?? null,
        idleExpiresAt: sessionSnapshot.idleExpiresAt ?? null,
      },
      "heartbeat session snapshot",
    );
  }

  if (overrideBody && overrideBody.trim().length === 0) {
    throw new Error("Override body must be non-empty when provided.");
  }

  try {
    if (overrideBody) {
      if (dryRun) {
        whatsappHeartbeatLog.info(
          `[dry-run] web send -> ${to}: ${elide(overrideBody.trim(), 200)} (manual message)`,
        );
        return;
      }
      const sendResult = await sender(to, overrideBody, { verbose });
      emitHeartbeatEvent({
        status: "sent",
        to,
        preview: overrideBody.slice(0, 160),
        hasMedia: false,
        channel: "whatsapp",
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
      });
      heartbeatLogger.info(
        {
          to,
          messageId: sendResult.messageId,
          chars: overrideBody.length,
          reason: "manual-message",
        },
        "manual heartbeat message sent",
      );
      whatsappHeartbeatLog.info(`manual heartbeat sent to ${to} (id ${sendResult.messageId})`);
      return;
    }

    if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
      heartbeatLogger.info({ to, reason: "alerts-disabled" }, "heartbeat skipped");
      emitHeartbeatEvent({
        status: "skipped",
        to,
        reason: "alerts-disabled",
        channel: "whatsapp",
      });
      return;
    }

    // AI runner removed — heartbeat emits ok-empty
    heartbeatLogger.info(
      {
        to,
        reason: "no-ai-runner",
        sessionId: sessionSnapshot.entry?.sessionId ?? null,
      },
      "heartbeat skipped",
    );
    const okSent = await maybeSendHeartbeatOk();
    emitHeartbeatEvent({
      status: "ok-empty",
      to,
      channel: "whatsapp",
      silent: !okSent,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : undefined,
    });
  } catch (err) {
    const reason = formatError(err);
    heartbeatLogger.warn({ to, error: reason }, "heartbeat failed");
    whatsappHeartbeatLog.warn(`heartbeat failed (${reason})`);
    emitHeartbeatEvent({
      status: "failed",
      to,
      reason,
      channel: "whatsapp",
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    throw err;
  }
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof loadConfig>,
  opts: { to?: string; all?: boolean } = {},
) {
  return resolveWhatsAppHeartbeatRecipients(cfg, opts);
}
