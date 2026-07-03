import "../src/env.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  applyWeChatSessionEvent,
  createWeChatLoginSession,
  getWeChatBinding,
  getWeChatLoginSessionForUser,
  unlinkWeChatBinding,
} from "../src/server/wechatBinding.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";

const ts = Date.now();
let failures = 0;
let userId = "";
let otherUserId = "";
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({
    name: `wxscan_${ts}`,
    displayName: "WeChat Scan",
    email: `wxscan_${ts}@t.local`,
  }).returning();
  const [other] = await db.insert(schema.users).values({
    name: `wxscan_other_${ts}`,
    displayName: "Other WeChat Scan",
    email: `wxscan_other_${ts}@t.local`,
  }).returning();
  userId = u!.id;
  otherUserId = other!.id;
}

async function cleanup() {
  if (userId) {
    await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.userId, userId));
    await db.delete(schema.wechatLoginSessions).where(eq(schema.wechatLoginSessions.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
  if (otherUserId) {
    await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.userId, otherUserId));
    await db.delete(schema.wechatLoginSessions).where(eq(schema.wechatLoginSessions.userId, otherUserId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  }
}

async function main() {
  await setup();

  console.log("\n[1] user can create a pending local WeChat scan session");
  const pending = await createWeChatLoginSession(userId);
  check("session belongs to user", pending.userId === userId);
  check("session starts pending", pending.status === "pending");
  check("session has future expiry", pending.expiresAt.getTime() > Date.now());
  const visible = await getWeChatLoginSessionForUser(userId, pending.id);
  check("owner can poll session", visible?.id === pending.id);
  const hidden = await getWeChatLoginSessionForUser(otherUserId, pending.id);
  check("other user cannot poll session", hidden === null);

  console.log("\n[2] adapter can attach QR and scan status");
  const qr = await applyWeChatSessionEvent({
    sessionId: pending.id,
    type: "qr",
    adapterSessionId: `adapter_${ts}`,
    qrDataUrl: "data:image/png;base64,QR",
    qrPayload: "weixin://login/test",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  check("QR event marks session ready", qr.session.status === "qr_ready");
  check("QR data is stored", qr.session.qrDataUrl === "data:image/png;base64,QR");
  const scanned = await applyWeChatSessionEvent({ sessionId: pending.id, type: "scanned" });
  check("scan event marks session scanned", scanned.session.status === "scanned");

  console.log("\n[3] adapter login event creates the active binding");
  const loggedIn = await applyWeChatSessionEvent({
    sessionId: pending.id,
    type: "login",
    botId: "wx_bot_001",
    externalUserId: `wx_user_${ts}`,
    externalNickname: "扫码微信",
    externalAvatarUrl: "https://example.test/avatar.png",
  });
  check("login event confirms session", loggedIn.session.status === "confirmed");
  check("login event returns binding", loggedIn.binding?.externalUserId === `wx_user_${ts}`);
  const binding = await getWeChatBinding(userId);
  check("binding is active after login", binding?.externalUserId === `wx_user_${ts}`);
  check("binding stores nickname", binding?.externalNickname === "扫码微信");
  check("binding stores avatar", binding?.externalAvatarUrl === "https://example.test/avatar.png");

  console.log("\n[4] duplicate active bindings are rejected and unlink revokes");
  const second = await createWeChatLoginSession(otherUserId);
  let duplicateRejected = false;
  try {
    await applyWeChatSessionEvent({ sessionId: second.id, type: "login", botId: "wx_bot_001", externalUserId: `wx_user_${ts}` });
  } catch {
    duplicateRejected = true;
  }
  check("same WeChat identity cannot bind to another user", duplicateRejected);
  const unlinked = await unlinkWeChatBinding(userId);
  check("unlink marks a binding", !!unlinked?.revokedAt);
  const after = await getWeChatBinding(userId);
  check("binding no longer active after unlink", after === null);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
