import type { OpenClawConfig } from "../config/config.js";
import type { MsgContext } from "./templating.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

export type { GetReplyOptions, ReplyPayload } from "./types.js";

/**
 * AI runner entry point — removed in Phase 2 cleanup.
 * Returns undefined (no AI runner available).
 */
export async function getReplyFromConfig(
  _ctx: MsgContext,
  _opts?: GetReplyOptions,
  _configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  return undefined;
}
