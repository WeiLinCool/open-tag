import { canUserReadChannel } from "../channelAccess.js";
import { createMessage, getOrCreateThread } from "../core.js";
import { getFeishuBinding } from "../feishuBinding.js";
import { registerExternalDeliveryContext } from "../externalContexts.js";

export async function resolveFeishuConversation(userId: string, channelId: string) {
  const binding = await getFeishuBinding(userId);
  if (!binding) throw new Error("no feishu binding");
  return { userId, channelId, externalUserId: binding.externalUserId, externalRoomId: binding.externalRoomId };
}

export async function sendChannelMessage(serverId: string, userId: string, channelId: string, content: string, external?: {
  externalUserId?: string | null;
  externalRoomId?: string | null;
  externalBotId?: string | null;
  contextToken?: string | null;
}) {
  if (!(await canUserReadChannel(serverId, channelId, userId))) throw new Error("channel not readable");
  const msg = await createMessage({ serverId, channelId, senderType: "user", senderId: userId, senderName: "feishu", content });
  const thread = await getOrCreateThread(serverId, msg.id, { type: "user", id: userId });
  if (external?.externalUserId && external?.externalRoomId && external?.externalBotId) {
    await registerExternalDeliveryContext({
      serverId,
      channelId,
      sourceMessageId: msg.id,
      taskMessageId: null,
      platform: "feishu",
      adapter: "feishu-personal",
      externalBotId: external.externalBotId,
      externalConversationId: external.externalRoomId,
      externalUserId: external.externalUserId,
      replyToExternalUserId: external.externalUserId,
      contextToken: external.contextToken ?? null,
    });
  }
  return { message: msg, thread };
}
