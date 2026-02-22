import { monitorWebChannel } from "./auto-reply.js";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  sendWebDirectInboundMessage,
} from "./auto-reply.test-harness.js";
import type { WebInboundMessage } from "./inbound.js";

export async function monitorWebChannelWithCapture(): Promise<{
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
}> {
  const spies = createWebInboundDeliverySpies();
  const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();

  await monitorWebChannel(false, listenerFactory, false);
  const onMessage = getOnMessage();
  if (!onMessage) {
    throw new Error("Missing onMessage handler");
  }

  return { spies, onMessage };
}

export async function sendWebDirectInboundAndCollectSessionKeys(): Promise<{
  seen: string[];
}> {
  const seen: string[] = [];

  const { spies, onMessage } = await monitorWebChannelWithCapture();
  await sendWebDirectInboundMessage({
    onMessage,
    spies,
    id: "m1",
    from: "+1000",
    to: "+2000",
    body: "hello",
  });

  return { seen };
}
