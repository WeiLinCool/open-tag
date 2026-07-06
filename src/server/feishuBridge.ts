import { sendChannelMessage } from "./mcp/feishuTools.js";

export async function routeFeishuText(serverId: string, userId: string, channelId: string, content: string) {
  return sendChannelMessage(serverId, userId, channelId, content);
}
