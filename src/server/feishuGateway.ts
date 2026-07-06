import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { canUserReadChannel } from "./channelAccess.js";
import { findExternalDeliveryContextByConversation, findExternalDeliveryContextByMessage, findExternalDeliveryContextByThread, markExternalDeliveryDone, registerExternalDeliveryContext } from "./externalContexts.js";
import { createMessage, getOrCreateThread } from "./core.js";
import { registerRealtimeObserver } from "./realtime.js";
import { readJson, readText, sendErr, sendJson } from "./util.js";
import { findFeishuBindingByExternalUser, getFeishuBinding, linkFeishuIdentity, unlinkFeishuBinding } from "./feishuBinding.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

function env(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

function feishuEnabled(): boolean {
  return !!(env("FEISHU_VERIFICATION_TOKEN") || env("FEISHU_SIGNING_SECRET") || env("FEISHU_APP_SECRET") || env("FEISHU_APP_ID"));
}

function hmacSha256Hex(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function verifyFeishuSignature(bodyText: string, req: Parameters<typeof readJson>[0]): boolean {
  const secret = env("FEISHU_SIGNING_SECRET");
  if (!secret) return true;
  const ts = String(req.headers["x-lark-request-timestamp"] ?? "").trim();
  const nonce = String(req.headers["x-lark-request-nonce"] ?? "").trim();
  const sig = String(req.headers["x-lark-signature"] ?? "").trim();
  if (!ts || !nonce || !sig) return false;
  const expected = hmacSha256Hex(secret, `${ts}\n${nonce}\n${bodyText}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyFeishuToken(body: any): boolean {
  const token = env("FEISHU_VERIFICATION_TOKEN");
  if (!token) return true;
  return String(body?.verification_token ?? "").trim() === token;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeRoomId(event: any): string {
  return normalizeText(event?.chat_id || event?.open_chat_id || event?.chatId || event?.conversation_id || event?.conversationId);
}

function normalizeUserId(event: any): string {
  return normalizeText(event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.union_id || event?.sender?.sender_id?.user_id || event?.sender?.id || event?.sender_id || event?.user_id || event?.userId);
}

function normalizeMessageText(event: any): string {
  const content = event?.message?.content ?? event?.content ?? "";
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      return normalizeText(parsed.text ?? parsed.content ?? parsed.msg ?? parsed.message ?? content);
    } catch {
      return normalizeText(content);
    }
  }
  if (content && typeof content === "object") return normalizeText((content as any).text ?? (content as any).content ?? (content as any).msg ?? "");
  return "";
}

function normalizeMessageEvent(body: any) {
  const event = body?.event ?? body?.payload?.event ?? body;
  const roomId = normalizeRoomId(event);
  const userId = normalizeUserId(event);
  const content = normalizeMessageText(event);
  return { roomId, userId, content, botId: normalizeText(event?.app_id || event?.appId || event?.bot_id || event?.botId) || null };
}

async function resolveBindingChannel(userId: string) {
  const owned = (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.ownerId, userId)).limit(1))[0];
  const membership = owned ? null : (await db.select({ serverId: schema.serverMembers.serverId }).from(schema.serverMembers).where(eq(schema.serverMembers.userId, userId)).limit(1))[0];
  const serverId = owned?.id ?? membership?.serverId ?? null;
  if (!serverId) return null;
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.serverId, serverId))).find((row) => row.name === "all" && row.type === "channel") ?? null;
  return ch;
}

async function handleFeishuMessageEvent(body: any) {
  const { roomId, userId, content, botId } = normalizeMessageEvent(body);
  if (!roomId || !userId || !content) return { accepted: false, ignored: true };
  const binding = await findFeishuBindingByExternalUser(userId);
  if (!binding) return { accepted: false, ignored: true };
  const ctx = await findExternalDeliveryContextByConversation("feishu", roomId);
  const ch = ctx ? (await db.select().from(schema.channels).where(eq(schema.channels.id, ctx.channelId)))[0] : await resolveBindingChannel(binding.userId);
  if (!ch) return { accepted: false, ignored: true };
  if (!(await canUserReadChannel(ch.serverId, ch.id, binding.userId))) return { accepted: false, ignored: true };
  const routed = await routeFeishuText(ch.serverId, binding.userId, ch.id, content);
  await registerExternalDeliveryContext({
    serverId: ch.serverId,
    channelId: ch.id,
    sourceMessageId: routed.message.id,
    taskMessageId: null,
    platform: "feishu",
    adapter: "feishu-personal",
    externalBotId: botId ?? binding.botId ?? "feishu-personal",
    externalConversationId: roomId,
    externalUserId: userId,
    replyToExternalUserId: userId,
    contextToken: null,
  });
  return { accepted: true, messageId: routed.message.id, threadId: routed.thread.id };
}

export async function routeFeishuText(serverId: string, userId: string, channelId: string, content: string) {
  if (!(await canUserReadChannel(serverId, channelId, userId))) throw new Error("channel not readable");
  const msg = await createMessage({ serverId, channelId, senderType: "user", senderId: userId, senderName: "feishu", content });
  const thread = await getOrCreateThread(serverId, msg.id, { type: "user", id: userId });
  return { message: msg, thread };
}

export async function routeFeishuOutbound(messageId: string, content: string) {
  const ctx = await findExternalDeliveryContextByMessage(messageId);
  if (!ctx || ctx.platform !== "feishu") return null;
  const binding = await findFeishuBindingByExternalUser(ctx.externalUserId);
  if (!binding) return null;
  const payload = {
    receive_id: ctx.externalConversationId,
    msg_type: "text",
    content: JSON.stringify({ text: content }),
  };
  const token = await getFeishuTenantToken();
  if (!token) throw new Error("feishu tenant token unavailable");
  const resp = await fetch(`${FEISHU_API_BASE}/im/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ receive_id_type: "chat_id", ...payload }),
  });
  if (!resp.ok) throw new Error(`feishu send failed: ${resp.status}`);
  await markExternalDeliveryDone(messageId);
  return { ok: true };
}

registerRealtimeObserver((serverId, event) => {
  if (!event || typeof event !== "object") return;
  const ev = event as any;
  if (ev.type !== "message" || ev.message?.senderType !== "agent" || !ev.message?.channelId) return;
  void (async () => {
    const ctx = await findExternalDeliveryContextByThread(ev.message.channelId);
    if (!ctx || ctx.platform !== "feishu") return;
    await routeFeishuOutbound(ev.message.id, String(ev.message.content ?? "").trim());
  })().catch(() => {});
});

async function getFeishuTenantToken(): Promise<string | null> {
  const explicit = env("FEISHU_TENANT_ACCESS_TOKEN");
  if (explicit) return explicit;
  const appId = env("FEISHU_APP_ID");
  const appSecret = env("FEISHU_APP_SECRET");
  if (!appId || !appSecret) return null;
  const resp = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!resp.ok) return null;
  const data: any = await resp.json().catch(() => ({}));
  return typeof data?.tenant_access_token === "string" ? data.tenant_access_token : null;
}

export async function handleFeishuWebhook(req: Parameters<typeof readJson>[0], res: Parameters<typeof sendJson>[0], url: URL, method: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/integrations/feishu/")) return false;
  if (!feishuEnabled()) return (sendErr(res, 404, "not found"), true);

  if (method === "GET") {
    if (url.pathname === "/api/integrations/feishu/health") return (sendJson(res, 200, { ok: true }), true);
    return false;
  }

  if (method !== "POST") return (sendErr(res, 405, "method not allowed"), true);

  const bodyText = await readText(req);
  if (!verifyFeishuSignature(bodyText, req)) return (sendErr(res, 403, "invalid signature"), true);
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return (sendErr(res, 400, "invalid json"), true); }
  if (!verifyFeishuToken(body)) return (sendErr(res, 403, "invalid verification token"), true);

  if (body?.type === "url_verification" || body?.challenge) {
    return (sendJson(res, 200, { challenge: body.challenge ?? body?.data?.challenge ?? "" }), true);
  }

  if (body?.header?.event_type?.includes("im.message.receive") || body?.event?.message) {
    const result = await handleFeishuMessageEvent(body);
    return (sendJson(res, 200, result), true);
  }

  return (sendJson(res, 200, { accepted: false, ignored: true }), true);
}

export async function bindFeishuFromAuth(userId: string, input: { externalUserId: string; externalRoomId?: string | null; botId?: string | null }) {
  const binding = await linkFeishuIdentity({
    userId,
    externalUserId: input.externalUserId,
    externalRoomId: input.externalRoomId,
    botId: input.botId ?? null,
  });
  return getFeishuBinding(binding.userId);
}

export { unlinkFeishuBinding, getFeishuBinding };
