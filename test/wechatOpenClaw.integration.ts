import "../src/env.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleWeChatWebhook } from "../src/server/wechatGateway.ts";
import { createMessage, getOrCreateThread, setTaskStatus } from "../src/server/core.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";
process.env.WECHAT_GATEWAY_TOKEN ??= "wechat-test-token";

const ts = Date.now();
let failures = 0;
let serverId = "";
let analystId = "";
let createdAnalyst = false;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(body: object, token = "wechat-test-token"): IncomingMessage {
  const payload = JSON.stringify(body);
  const readable = Readable.from([Buffer.from(payload)]);
  return Object.assign(readable, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorizationtype": "ilink_bot_token",
      "authorization": `Bearer ${token}`,
      "x-wechat-gateway-token": token,
      "x-wechat-uin": Buffer.from(String(ts)).toString("base64"),
    },
  }) as unknown as IncomingMessage;
}

function makeRes() {
  let status = 0;
  let body = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(d?: string | Buffer) { body = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}

async function call(path: string, body: object) {
  const req = makeReq(body);
  const { res, getStatus, getBody } = makeRes();
  const ok = await handleWeChatWebhook(req, res, new URL(`http://localhost${path}`), "POST");
  let parsed: any = {};
  try { parsed = JSON.parse(getBody()); } catch { parsed = { raw: getBody() }; }
  return { ok, status: getStatus(), body: parsed };
}

async function setup() {
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
  assert.ok(srv, "default workspace must exist");
  serverId = srv!.id;
  const existing = (await db.select().from(schema.agents).where(eq(schema.agents.serverId, serverId))).find((a) => a.name === "analyst" && !a.deletedAt);
  if (existing) {
    analystId = existing.id;
  } else {
    const [created] = await db.insert(schema.agents).values({
      serverId,
      name: "analyst",
      displayName: "Analyst",
      runtime: "claude",
      model: "sonnet",
    }).returning();
    analystId = created!.id;
    createdAnalyst = true;
  }
}

async function cleanup() {
  if (createdAnalyst && analystId) await db.delete(schema.agents).where(eq(schema.agents.id, analystId));
}

async function main() {
  await setup();

  console.log("\n[1] OpenClaw sendmessage routes an explicit WeChat command into #all");
  const inbound = await call("/api/integrations/wechat/openclaw/sendmessage", {
    msg: {
      from_user_id: `wx_peer_${ts}`,
      to_user_id: "wx_bot_openclaw",
      session_id: `room_openclaw_${ts}`,
      context_token: `ctx_${ts}`,
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: "@Bot #分析师 总结今日热点" } }],
    },
  });
  check("handler accepted OpenClaw sendmessage", inbound.ok === true);
  check("sendmessage returns 200", inbound.status === 200);
  check("ret is success", inbound.body.ret === 0);
  check("routes into #all", inbound.body.channel_id === "#all");
  check("routes to analyst", inbound.body.target_agent === "analyst");
  check("task id is present", typeof inbound.body.task_id === "string");
  const visibleOriginalMessages = (await db.select().from(schema.messages).where(eq(schema.messages.content, "@Bot #分析师 总结今日热点")))
    .filter((m) => m.serverId === serverId && m.messageType === "text" && m.taskStatus === null);
  check("writes the original WeChat text into #all as a visible channel message", visibleOriginalMessages.length >= 1);
  const taskMessages = (await db.select().from(schema.messages).where(eq(schema.messages.content, "总结今日热点")))
    .filter((m) => m.serverId === serverId && !!m.taskStatus);
  check("also creates a parsed agent task", taskMessages.length >= 1);
  const task = (await db.select().from(schema.messages).where(eq(schema.messages.id, inbound.body.task_id)))[0]!;
  assert.ok(task, "WeChat task should exist");

  console.log("\n[2] OpenClaw getupdates exposes queued status messages for WeChat");
  const updates = await call("/api/integrations/wechat/openclaw/getupdates", { get_updates_buf: "" });
  check("getupdates returns success", updates.body.ret === 0);
  check("getupdates returns messages", Array.isArray(updates.body.msgs) && updates.body.msgs.length >= 1);
  check("message targets original room", updates.body.msgs.some((m: any) => m.to_user_id === `room_openclaw_${ts}`));
  check("message contains text item", updates.body.msgs.some((m: any) => m.item_list?.[0]?.text_item?.text?.includes("系统提示")));

  console.log("\n[3] OpenClaw getupdates returns the agent's final answer when the task is done");
  assert.ok(task.threadId, "WeChat task should have a thread");
  await createMessage({
    serverId,
    channelId: task.threadId,
    senderType: "agent",
    senderId: analystId,
    senderName: "analyst",
    content: "这是分析师最终回答",
  });
  await setTaskStatus(serverId, task.id, "done", { type: "agent", id: analystId });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const doneUpdates = await call("/api/integrations/wechat/openclaw/getupdates", { get_updates_buf: updates.body.get_updates_buf ?? "" });
  check("done update includes the agent answer", doneUpdates.body.msgs.some((m: any) => m.item_list?.[0]?.text_item?.text?.includes("这是分析师最终回答")));

  console.log("\n[4] OpenClaw returns replies for direct @agent channel mentions");
  const direct = await call("/api/integrations/wechat/openclaw/sendmessage", {
    msg: {
      from_user_id: `wx_peer_direct_${ts}`,
      to_user_id: "wx_bot_openclaw",
      session_id: `room_direct_${ts}`,
      context_token: `ctx_direct_${ts}`,
      create_time_ms: Date.now(),
      item_list: [{ type: 1, text_item: { text: "@analyst 生成一份GEO行业洞察报告" } }],
    },
  });
  check("direct mention is accepted as an external channel request", direct.body.accepted === true);
  check("direct mention returns a source message id", typeof direct.body.message_id === "string");
  if (typeof direct.body.message_id !== "string") {
    console.log(`\n${++failures} CHECK(S) FAILED ❌`);
    return;
  }
  const directCtx = (await db.select().from(schema.externalDeliveryContexts).where(eq(schema.externalDeliveryContexts.sourceMessageId, direct.body.message_id)))[0];
  check("direct mention persists a generic external delivery context", directCtx?.platform === "wechat" && directCtx.externalConversationId === `room_direct_${ts}`);
  await call("/api/integrations/wechat/openclaw/getupdates", { get_updates_buf: doneUpdates.body.get_updates_buf ?? "" });
  const directThread = await getOrCreateThread(serverId, direct.body.message_id, { type: "agent", id: analystId });
  await createMessage({
    serverId,
    channelId: directThread.id,
    senderType: "agent",
    senderId: analystId,
    senderName: "analyst",
    content: "GEO行业洞察报告已生成",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const directUpdates = await call("/api/integrations/wechat/openclaw/getupdates", { get_updates_buf: "" });
  check("direct mention reply is returned to WeChat", directUpdates.body.msgs.some((m: any) => m.to_user_id === `room_direct_${ts}` && m.item_list?.[0]?.text_item?.text?.includes("GEO行业洞察报告已生成")));
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
