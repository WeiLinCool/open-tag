import "../src/env.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { drainWeChatOutbox, handleWeChatWebhook } from "../src/server/wechatGateway.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";
process.env.WECHAT_GATEWAY_TOKEN ??= "wechat-test-token";

const ts = Date.now();
let failures = 0;
let analystId = "";
let serverId = "";
let ownerId = "";
let createdAnalyst = false;
let identityId = "";
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(body: object, token = "wechat-test-token"): IncomingMessage {
  const payload = JSON.stringify(body);
  const readable = Readable.from([Buffer.from(payload)]);
  return Object.assign(readable, {
    method: "POST",
    url: "/api/integrations/wechat/webhook?token=" + token,
    headers: {
      "content-type": "application/json",
      "x-wechat-gateway-token": token,
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
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
  assert.ok(srv, "default workspace must exist");
  serverId = srv!.id;
  ownerId = srv!.ownerId;
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
  const [identity] = await db.insert(schema.externalIdentities).values({
    userId: ownerId,
    provider: "wechat_personal",
    externalUserId: `wx_user_${ts}`,
    externalRoomId: "room_1",
    botId: "wx_bot_001",
  }).returning();
  identityId = identity!.id;
}

async function cleanup() {
  if (identityId) await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.id, identityId));
  if (createdAnalyst && analystId) await db.delete(schema.agents).where(eq(schema.agents.id, analystId));
}

async function main() {
  await setup();

  console.log("\n[1] webhook accepts explicit role routing on the default workspace");
  const req = makeReq({
    botId: "wx_bot_001",
    roomId: "room_1",
    userId: `wx_user_${ts}`,
    msgType: "text",
    content: "@Bot #分析师 总结今日热点",
    timestamp: Date.now(),
  });
  const { res, getStatus, getBody } = makeRes();
  const ok = await handleWeChatWebhook(req, res, new URL("http://localhost/api/integrations/wechat/webhook?token=wechat-test-token"), "POST");
  check("handler accepted webhook", ok === true);
  check("HTTP status is 200", getStatus() === 200);
  const parsed = JSON.parse(getBody());
  check("accepted flag is true", parsed.accepted === true);
  check("routes into #all", parsed.channelId === "#all");
  check("routes to analyst", parsed.targetAgent === "analyst");
  check("task id is present", typeof parsed.taskId === "string");
  const out = drainWeChatOutbox();
  check("queued status updates", out.length >= 2);

  console.log("\n[2] webhook ignores ineligible content");
  const req2 = makeReq({
    botId: "wx_bot_001",
    roomId: "room_2",
    userId: `wx_user_${ts}`,
    msgType: "text",
    content: "plain text",
    timestamp: Date.now(),
  });
  const { res: res2, getStatus: getStatus2, getBody: getBody2 } = makeRes();
  const ok2 = await handleWeChatWebhook(req2, res2, new URL("http://localhost/api/integrations/wechat/webhook?token=wechat-test-token"), "POST");
  check("handler accepted ignored payload", ok2 === true);
  check("ignored payload returns 200", getStatus2() === 200);
  const parsed2 = JSON.parse(getBody2());
  check("ignored payload is marked accepted=false", parsed2.accepted === false);
  check("ignored payload is marked ignored=true", parsed2.ignored === true);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
