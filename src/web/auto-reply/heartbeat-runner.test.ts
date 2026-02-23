import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";
import type { sendMessageWhatsApp } from "../outbound.js";

const state = vi.hoisted(() => ({
  visibility: { showAlerts: true, showOk: true, useIndicator: false },
  store: {} as Record<string, { updatedAt?: number; sessionId?: string }>,
  snapshot: {
    key: "k",
    entry: { sessionId: "s1", updatedAt: 123 },
    fresh: false,
    resetPolicy: { mode: "none", atHour: null, idleMinutes: null },
    dailyResetAt: null as number | null,
    idleExpiresAt: null as number | null,
  },
  events: [] as unknown[],
}));

vi.mock("../../channels/plugins/whatsapp-heartbeat.js", () => ({
  resolveWhatsAppHeartbeatRecipients: () => [],
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ agents: { defaults: {} }, session: {} }),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: () => null,
}));

vi.mock("../../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: () => state.visibility,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: () => state.store,
  resolveSessionKey: () => "k",
  resolveStorePath: () => "/tmp/store.json",
  updateSessionStore: async (_path: string, updater: (store: typeof state.store) => void) => {
    updater(state.store);
  },
}));

vi.mock("./session-snapshot.js", () => ({
  getSessionSnapshot: () => state.snapshot,
}));

vi.mock("../../infra/heartbeat-events.js", () => ({
  emitHeartbeatEvent: (event: unknown) => state.events.push(event),
  resolveIndicatorType: (status: string) => `indicator:${status}`,
}));

vi.mock("../../logging.js", () => ({
  getChildLogger: () => ({
    info: () => {},
    warn: () => {},
  }),
}));

vi.mock("./loggers.js", () => ({
  whatsappHeartbeatLog: {
    info: () => {},
    warn: () => {},
  },
}));

vi.mock("../reconnect.js", () => ({
  newConnectionId: () => "run-1",
}));

vi.mock("../outbound.js", () => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "m1" })),
}));

vi.mock("../session.js", () => ({
  formatError: (err: unknown) => `ERR:${String(err)}`,
}));

describe("runWebHeartbeatOnce", () => {
  let senderMock: ReturnType<typeof vi.fn>;
  let sender: typeof sendMessageWhatsApp;

  const getModules = async () => await import("./heartbeat-runner.js");
  const buildRunArgs = (overrides: Record<string, unknown> = {}) => ({
    cfg: { agents: { defaults: {} }, session: {} } as never,
    to: "+123",
    sender,
    ...overrides,
  });

  beforeEach(() => {
    state.visibility = { showAlerts: true, showOk: true, useIndicator: false };
    state.store = { k: { updatedAt: 999, sessionId: "s1" } };
    state.snapshot = {
      key: "k",
      entry: { sessionId: "s1", updatedAt: 123 },
      fresh: false,
      resetPolicy: { mode: "none", atHour: null, idleMinutes: null },
      dailyResetAt: null,
      idleExpiresAt: null,
    };
    state.events = [];

    senderMock = vi.fn(async () => ({ messageId: "m1" }));
    sender = senderMock as unknown as typeof sendMessageWhatsApp;
  });

  it("supports manual override body dry-run without sending", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs({ overrideBody: "hello", dryRun: true }));
    expect(senderMock).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(0);
  });

  it("sends HEARTBEAT_OK when AI runner is absent and showOk is enabled", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(senderMock).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-empty", silent: false })]),
    );
  });

  it("skips sending when showAlerts and showOk are disabled", async () => {
    state.visibility = { showAlerts: false, showOk: false, useIndicator: false };
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(senderMock).not.toHaveBeenCalled();
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", reason: "alerts-disabled" }),
      ]),
    );
  });

  it("emits failed events when sending throws and rethrows the error", async () => {
    senderMock.mockRejectedValueOnce(new Error("nope"));
    const { runWebHeartbeatOnce } = await getModules();
    await expect(runWebHeartbeatOnce(buildRunArgs())).rejects.toThrow("nope");
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", reason: "ERR:Error: nope" }),
      ]),
    );
  });
});
