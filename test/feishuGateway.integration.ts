import "../src/env.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleFeishuWebhook, routeFeishuOutbound } from "../src/server/feishuGateway.ts";
import { findExternalDeliveryContextByMessage } from "../src/server/externalContexts.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";
process.env.FEISHU_VERIFICATION_TOKEN ??= "feishu-test-token";
process.env.FEISHU_SIGNING_SECRET ??= "feishu-signing-secret";
process.env.FEISHU_TENANT_ACCESS_TOKEN ??= "feishu-tenant-token";

const ts = Date.now();
let failures = 0;
let userId = "";
let serverId = "";
let channelId = "";
let bindingId = "";
let messageId = "";
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function signBody(body: string, tsValue = String(Date.now()), nonce = `n-${ts}`) {
  const sig = crypto.createHmac("sha256", process.env.FEISHU_SIGNING_SECRET!).update(`${tsValue}\n${nonce}\n${body}`).digest("hex");
  return { tsValue, nonce, sig };
}

function makeReq(body: object): IncomingMessage {
  const payload = JSON.stringify(body);
  const { tsValue, nonce, sig } = signBody(payload);
  const readable = Readable.from([Buffer.from(payload)]);
  return Object.assign(readable, {
    method: "POST",
    url: "/api/integrations/feishu/webhook",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": tsValue,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": sig,
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

async function setup() {
  const [u] = await db.insert(schema.users).values({
    name: `feishu_owner_${ts}`,
    displayName: "Feishu Owner",
    email: `feishu_owner_${ts}@t.local`,
  }).returning();
  userId = u!.id;
  const [srv] = await db.insert(schema.servers).values({
    name: `Feishu Workspace ${ts}`,
    slug: `feishu-workspace-${ts}`,
    ownerId: userId,
  }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId, role: "owner" });
  const [ch] = await db.insert(schema.channels).values({ serverId, name: "all", type: "channel" }).returning();
  channelId = ch!.id;
  await db.insert(schema.channelMembers).values({ channelId, memberType: "user", memberId: userId });
  const row = await db.insert(schema.externalIdentities).values({
    userId,
    provider: "feishu_personal",
    externalUserId: `fs_user_${ts}`,
    externalRoomId: `fs_chat_${ts}`,
    botId: "fs_bot_1",
  }).returning();
  bindingId = row[0]!.id;
}

async function cleanup() {
  if (messageId) await db.delete(schema.externalDeliveryContexts).where(eq(schema.externalDeliveryContexts.sourceMessageId, messageId));
  if (bindingId) await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.id, bindingId));
  if (serverId) {
    const channels = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
    for (const ch of channels) {
      await db.delete(schema.externalDeliveryContexts).where(eq(schema.externalDeliveryContexts.channelId, ch.id));
      await db.delete(schema.messages).where(eq(schema.messages.channelId, ch.id));
      await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
      await db.delete(schema.channels).where(eq(schema.channels.id, ch.id));
    }
  }
  if (serverId) await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  if (serverId) await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
}

async function main() {
  await setup();

  console.log("\n[1] url_verification challenge is echoed");
  const challengeBody = { type: "url_verification", challenge: "abc123", verification_token: "feishu-test-token" };
  const req = makeReq(challengeBody);
  const { res, getStatus, getBody } = makeRes();
  const ok = await handleFeishuWebhook(req, res, new URL("http://localhost/api/integrations/feishu/webhook"), "POST");
  check("handler accepted challenge", ok === true);
  check("challenge returns 200", getStatus() === 200);
  check("challenge echoed", JSON.parse(getBody()).challenge === "abc123");

  console.log("\n[2] inbound message event is accepted");
  const inbound = {
    type: "event_callback",
    header: { event_type: "im.message.receive_v1" },
    event: {
      chat_id: `fs_chat_${ts}`,
      sender: { sender_id: { open_id: `fs_user_${ts}` } },
      message: { content: JSON.stringify({ text: "hello from feishu" }) },
    },
    verification_token: "feishu-test-token",
  };
  const req2 = makeReq(inbound);
  const { res: res2, getStatus: getStatus2, getBody: getBody2 } = makeRes();
  const ok2 = await handleFeishuWebhook(req2, res2, new URL("http://localhost/api/integrations/feishu/webhook"), "POST");
  check("handler accepted message event", ok2 === true);
  check("message event returns 200", getStatus2() === 200);
  const parsed2 = JSON.parse(getBody2());
  check("message event accepted", parsed2.accepted === true);
  messageId = parsed2.messageId;
  const ctx = await findExternalDeliveryContextByMessage(messageId);
  check("delivery context is persisted", ctx?.platform === "feishu" && ctx.externalConversationId === `fs_chat_${ts}`);

  console.log("\n[3] outbound message uses Feishu API transport");
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async (input: any, init?: any) => {
    called = true;
    check("calls Feishu message API", String(input).includes("/im/v1/messages"));
    const body = JSON.parse(String(init?.body ?? "{}"));
    check("sends chat_id", body.receive_id_type === "chat_id");
    check("sends text", body.msg_type === "text");
    return new Response(JSON.stringify({ data: { message_id: "feishu-message-1" } }), { status: 200 });
  }) as typeof fetch;
  const out = await routeFeishuOutbound(messageId, "reply from open-tag");
  globalThis.fetch = originalFetch;
  check("outbound route returns ok", out?.ok === true);
  check("fetch called", called === true);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
