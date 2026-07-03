import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { assignTask, getOrCreateThread, serializeMsg } from "./core.js";
import { nextSeq, publish, registerRealtimeObserver } from "./realtime.js";
import { nextTaskNumber } from "../redis.js";
import { readJson, sendErr, sendJson } from "./util.js";
import { claimWeChatBindingCode, findWeChatBindingByExternalUser } from "./wechatBinding.js";

export interface WeChatInbound {
  botId: string;
  roomId: string;
  userId: string;
  msgType: string;
  content: string;
  timestamp: number;
}

export interface WeChatBindInbound extends WeChatInbound {
  code?: string;
}

export interface WeChatCommand {
  roleTag: string;
  targetAgent: string;
  command: string;
}

export interface WeChatOutboundStatus {
  stage: "received" | "working" | "done" | "failure";
  resultUrl?: string;
}

export interface WeChatNormalizedInbound extends WeChatInbound {
  channelId: "#all";
}

export interface WeChatTaskContext {
  botId: string;
  roomId: string;
  userId: string;
  targetAgent: string;
  taskId: string;
  taskNumber: number | null;
}

const ROLE_ALIASES: Record<string, string> = {
  分析师: "analyst",
  analyst: "analyst",
};

const trackedTasks = new Map<string, WeChatTaskContext>();
const outbox: { taskId: string; roomId: string; payload: WeChatOutboundStatus }[] = [];

function token(): string | null {
  const v = process.env.WECHAT_GATEWAY_TOKEN?.trim();
  return v ? v : null;
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

export function drainWeChatOutbox(): { taskId: string; roomId: string; payload: WeChatOutboundStatus }[] {
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
  outbox.push({ taskId, roomId, payload });
}

function parseBindingCode(input: WeChatBindInbound): string {
  const direct = String(input.code ?? "").trim();
  if (direct) return direct;
  const content = String(input.content ?? "").trim();
  const m = /^(?:#绑定|绑定|bind)\s+([A-Za-z0-9_-]{4,32})$/i.exec(content);
  return m?.[1] ?? "";
}

registerRealtimeObserver((serverId, event) => {
  if (!event || typeof event !== "object") return;
  const ev = event as any;
  if (ev.type !== "task" || ev.op !== "updated" || !ev.task?.id) return;
  const ctx = trackedTasks.get(ev.task.id);
  if (!ctx) return;
  if (ev.task.taskStatus === "done" || ev.task.taskStatus === "closed") {
    pushStatus(ev.task.id, ctx.roomId, { stage: "done", resultUrl: `thread:${ev.task.id.slice(0, 8)}` });
    trackedTasks.delete(ev.task.id);
  } else if (ev.task.taskStatus === "in_progress" || ev.task.taskStatus === "in_review") {
    pushStatus(ev.task.id, ctx.roomId, { stage: "working", resultUrl: `thread:${ev.task.id.slice(0, 8)}` });
  }
});

export async function handleWeChatWebhook(req: Parameters<typeof readJson>[0], res: Parameters<typeof sendJson>[0], url: URL, method: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/integrations/wechat/") || method !== "POST") return false;
  const shared = token();
  if (!shared) return (sendErr(res, 404, "not found"), true);

  const hdr = String((req.headers["x-wechat-gateway-token"] ?? req.headers["x-wechat-token"] ?? "") || "").trim();
  const q = String(url.searchParams.get("token") ?? "").trim();
  if (hdr !== shared && q !== shared) return (sendErr(res, 404, "not found"), true);

  const body = normalizeWeChatInbound(await readJson(req).catch(() => ({} as WeChatInbound)));
  if (url.pathname === "/api/integrations/wechat/bind") {
    const code = parseBindingCode(body as WeChatBindInbound);
    if (!code) return (sendJson(res, 200, { accepted: false, ignored: false, reason: "binding code required" }), true);
    try {
      const claimed = await claimWeChatBindingCode({
        code,
        externalUserId: body.userId,
        externalRoomId: body.roomId,
        botId: body.botId,
      });
      return (sendJson(res, 200, { accepted: true, claimed: true, expiresAt: claimed.expiresAt }), true);
    } catch (e: any) {
      return (sendJson(res, 200, { accepted: false, ignored: false, reason: String(e?.message ?? e) }), true);
    }
  }
  if (url.pathname !== "/api/integrations/wechat/webhook") return false;

  const binding = await findWeChatBindingByExternalUser(body.userId);
  if (!binding) return (sendJson(res, 200, {
    accepted: false,
    ignored: false,
    status: formatWeChatStatus({ stage: "failure" }),
    reason: "unbound wechat user",
  }), true);

  const parsed = parseWeChatCommand(body.content);
  if (!parsed) return (sendJson(res, 200, { accepted: false, ignored: true, status: formatWeChatStatus({ stage: "failure" }) }), true);

  const serverId = await serverIdForWebhook(body);
  const channel = (await db.select().from(schema.channels).where(and(
    eq(schema.channels.serverId, serverId),
    eq(schema.channels.name, "all"),
    eq(schema.channels.type, "channel"),
    isNull(schema.channels.deletedAt),
  )))[0];
  if (!channel) return (sendErr(res, 404, "all channel not found"), true);

  const agent = await resolveRoleAgent(serverId, parsed.targetAgent);
  if (!agent) return (sendJson(res, 200, {
    accepted: false,
    ignored: false,
    status: formatWeChatStatus({ stage: "failure" }),
    reason: "unknown role",
  }), true);

  const seq = await nextSeq(serverId);
  const taskNumber = await nextTaskNumber(serverId, channel);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, binding.userId)))[0];
  const [msg] = await db.insert(schema.messages).values({
    seq,
    serverId,
    channelId: channel.id,
    senderType: "user",
    senderId: binding.userId,
    senderName: user?.displayName || user?.name || "wechat-user",
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
    targetAgent: agent.name,
    taskId: msg!.id,
    taskNumber: msg!.taskNumber,
  });
  await assignTask(serverId, msg!.id, agent.id);

  pushStatus(msg!.id, body.roomId, { stage: "received" });
  pushStatus(msg!.id, body.roomId, { stage: "working", resultUrl: `thread:${msg!.id.slice(0, 8)}` });

  return (sendJson(res, 200, {
    accepted: true,
    channelId: "#all",
    targetAgent: agent.name,
    command: parsed.command,
    taskId: msg!.id,
    taskNumber: msg!.taskNumber,
    statusMessages: [
      formatWeChatStatus({ stage: "received" }),
      formatWeChatStatus({ stage: "working" }),
    ],
    threadTarget: `thread:${msg!.id.slice(0, 8)}`,
  }), true);
}

async function serverIdForWebhook(body: WeChatInbound): Promise<string> {
  const wanted = String(process.env.WECHAT_GATEWAY_SERVER_SLUG ?? "open-tag").trim() || "open-tag";
  const srv = (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.slug, wanted)))[0];
  if (srv?.id) return srv.id;
  const fallback = (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
  if (fallback?.id) return fallback.id;
  throw new Error("default workspace not found");
}
