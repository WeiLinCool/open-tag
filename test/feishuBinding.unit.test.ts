import "../src/env.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { FEISHU_PROVIDER, getFeishuBinding, linkFeishuIdentity, unlinkFeishuBinding } from "../src/server/feishuBinding.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";

const ts = Date.now();
let failures = 0;
let userId = "";
let otherUserId = "";
let bindingId = "";
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({
    name: `feishu_${ts}`,
    displayName: "Feishu",
    email: `feishu_${ts}@t.local`,
  }).returning();
  const [other] = await db.insert(schema.users).values({
    name: `feishu_other_${ts}`,
    displayName: "Other Feishu",
    email: `feishu_other_${ts}@t.local`,
  }).returning();
  userId = u!.id;
  otherUserId = other!.id;
}

async function cleanup() {
  if (bindingId) await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.id, bindingId));
  if (userId) await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.userId, userId));
  if (otherUserId) await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.userId, otherUserId));
  if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
  if (otherUserId) await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
}

async function main() {
  await setup();

  console.log("\n[1] link and read Feishu binding");
  const row = await linkFeishuIdentity({
    userId,
    externalUserId: `fs_u_${ts}`,
    externalRoomId: `fs_room_${ts}`,
    botId: "fs_bot_1",
    externalNickname: "Feishu User",
  });
  bindingId = row.id;
  check("provider is Feishu", row.provider === FEISHU_PROVIDER);
  check("binding belongs to user", row.userId === userId);
  const found = await getFeishuBinding(userId);
  check("binding lookup returns the row", found?.id === row.id);

  console.log("\n[2] binding is single-owner and single-external-id");
  let dupUser = false;
  try {
    await linkFeishuIdentity({ userId: otherUserId, externalUserId: `fs_u_${ts}` });
  } catch {
    dupUser = true;
  }
  check("same external user cannot bind twice", dupUser);

  let dupOwner = false;
  try {
    await linkFeishuIdentity({ userId: userId, externalUserId: `fs_u_${ts}_2` });
  } catch {
    dupOwner = true;
  }
  check("same open-tag user cannot bind twice", dupOwner);

  console.log("\n[3] unlink revokes the binding");
  const unlinked = await unlinkFeishuBinding(userId);
  check("unlink returns a row", !!unlinked?.revokedAt);
  const after = await getFeishuBinding(userId);
  check("binding no longer active after unlink", after === null);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
