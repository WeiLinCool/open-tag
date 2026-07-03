import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { assignTask, createMessage, getOrCreateThread, serializeMsg } from "./core.js";
import { nextSeq, publish, registerRealtimeObserver } from "./realtime.js";
import { nextTaskNumber } from "../redis.js";
import {
  findExternalDeliveryContextByMessage,
  findExternalDeliveryContextByThread,
  markExternalDeliveryDone,
  registerExternalDeliveryContext,
} from "./externalContexts.js";
import { readJson, sendErr, sendJson } from "./util.js";
import {
  applyWeChatSessionEvent,
  findWeChatBindingByExternalUser,
  listPendingWeChatLoginSessions,
  serializeWeChatBinding,
  serializeWeChatLoginSession,
} from "./wechatBinding.js";

export interface WeChatInbound {
  botId: string;
  roomId: string;
  userId: string;
  msgType: string;
  content: string;
  timestamp: number;
}

export interface WeChatBindInbound extends WeChatInbound {
  sessionId?: string;
}

export interface WeChatCommand {
  roleTag: string;
  targetAgent: string;
  command: string;
}

export interface WeChatOutboundStatus {
  stage: "received" | "working" | "done" | "failure";
  resultUrl?: string;
  attachments?: WeChatOutboundAttachment[];
}

export interface WeChatOutboundAttachment {
  id: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface WeChatNormalizedInbound extends WeChatInbound {
  channelId: "#all";
  contextToken?: string;
  replyToUserId?: string;
  targetUserId?: string;
}

export interface WeChatTaskContext {
  botId: string;
  roomId: string;
  userId: string;
  contextToken?: string;
  replyToUserId?: string;
  targetAgent: string;
  taskId: string;
  taskNumber: number | null;
}

const ROLE_ALIASES: Record<string, string> = {
  分析师: "analyst",
  analyst: "analyst",
};

const trackedTasks = new Map<string, WeChatTaskContext>();
const trackedExternalMessages = new Map<string, WeChatTaskContext>();
const outbox: { taskId: string; roomId: string; replyToUserId?: string; contextToken?: string; payload: WeChatOutboundStatus }[] = [];
let openClawSeq = 0;

function token(): string | null {
  const explicit = process.env.WECHAT_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  return process.env.NODE_ENV === "production" ? null : "dev-wechat-gateway-token";
}

export function normalizeWeChatInbound(input: WeChatInbound): WeChatNormalizedInbound {
  return {
    botId: String(input.botId ?? "").trim(),
    roomId: String(input.roomId ?? "").trim(),
    userId: String(input.userId ?? "").trim(),
    msgType: String(input.msgType ?? "text").trim() || "text",
    content: String(input.content ?? "").trim(),
    timestamp: Number.isFinite(Number(input.timestamp)) ? Number(input.timestamp) : Date.now(),
    channelId: "#all",
  };
}

export function parseWeChatCommand(content: string): WeChatCommand | null {
  const m = /^@Bot\s+#([^\s]+)\s+(.+)$/i.exec(content.trim());
  if (!m) return null;
  const roleTag = m[1]!.trim();
  const targetAgent = ROLE_ALIASES[roleTag] ?? ROLE_ALIASES[roleTag.toLowerCase()];
  if (!targetAgent) return null;
  const command = m[2]!.trim();
  if (!command) return null;
  return { roleTag, targetAgent, command };
}

export function formatWeChatStatus(input: WeChatOutboundStatus): string {
  if (input.stage === "received") return "[系统提示] 📥 已收到任务";
  if (input.stage === "working") return "[系统提示] ⚙️ 任务处理中";
  if (input.stage === "done") return input.resultUrl ? `[系统提示] ✅ 已完成 ${input.resultUrl}` : "[系统提示] ✅ 已完成";
  return "[系统提示] ⚠️ 任务失败";
}

export function drainWeChatOutbox(): { taskId: string; roomId: string; replyToUserId?: string; contextToken?: string; payload: WeChatOutboundStatus }[] {
  return outbox.splice(0, outbox.length);
}

export function registerWeChatTask(ctx: WeChatTaskContext): void {
  trackedTasks.set(ctx.taskId, ctx);
}

async function resolveRoleAgent(serverId: string, targetAgent: string) {
  const agent = (await db.select().from(schema.agents).where(and(
    eq(schema.agents.serverId, serverId),
    eq(schema.agents.name, targetAgent),
    isNull(schema.agents.deletedAt),
  )))[0];
  return agent ?? null;
}

function pushStatus(taskId: string, roomId: string, payload: WeChatOutboundStatus): void {
  const ctx = trackedTasks.get(taskId) ?? trackedExternalMessages.get(taskId);
  outbox.push({ taskId, roomId, replyToUserId: ctx?.replyToUserId, contextToken: ctx?.contextToken, payload });
}

async function pushExternalStatus(messageId: string, fallbackRoomId: string | null, payload: WeChatOutboundStatus): Promise<void> {
  const cached = trackedTasks.get(messageId) ?? trackedExternalMessages.get(messageId);
  if (cached) {
    outbox.push({ taskId: messageId, roomId: cached.roomId, replyToUserId: cached.replyToUserId, contextToken: cached.contextToken, payload });
    return;
  }
  const persisted = await findExternalDeliveryContextByMessage(messageId);
  const roomId = persisted?.externalConversationId ?? fallbackRoomId;
  if (!roomId) return;
  outbox.push({
    taskId: messageId,
    roomId,
    replyToUserId: persisted?.replyToExternalUserId ?? undefined,
    contextToken: persisted?.contextToken ?? undefined,
    payload,
  });
}

async function latestAgentAnswerForTask(taskId: string): Promise<{ content: string | null; attachments: WeChatOutboundAttachment[] }> {
  const task = (await db.select({ threadId: schema.messages.threadId }).from(schema.messages).where(eq(schema.messages.id, taskId)))[0];
  if (!task?.threadId) return { content: null, attachments: [] };
  const answer = (await db.select({ id: schema.messages.id, content: schema.messages.content }).from(schema.messages).where(and(
    eq(schema.messages.channelId, task.threadId),
    eq(schema.messages.senderType, "agent"),
  )).orderBy(desc(schema.messages.seq)).limit(1))[0];
  const content = String(answer?.content ?? "").trim();
  const attachments = answer?.id ? await attachmentsForMessage(answer.id) : [];
  return { content: content || null, attachments };
}

async function pushDoneStatus(taskId: string, roomId: string): Promise<void> {
  const answer = await latestAgentAnswerForTask(taskId);
  await pushExternalStatus(taskId, roomId, { stage: "done", resultUrl: answer.content ?? `thread:${taskId.slice(0, 8)}`, attachments: answer.attachments });
  trackedTasks.delete(taskId);
  await markExternalDeliveryDone(taskId);
}

function textFromOpenClawMsg(msg: any): string {
  const item = Array.isArray(msg?.item_list) ? msg.item_list.find((it: any) => it?.type === 1 && it?.text_item?.text) : null;
  return String(item?.text_item?.text ?? "").trim();
}

export function normalizeOpenClawMsg(input: any): WeChatNormalizedInbound {
  const msg = input?.msg ?? input;
  const roomId = String(msg?.session_id || msg?.from_user_id || msg?.to_user_id || "openclaw").trim();
  const userId = String(msg?.from_user_id || msg?.to_user_id || "openclaw-user").trim();
  return {
    ...normalizeWeChatInbound({
    botId: "openclaw-weixin",
    roomId,
    userId,
    msgType: "text",
    content: textFromOpenClawMsg(msg),
    timestamp: Number(msg?.create_time_ms ?? Date.now()),
    }),
    contextToken: typeof msg?.context_token === "string" ? msg.context_token : undefined,
    replyToUserId: userId,
  };
}

function drainOpenClawUpdates(cursor: string) {
  const rows = drainWeChatOutbox();
  const msgs = rows.map((row) => {
    const seq = ++openClawSeq;
    return {
      seq,
      message_id: seq,
      from_user_id: row.roomId,
      to_user_id: row.roomId,
      create_time_ms: Date.now(),
      session_id: row.roomId,
      message_type: 2,
      message_state: 2,
      context_token: `open-tag:${row.taskId}`,
      item_list: [{ type: 1, text_item: { text: formatWeChatStatus(row.payload) } }],
    };
  });
  return {
    ret: 0,
    msgs,
    get_updates_buf: msgs.length ? String(openClawSeq) : String(cursor || ""),
    longpolling_timeout_ms: 35000,
  };
}

registerRealtimeObserver((serverId, event) => {
  if (!event || typeof event !== "object") return;
  const ev = event as any;
  if (ev.type === "message" && ev.message?.senderType === "agent" && (ev.message?.content || ev.message?.attachments?.length)) {
    void pushExternalThreadReply(ev.message.channelId, ev.message.content, ev.message.attachments).catch(() => {});
    return;
  }
  if (ev.type !== "task" || ev.op !== "updated" || !ev.task?.id) return;
  const ctx = trackedTasks.get(ev.task.id);
  if (!ctx) return;
  if (ev.task.taskStatus === "done" || ev.task.taskStatus === "closed") {
    void pushDoneStatus(ev.task.id, ctx.roomId).catch(() => pushStatus(ev.task.id, ctx.roomId, { stage: "done", resultUrl: `thread:${ev.task.id.slice(0, 8)}` }));
  } else if (ev.task.taskStatus === "in_progress" || ev.task.taskStatus === "in_review") {
    pushStatus(ev.task.id, ctx.roomId, { stage: "working", resultUrl: `thread:${ev.task.id.slice(0, 8)}` });
  }
});

async function pushExternalThreadReply(threadChannelId: string, content: string, attachmentsInput: unknown): Promise<void> {
  const ctx = await findExternalDeliveryContextByThread(threadChannelId);
  if (!ctx) return;
  const text = String(content ?? "").trim();
  const attachments = normalizeOutboundAttachments(attachmentsInput);
  if (!text && !attachments.length) return;
  await pushExternalStatus(ctx.sourceMessageId, ctx.externalConversationId, { stage: "done", resultUrl: text, attachments });
}

function normalizeOutboundAttachments(input: unknown): WeChatOutboundAttachment[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((a: any) => ({
      id: String(a?.id ?? "").trim(),
      filename: String(a?.filename ?? "file").trim() || "file",
      mimeType: typeof a?.mimeType === "string" ? a.mimeType : null,
      sizeBytes: Number.isFinite(Number(a?.sizeBytes)) ? Number(a.sizeBytes) : null,
    }))
    .filter((a) => a.id);
}

async function attachmentsForMessage(messageId: string): Promise<WeChatOutboundAttachment[]> {
  const rows = await db.select().from(schema.attachments).where(eq(schema.attachments.messageId, messageId));
  return rows.map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
  }));
}

export async function handleWeChatWebhook(req: Parameters<typeof readJson>[0], res: Parameters<typeof sendJson>[0], url: URL, method: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/integrations/wechat/")) return false;
  const shared = token();
  if (!shared) return (sendErr(res, 404, "not found"), true);

  const auth = String(req.headers.authorization ?? "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const hdr = String((req.headers["x-wechat-gateway-token"] ?? req.headers["x-wechat-token"] ?? "") || "").trim();
  const q = String(url.searchParams.get("token") ?? "").trim();
  if (hdr !== shared && q !== shared && bearer !== shared) return (sendErr(res, 404, "not found"), true);

  if (url.pathname === "/api/integrations/wechat/pending-sessions" && method === "GET") {
    const sessions = await listPendingWeChatLoginSessions(Number(url.searchParams.get("limit") ?? 20));
    return (sendJson(res, 200, { sessions: sessions.map(serializeWeChatLoginSession) }), true);
  }

  if (method !== "POST") return false;

  if (url.pathname === "/api/integrations/wechat/openclaw/getupdates") {
    const body = await readJson(req).catch(() => ({}));
    return (sendJson(res, 200, drainOpenClawUpdates(String((body as any).get_updates_buf ?? ""))), true);
  }

  if (url.pathname === "/api/integrations/wechat/openclaw/getconfig") {
    return (sendJson(res, 200, { ret: 0, typing_ticket: "" }), true);
  }

  if (url.pathname === "/api/integrations/wechat/openclaw/sendtyping") {
    return (sendJson(res, 200, { ret: 0 }), true);
  }

  if (url.pathname === "/api/integrations/wechat/openclaw/getuploadurl") {
    return (sendJson(res, 200, { ret: -1, errmsg: "media upload is not supported by the open-tag MVP gateway" }), true);
  }

  if (url.pathname === "/api/integrations/wechat/session-events") {
    const event = await readJson(req).catch(() => ({}));
    try {
      const result = await applyWeChatSessionEvent(event as any);
      return (sendJson(res, 200, {
        accepted: true,
        session: serializeWeChatLoginSession(result.session),
        binding: serializeWeChatBinding(result.binding),
      }), true);
    } catch (e: any) {
      return (sendJson(res, 200, { accepted: false, ignored: false, reason: String(e?.message ?? e) }), true);
    }
  }

  if (url.pathname === "/api/integrations/wechat/openclaw/sendmessage") {
    const body = normalizeOpenClawMsg(await readJson(req).catch(() => ({})));
    const routed = await routeOpenClawWeChatMessage(body);
    if (!routed.accepted) return (sendJson(res, 200, { ret: 0, accepted: false, ignored: routed.ignored, errmsg: routed.reason }), true);
    return (sendJson(res, 200, {
      ret: 0,
      accepted: true,
      channel_id: routed.channelId,
      target_agent: routed.targetAgent,
      command: routed.command,
      message_id: routed.messageId,
      task_id: routed.taskId,
      task_number: routed.taskNumber,
    }), true);
  }

  const body = normalizeWeChatInbound(await readJson(req).catch(() => ({} as WeChatInbound)));
  if (url.pathname !== "/api/integrations/wechat/webhook") return false;
  const binding = await findWeChatBindingByExternalUser(body.userId);
  if (!binding) return (sendJson(res, 200, {
    accepted: false,
    ignored: false,
    status: formatWeChatStatus({ stage: "failure" }),
    reason: "unbound wechat user",
  }), true);

  const routed = await routeWeChatCommand(body, binding.userId);
  if (!routed.accepted) return (sendJson(res, 200, {
    accepted: false,
    ignored: routed.ignored,
    status: formatWeChatStatus({ stage: "failure" }),
    reason: routed.reason,
  }), true);

  return (sendJson(res, 200, {
    accepted: true,
    channelId: routed.channelId,
    targetAgent: routed.targetAgent,
    command: routed.command,
    taskId: routed.taskId,
    taskNumber: routed.taskNumber,
    statusMessages: routed.statusMessages,
    threadTarget: routed.threadTarget,
  }), true);
}

export async function routeOpenClawWeChatMessage(body: WeChatNormalizedInbound) {
  const serverId = await serverIdForWebhook(body);
  const ownerId = await ownerIdForServer(serverId);
  return routeWeChatCommand(body, ownerId, "openclaw-weixin");
}

async function routeWeChatCommand(body: WeChatNormalizedInbound, userId: string, fallbackSenderName = "wechat-user") {
  const parsed = parseWeChatCommand(body.content);
  const serverId = await serverIdForWebhook(body);
  const channel = (await db.select().from(schema.channels).where(and(
    eq(schema.channels.serverId, serverId),
    eq(schema.channels.name, "all"),
    eq(schema.channels.type, "channel"),
    isNull(schema.channels.deletedAt),
  )))[0];
  if (!channel) return { accepted: false as const, ignored: false, reason: "all channel not found" };
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
  const senderName = user?.displayName || user?.name || fallbackSenderName;
  const sourceMsg = await createMessage({
    serverId,
    channelId: channel.id,
    senderType: "user",
    senderId: userId,
    senderName,
    messageType: "text",
    content: body.content,
  });
  await registerExternalMessage({
    serverId,
    channelId: channel.id,
    sourceMessageId: sourceMsg.id,
    body,
  });
  if (!parsed) return {
    accepted: true as const,
    ignored: false,
    channelId: "#all",
    targetAgent: null,
    command: body.content,
    messageId: sourceMsg.id,
    taskId: null,
    taskNumber: null,
    statusMessages: [],
    threadTarget: `thread:${sourceMsg.id.slice(0, 8)}`,
  };

  const agent = await resolveRoleAgent(serverId, parsed.targetAgent);
  if (!agent) return { accepted: false as const, ignored: false, reason: "unknown role" };

  const seq = await nextSeq(serverId);
  const taskNumber = await nextTaskNumber(serverId, channel);
  const [msg] = await db.insert(schema.messages).values({
    seq,
    serverId,
    channelId: channel.id,
    senderType: "user",
    senderId: userId,
    senderName,
    messageType: "text",
    content: parsed.command,
    searchText: parsed.command,
    taskStatus: "todo",
    taskNumber,
  }).returning();
  const thread = await getOrCreateThread(serverId, msg!.id, { type: "agent", id: agent.id });
  await db.update(schema.messages).set({ threadId: thread.id }).where(eq(schema.messages.id, msg!.id));
  const serialized = serializeMsg({ ...msg!, threadId: thread.id }, [], []);
  await publish(serverId, { type: "message", channelId: channel.id, message: { ...serialized, channelType: channel.type } });
  await publish(serverId, { type: "task", op: "created", task: serialized });
  registerWeChatTask({
    botId: body.botId,
    roomId: body.roomId,
    userId: body.userId,
    contextToken: body.contextToken,
    replyToUserId: body.replyToUserId,
    targetAgent: agent.name,
    taskId: msg!.id,
    taskNumber: msg!.taskNumber,
  });
  await registerExternalMessage({
    serverId,
    channelId: channel.id,
    sourceMessageId: sourceMsg.id,
    taskMessageId: msg!.id,
    body,
  });
  await assignTask(serverId, msg!.id, agent.id);

  pushStatus(msg!.id, body.roomId, { stage: "received" });
  pushStatus(msg!.id, body.roomId, { stage: "working", resultUrl: `thread:${msg!.id.slice(0, 8)}` });

  return {
    accepted: true,
    channelId: "#all",
    targetAgent: agent.name,
    command: parsed.command,
    messageId: sourceMsg.id,
    taskId: msg!.id,
    taskNumber: msg!.taskNumber,
    statusMessages: [
      formatWeChatStatus({ stage: "received" }),
      formatWeChatStatus({ stage: "working" }),
    ],
    threadTarget: `thread:${msg!.id.slice(0, 8)}`,
  };
}

async function registerExternalMessage(input: {
  serverId: string;
  channelId: string;
  sourceMessageId: string;
  taskMessageId?: string | null;
  body: WeChatNormalizedInbound;
}): Promise<void> {
  trackedExternalMessages.set(input.sourceMessageId, {
    botId: input.body.botId,
    roomId: input.body.roomId,
    userId: input.body.userId,
    contextToken: input.body.contextToken,
    replyToUserId: input.body.replyToUserId,
    targetAgent: "channel",
    taskId: input.sourceMessageId,
    taskNumber: null,
  });
  if (input.taskMessageId) {
    trackedExternalMessages.set(input.taskMessageId, {
      botId: input.body.botId,
      roomId: input.body.roomId,
      userId: input.body.userId,
      contextToken: input.body.contextToken,
      replyToUserId: input.body.replyToUserId,
      targetAgent: "task",
      taskId: input.taskMessageId,
      taskNumber: null,
    });
  }
  await registerExternalDeliveryContext({
    serverId: input.serverId,
    channelId: input.channelId,
    sourceMessageId: input.sourceMessageId,
    taskMessageId: input.taskMessageId ?? null,
    platform: "wechat",
    adapter: "openclaw-weixin",
    externalBotId: input.body.botId,
    externalConversationId: input.body.roomId,
    externalUserId: input.body.userId,
    replyToExternalUserId: input.body.replyToUserId ?? null,
    contextToken: input.body.contextToken ?? null,
  });
}

async function serverIdForWebhook(body: WeChatInbound): Promise<string> {
  const targetUserId = String((body as WeChatNormalizedInbound).targetUserId ?? "").trim();
  if (targetUserId) {
    const owned = (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.ownerId, targetUserId)))[0];
    if (owned?.id) return owned.id;
  }
  const wanted = String(process.env.WECHAT_GATEWAY_SERVER_SLUG ?? "open-tag").trim() || "open-tag";
  const srv = (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.slug, wanted)))[0];
  if (srv?.id) return srv.id;
  const fallback = (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
  if (fallback?.id) return fallback.id;
  throw new Error("default workspace not found");
}

async function ownerIdForServer(serverId: string): Promise<string> {
  const srv = (await db.select({ ownerId: schema.servers.ownerId }).from(schema.servers).where(eq(schema.servers.id, serverId)))[0];
  if (!srv?.ownerId) throw new Error("workspace owner not found");
  return srv.ownerId;
}
