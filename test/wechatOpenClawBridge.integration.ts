import "../src/env.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { routeOpenClawWeChatMessage } from "../src/server/wechatGateway.ts";
import { flushWeChatStatusOutbox, pollOpenClawWeixinAccount, type OpenClawWeixinAccount } from "../src/server/wechatOpenClawBridge.ts";
import { createMessage, createServer, getOrCreateThread, setTaskStatus } from "../src/server/core.ts";
import { uploadsDir } from "../src/paths.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";

const ts = Date.now();
let failures = 0;
let analystId = "";
let createdAnalyst = false;
let personalServerId = "";
let personalOwnerId = "";
let personalAnalystId = "";
let createdPersonalAnalyst = false;
const createdAttachmentIds: string[] = [];
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function createStoredAttachment(input: {
  serverId: string;
  channelId: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}) {
  const key = `wechat-bridge-${ts}-${input.filename.replace(/[^\w.-]/g, "_")}`;
  await mkdir(uploadsDir(), { recursive: true });
  await writeFile(path.join(uploadsDir(), key), input.bytes);
  const [att] = await db.insert(schema.attachments).values({
    serverId: input.serverId,
    channelId: input.channelId,
    uploaderType: "agent",
    uploaderId: input.uploaderId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.length,
    storageKey: key,
  }).returning();
  createdAttachmentIds.push(att!.id);
  return att!;
}

async function setup() {
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
  assert.ok(srv, "default workspace must exist");
  const existing = (await db.select().from(schema.agents).where(eq(schema.agents.serverId, srv.id))).find((a) => a.name === "analyst" && !a.deletedAt);
  if (existing) {
    analystId = existing.id;
  } else {
    const [created] = await db.insert(schema.agents).values({
      serverId: srv.id,
      name: "analyst",
      displayName: "Analyst",
      runtime: "claude",
      model: "sonnet",
    }).returning();
    analystId = created!.id;
    createdAnalyst = true;
  }

  const [owner] = await db.insert(schema.users).values({
    name: `wechat-owner-${ts}`,
    displayName: "WeChat Owner",
    email: `wechat-owner-${ts}@example.test`,
  }).returning();
  personalOwnerId = owner!.id;
  const personalServer = await createServer("WeChat Owner workspace", `wechat-owner-${ts}`, personalOwnerId);
  personalServerId = personalServer.id;
  const [personalAnalyst] = await db.insert(schema.agents).values({
    serverId: personalServerId,
    name: "analyst",
    displayName: "Analyst",
    runtime: "claude",
    model: "sonnet",
  }).returning();
  personalAnalystId = personalAnalyst!.id;
  createdPersonalAnalyst = true;
}

async function cleanup() {
  for (const id of createdAttachmentIds) await db.delete(schema.attachments).where(eq(schema.attachments.id, id));
  if (createdPersonalAnalyst && personalAnalystId) await db.delete(schema.agents).where(eq(schema.agents.id, personalAnalystId));
  if (personalServerId) {
    const personalChannels = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, personalServerId));
    for (const ch of personalChannels) {
      await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
      const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.channelId, ch.id));
      for (const msg of msgs) {
        await db.delete(schema.externalDeliveryContexts).where(eq(schema.externalDeliveryContexts.sourceMessageId, msg.id));
        await db.delete(schema.externalDeliveryContexts).where(eq(schema.externalDeliveryContexts.taskMessageId, msg.id));
        await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, msg.id));
      }
      await db.delete(schema.messages).where(eq(schema.messages.channelId, ch.id));
    }
  }
  if (personalServerId) await db.delete(schema.channels).where(eq(schema.channels.serverId, personalServerId));
  if (personalServerId) await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, personalServerId));
  if (personalServerId) await db.delete(schema.servers).where(eq(schema.servers.id, personalServerId));
  if (personalOwnerId) await db.delete(schema.users).where(eq(schema.users.id, personalOwnerId));
  if (createdAnalyst && analystId) await db.delete(schema.agents).where(eq(schema.agents.id, analystId));
}

async function main() {
  await setup();

  const calls: Array<{ url: string; body: any }> = [];
  let deliveredInbound = false;
  const account: OpenClawWeixinAccount = { accountId: "acct-test", token: "tok-test", baseUrl: "http://weixin.test", ownerUserId: personalOwnerId };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("http://weixin-cdn.test/upload/")) {
      calls.push({ url: String(url), body: { ciphertextBytes: (init?.body as Uint8Array | undefined)?.byteLength ?? 0 } });
      return new Response("", { status: 200, headers: { "x-encrypted-param": `download-${String(url).split("/").pop()}` } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/ilink/bot/getupdates")) {
      const msgs = deliveredInbound ? [] : [{
        from_user_id: `wx_peer_bridge_${ts}`,
        to_user_id: "wx_bot",
        session_id: `wx_peer_bridge_${ts}`,
        context_token: `ctx_bridge_${ts}`,
        create_time_ms: Date.now(),
        item_list: [{ type: 1, text_item: { text: "@Bot #分析师 桥接测试" } }],
      }];
      deliveredInbound = true;
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: deliveredInbound ? "cursor-2" : "cursor-1",
        msgs,
      }), { status: 200 });
    }
    if (String(url).endsWith("/ilink/bot/getuploadurl")) {
      return new Response(JSON.stringify({
        ret: 0,
        upload_full_url: `http://weixin-cdn.test/upload/${body.filekey}`,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  }) as typeof fetch;

  console.log("\n[1] OpenClaw Weixin bridge routes iLink updates into #all and sends status");
  await pollOpenClawWeixinAccount(account, { fetchImpl, state: { accountId: account.accountId, cursor: "", busy: false } });
  const sendCalls = calls.filter((c) => c.url.endsWith("/ilink/bot/sendmessage"));
  check("polls getupdates", calls.some((c) => c.url.endsWith("/ilink/bot/getupdates")));
  check("sends status messages back to WeChat", sendCalls.length >= 1);
  check("status targets original sender", sendCalls.some((c) => c.body?.msg?.to_user_id === `wx_peer_bridge_${ts}`));
  check("status carries context token", sendCalls.some((c) => c.body?.msg?.context_token === `ctx_bridge_${ts}`));
  check("status contains system prompt", sendCalls.some((c) => c.body?.msg?.item_list?.[0]?.text_item?.text?.includes("系统提示")));

  const created = (await db.select().from(schema.messages).where(eq(schema.messages.content, "桥接测试")))
    .filter((m) => m.serverId === personalServerId);
  const original = (await db.select().from(schema.messages).where(eq(schema.messages.content, "@Bot #分析师 桥接测试")))
    .filter((m) => m.serverId === personalServerId && m.messageType === "text" && m.taskStatus === null);
  check("writes the original WeChat text into the QR login user's #all", original.length >= 1);
  check("routes into the QR login user's workspace", created.length >= 1);

  console.log("\n[2] OpenClaw Weixin bridge sends the agent final answer back to WeChat");
  const task = created[0]!;
  assert.ok(task.threadId, "bridge task should have a thread");
  const imageAtt = await createStoredAttachment({
    serverId: personalServerId,
    channelId: task.threadId,
    uploaderId: personalAnalystId,
    filename: "chart.png",
    mimeType: "image/png",
    bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  });
  await createMessage({
    serverId: personalServerId,
    channelId: task.threadId,
    senderType: "agent",
    senderId: personalAnalystId,
    senderName: "analyst",
    content: "桥接最终回答",
    attachmentIds: [imageAtt.id],
  });
  await setTaskStatus(personalServerId, task.id, "done", { type: "agent", id: personalAnalystId });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await pollOpenClawWeixinAccount(account, { fetchImpl, state: { accountId: account.accountId, cursor: "cursor-1", busy: false } });
  check("final answer is sent to WeChat", calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && c.body?.msg?.item_list?.[0]?.text_item?.text?.includes("桥接最终回答")));
  check("final answer attachment is uploaded through getuploadurl", calls.some((c) => c.url.endsWith("/ilink/bot/getuploadurl") && c.body?.media_type === 1));
  check("final answer image is sent as a WeChat image item", calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && c.body?.msg?.item_list?.[0]?.type === 2 && c.body?.msg?.item_list?.[0]?.image_item?.media?.encrypt_query_param));

  console.log("\n[3] OpenClaw Weixin bridge sends direct @agent thread replies back to WeChat");
  const routed = await routeOpenClawWeChatMessage({
    botId: "openclaw-weixin",
    roomId: `wx_peer_direct_bridge_${ts}`,
    userId: `wx_peer_direct_bridge_${ts}`,
    msgType: "text",
    content: "@analyst 生成一份GEO行业洞察报告",
    timestamp: Date.now(),
    channelId: "#all",
    contextToken: `ctx_direct_bridge_${ts}`,
    replyToUserId: `wx_peer_direct_bridge_${ts}`,
    targetUserId: personalOwnerId,
  });
  assert.equal(routed.accepted, true);
  assert.ok(routed.messageId);
  const thread = await getOrCreateThread(personalServerId, routed.messageId, { type: "agent", id: personalAnalystId });
  const docAtt = await createStoredAttachment({
    serverId: personalServerId,
    channelId: thread.id,
    uploaderId: personalAnalystId,
    filename: "行业报告-预览.html",
    mimeType: "text/html",
    bytes: Buffer.from("<html><body>行业报告</body></html>"),
  });
  await createMessage({
    serverId: personalServerId,
    channelId: thread.id,
    senderType: "agent",
    senderId: personalAnalystId,
    senderName: "analyst",
    content: "GEO行业洞察报告已生成",
    attachmentIds: [docAtt.id],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await pollOpenClawWeixinAccount(account, { fetchImpl, state: { accountId: account.accountId, cursor: "cursor-2", busy: false } });
  check("direct thread reply is sent to WeChat", calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && c.body?.msg?.to_user_id === `wx_peer_direct_bridge_${ts}` && c.body?.msg?.item_list?.[0]?.text_item?.text?.includes("GEO行业洞察报告已生成")));
  check("direct thread HTML attachment is uploaded as an image preview", calls.some((c) => c.url.endsWith("/ilink/bot/getuploadurl") && c.body?.media_type === 1));
  check("direct thread HTML attachment is sent as a WeChat image item", calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && c.body?.msg?.to_user_id === `wx_peer_direct_bridge_${ts}` && c.body?.msg?.item_list?.[0]?.type === 2 && c.body?.msg?.item_list?.[0]?.image_item?.media?.encrypt_query_param));
  check("html attachment emits a text preview", calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && c.body?.msg?.item_list?.[0]?.type === 1 && String(c.body?.msg?.item_list?.[0]?.text_item?.text ?? "").includes("HTML预览：行业报告-预览.html")));
  check("html attachment mentions the original open-tag artifact", calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && String(c.body?.msg?.item_list?.[0]?.text_item?.text ?? "").includes("原件：open-tag 附件")));
  check("html attachment no longer emits a html file card", !calls.some((c) => c.url.endsWith("/ilink/bot/sendmessage") && c.body?.msg?.item_list?.[0]?.type === 4 && String(c.body?.msg?.item_list?.[0]?.file_item?.file_name ?? "").endsWith(".html")));
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
