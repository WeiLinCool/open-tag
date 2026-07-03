import "../src/env.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  claimWeChatBindingCode,
  confirmWeChatBinding,
  getWeChatBinding,
  mintWeChatBindingCode,
  unlinkWeChatBinding,
} from "../src/server/wechatBinding.ts";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";

const ts = Date.now();
let failures = 0;
let userId = "";
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({
    name: `wxbind_${ts}`,
    displayName: "WeChat Bind",
    email: `wxbind_${ts}@t.local`,
  }).returning();
  userId = u!.id;
}

async function cleanup() {
  if (!userId) return;
  await db.delete(schema.externalIdentities).where(eq(schema.externalIdentities.userId, userId));
  await db.delete(schema.externalIdentityCodes).where(eq(schema.externalIdentityCodes.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}

async function main() {
  await setup();

  console.log("\n[1] minting returns a short-lived code");
  const minted = await mintWeChatBindingCode(userId);
  check("code is a string", typeof minted.code === "string" && minted.code.length >= 6);
  check("code belongs to user", minted.userId === userId);
  check("code is unused", minted.usedAt === null);
  check("code has future expiry", minted.expiresAt.getTime() > Date.now());

  console.log("\n[2] unclaimed code cannot be confirmed");
  let unclaimedRejected = false;
  try { await confirmWeChatBinding(userId, minted.code); } catch { unclaimedRejected = true; }
  check("confirm before bot claim rejects", unclaimedRejected);

  console.log("\n[3] claimed code creates an active binding");
  await claimWeChatBindingCode({ code: minted.code, externalUserId: `wx_user_${ts}`, externalRoomId: "room_a", botId: "bot_a" });
  const bound = await confirmWeChatBinding(userId, minted.code);
  check("binding uses current user", bound.userId === userId);
  check("binding uses wechat provider", bound.provider === "wechat_personal");
  check("binding stores external id", bound.externalUserId === `wx_user_${ts}`);
  const current = await getWeChatBinding(userId);
  check("get returns active binding", current?.externalUserId === `wx_user_${ts}`);

  console.log("\n[4] reuse and unlink behavior");
  let reuseRejected = false;
  try { await confirmWeChatBinding(userId, minted.code); } catch { reuseRejected = true; }
  check("used code rejects", reuseRejected);
  const unlinked = await unlinkWeChatBinding(userId);
  check("unlink marks a binding", !!unlinked?.revokedAt);
  const after = await getWeChatBinding(userId);
  check("binding no longer active after unlink", after === null);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
