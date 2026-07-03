import "../src/env.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { mintWeChatBindingCode } from "../src/server/wechatBinding.ts";
import { handleWeChatWebhook } from "../src/server/wechatGateway.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";
process.env.WECHAT_GATEWAY_TOKEN ??= "wechat-test-token";

const ts = Date.now();
let failures = 0;
let serverId = "";
let ownerId = "";
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

async function call(path: string, body: object) {
  const req = makeReq(body);
  const { res, getStatus, getBody } = makeRes();
  const ok = await handleWeChatWebhook(req, res, new URL(`http://localhost${path}?token=wechat-test-token`), "POST");
  let parsed: any = {};
  try { parsed = JSON.parse(getBody()); } catch { parsed = { raw: getBody() }; }
  return { ok, status: getStatus(), body: parsed };
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
}

async function cleanup() {
  await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.userId, ownerId));
  await db.delete(schema.externalIdentityCodes).where(eq(schema.externalIdentityCodes.userId, ownerId));
  if (createdAnalyst && analystId) await db.delete(schema.agents).where(eq(schema.agents.id, analystId));
}

async function main() {
  await setup();

  console.log("\n[1] unbound WeChat user is rejected before task routing");
  const unbound = await call("/api/integrations/wechat/webhook", {
    botId: "wx_bot_001",
    roomId: "room_binding",
    userId: `wx_unbound_${ts}`,
    msgType: "text",
    content: "@Bot #分析师 总结今日热点",
    timestamp: Date.now(),
  });
  check("unbound request handled", unbound.ok === true);
  check("unbound returns 200", unbound.status === 200);
  check("unbound is not accepted", unbound.body.accepted === false);
  check("unbound reason is explicit", unbound.body.reason === "unbound wechat user");

  console.log("\n[2] bot can claim a web-generated binding code");
  const minted = await mintWeChatBindingCode(ownerId);
  const claim = await call("/api/integrations/wechat/bind", {
    botId: "wx_bot_001",
    roomId: "room_binding",
    userId: `wx_bound_${ts}`,
    msgType: "text",
    content: `#绑定 ${minted.code}`,
    timestamp: Date.now(),
  });
  check("bind claim accepted", claim.body.accepted === true);
  const { confirmWeChatBinding } = await import("../src/server/wechatBinding.ts");
  const binding = await confirmWeChatBinding(ownerId, minted.code);
  check("confirmed binding stores external id", binding.externalUserId === `wx_bound_${ts}`);

  console.log("\n[3] bound user can route an explicit role command");
  const routed = await call("/api/integrations/wechat/webhook", {
    botId: "wx_bot_001",
    roomId: "room_binding",
    userId: `wx_bound_${ts}`,
    msgType: "text",
    content: "@Bot #分析师 总结今日热点",
    timestamp: Date.now(),
  });
  check("bound request accepted", routed.body.accepted === true);
  check("routes into #all", routed.body.channelId === "#all");
  check("routes to analyst", routed.body.targetAgent === "analyst");
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
