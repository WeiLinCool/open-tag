# WeChat Identity Binding and Gateway Implementation Plan

> Superseded binding detail: the implemented product path now uses local personal-WeChat QR scan sessions (`POST /api/auth/wechat-sessions` + `/api/integrations/wechat/session-events`) instead of manually copied binding codes. Historical task snippets below may still mention the earlier code-based draft.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in open-tag user bind a personal WeChat identity through a one-time web code, then use that binding to route personal WeChat bot traffic into open-tag's `#all` channel and task flow.

**Architecture:** Keep the binding flow and the WeChat gateway as separate adapters around the core. The account-settings UI mints short-lived single-use binding codes; the personal WeChat bot claims a code with its native `userId`; the logged-in user confirms the same code in the web UI, persisting a personal-WeChat-to-user mapping in a small auth-adjacent table. The gateway resolves inbound WeChat traffic through that binding before it creates tasks or emits status updates, so the core remains unaware of WeChat-specific details.

**Tech Stack:** TypeScript, React, existing `src/server` route patterns, existing `web/src/views/misc.tsx` settings surface, Drizzle/Postgres, existing realtime publish flow, current `npx tsx` and `node:test`/script-style integration tests.

## Global Constraints

- `src/` is the sole canonical implementation.
- Do not add WeChat SDK concerns to open-tag core message logic.
- MVP scope is personal WeChat bot -> open-tag `#all` only.
- Explicit `#角色` routing is the contract; free-text inference is out of scope.
- Status updates must stay minimal: received, in progress, done, failure.
- Personal WeChat binding is user-scoped, one-time, and short-lived.
- A bound WeChat identity must not be silently overwritten; explicit unlink/rebind is a separate action.

---

### Task 1: Add the binding data model and server-side code paths

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/server/wechatBinding.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/routes-api/auth.ts`
- Test: `test/wechatBinding.unit.test.ts`

**Interfaces:**
- Consumes: authenticated human user id from `verifyUser`, current account settings API shape, and `WECHAT_GATEWAY_*` env configuration if needed for display-only metadata.
- Produces: `mintWeChatBindingCode(userId)`, `claimWeChatBindingCode(input)`, `confirmWeChatBinding(userId, code)`, `getWeChatBinding(userId)`, `findWeChatBindingByExternalUser(externalUserId)`, and `unlinkWeChatBinding(userId)` for later UI and gateway use.

- [ ] **Step 1: Write the failing test**

```typescript
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";

const mod = await import("../src/server/wechatBinding.ts");

test("minting returns a short-lived single-use code", async () => {
  const minted = await mod.mintWeChatBindingCode("user-1");
  assert.equal(typeof minted.code, "string");
  assert.equal(minted.userId, "user-1");
  assert.equal(minted.usedAt, null);
  assert.ok(minted.expiresAt instanceof Date);
});

test("confirming the code creates a user binding", async () => {
  const minted = await mod.mintWeChatBindingCode("user-1");
  const bound = await mod.confirmWeChatBinding("user-1", minted.code);
  assert.equal(bound.userId, "user-1");
  assert.equal(bound.provider, "wechat_personal");
});

test("reusing or expiring a code is rejected", async () => {
  const minted = await mod.mintWeChatBindingCode("user-1");
  await mod.confirmWeChatBinding("user-1", minted.code);
  await assert.rejects(() => mod.confirmWeChatBinding("user-1", minted.code));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/wechatBinding.unit.test.ts`
Expected: FAIL because `src/server/wechatBinding.ts` and the backing schema do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/db/schema.ts
export const wechatBindings = pgTable("wechat_bindings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),
  externalUserId: text("external_user_id").notNull(),
  externalRoomId: text("external_room_id"),
  codeHash: text("code_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index("wechat_bindings_user_idx").on(t.userId),
  providerExtUniq: uniqueIndex("wechat_bindings_provider_ext_uniq").on(t.provider, t.externalUserId),
}));

// src/server/wechatBinding.ts
export async function mintWeChatBindingCode(userId: string) {
  // generate one-time code, hash before storage, short TTL, return raw code once
}
export async function confirmWeChatBinding(userId: string, code: string) {
  // verify hash, expiry, ownership, mark used, upsert binding row
}
export async function getWeChatBinding(userId: string) {
  // return active binding or null
}
export async function unlinkWeChatBinding(userId: string) {
  // mark binding inactive / deleted
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/wechatBinding.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/server/wechatBinding.ts src/server/index.ts src/server/routes-api/auth.ts test/wechatBinding.unit.test.ts
git commit -m "feat(wechat): add account binding primitives"
```

### Task 2: Add the account settings UI for binding and unlinking

**Files:**
- Modify: `web/src/views/misc.tsx`
- Modify: `web/src/locales/en.json`
- Modify: `web/src/locales/zh.json`
- Test: `test/wechatBinding.ui.test.ts`

**Interfaces:**
- Consumes: `GET /api/auth/me`, new binding endpoints from Task 1, and the existing `api()` helper in `AccountSettings`.
- Produces: a compact account-settings section that can request a binding code, submit a code, show active binding state, and unlink the binding.

- [ ] **Step 1: Write the failing test**

```typescript
import test from "node:test";
import assert from "node:assert/strict";

// Mount the account settings component with a stub api and assert the WeChat binding controls are present.
// Drive the three actions in order: mint code, confirm code, unlink.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/wechatBinding.ui.test.ts`
Expected: FAIL because `AccountSettings` does not yet render the WeChat binding section.

- [ ] **Step 3: Write minimal implementation**

```tsx
// Add a "WeChat binding" subsection to AccountSettings.
// Use a button to POST /api/auth/wechat-binding/code.
// Show a text input for the code and a confirm button to POST /api/auth/wechat-binding/confirm.
// Show current bound external id / status if present.
// Add an unlink button that calls DELETE /api/auth/wechat-binding.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/wechatBinding.ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/misc.tsx web/src/locales/en.json web/src/locales/zh.json test/wechatBinding.ui.test.ts
git commit -m "feat(wechat): add account binding UI"
```

### Task 3: Extend the WeChat gateway to resolve bound identities before routing

**Files:**
- Modify: `src/server/wechatGateway.ts`
- Modify: `src/server/index.ts`
- Test: `test/wechatGateway.binding.integration.ts`

**Interfaces:**
- Consumes: `getWeChatBinding(userId)` / external identity lookup from Task 1 and the existing `handleWeChatWebhook` entrypoint.
- Produces: `/api/integrations/wechat/bind` for bot-side code claims and an inbound resolution step that maps a personal WeChat message to the correct open-tag user before `#all` task creation and status publishing.

- [ ] **Step 1: Write the failing test**

```typescript
// 1. Seed a server, an owner user, and an active WeChat binding for that user.
// 2. Send a valid @Bot #分析师 message with a matching external user id.
// 3. Assert the webhook accepts and creates a task.
// 4. Send the same message from an unbound external user id.
// 5. Assert the webhook rejects or ignores it without creating a task.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/wechatGateway.binding.integration.ts`
Expected: FAIL because the webhook does not consult the binding table yet.

- [ ] **Step 3: Write minimal implementation**

```typescript
// Inside handleWeChatWebhook, resolve the linked open-tag user before server/channel routing.
// Reject or ignore inbound messages that are not tied to an active binding.
// Keep the existing #all task creation and status flow unchanged once the binding resolves.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/wechatGateway.binding.integration.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wechatGateway.ts src/server/index.ts test/wechatGateway.binding.integration.ts
git commit -m "feat(wechat): resolve bound identities in gateway"
```

### Task 4: Verify the full slice and update docs

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `FEATURES.md`
- Modify: `docs/tech-debt-tracker.md` if any drift is discovered
- Modify: `openspec/changes/wechat-public-channel-gateway/tasks.md`

**Interfaces:**
- Consumes: the completed binding endpoints, account UI, and gateway resolution flow.
- Produces: documented surfaces and a verified MVP slice.

- [ ] **Step 1: Run the focused tests**

Run:
- `npx tsx --test test/wechatBinding.unit.test.ts`
- `npx tsx test/wechatGateway.binding.integration.ts`
- `npx tsx test/wechatGateway.integration.ts`
- `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Update docs**

```md
# Add the new binding flow to ARCHITECTURE.md and FEATURES.md so the adapter boundary and account-settings entrypoint are documented.
```

- [ ] **Step 3: Mark the plan complete**

```bash
git add docs/superpowers/plans/2026-07-03-wechat-identity-binding-and-gateway.md openspec/changes/wechat-public-channel-gateway/tasks.md ARCHITECTURE.md FEATURES.md
git commit -m "docs: plan wechat binding and gateway slice"
```
