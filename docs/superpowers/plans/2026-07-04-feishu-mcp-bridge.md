# Feishu MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple Feishu users in a shared collaboration flow map into open-tag human identities and channels, while reusing official Feishu OpenAPI/MCP tooling and proven open-source bridges instead of rebuilding transport plumbing from scratch.

**Architecture:** Keep the reusable capability surface in open-tag as MCP tools, keep Feishu as a thin transport/identity bridge, and preserve open-tag as the source of truth for human identity, permissions, channel visibility, and task semantics. The implementation should first validate which existing Feishu components can be reused safely, then wire only the missing open-tag-specific binding and routing pieces.

**Tech Stack:** TypeScript, existing `src/server` adapter patterns, Drizzle/Postgres, existing `external_identities` / `external_delivery_contexts` tables, Feishu OpenAPI/MCP tooling, official Feishu CLI/event bridge where applicable, node:test / integration tests.

## Global Constraints

- `src/` is the sole canonical implementation.
- Feishu is a human-bound external channel, not a new auth plane.
- Prefer official Feishu OpenAPI/MCP tooling and proven open-source bridges before custom transport code.
- Do not re-implement Feishu protocol handling if existing tooling already covers it safely.
- open-tag remains the source of truth for user permissions, channel membership, and message/task routing.
- MCP is the reusable capability layer; it does not replace open-tag authorization.
- Keep the first slice text-focused; no Docs/Bitable/cards/thread sync in this plan.

---

### Task 1: Validate the reusable Feishu stack and lock the integration shape

**Files:**
- Modify: `docs/tech-debt-tracker.md`
- Modify: `ARCHITECTURE.md`
- Create: `docs/superpowers/specs/2026-07-04-feishu-mcp-bridge-notes.md`

**Interfaces:**
- Consumes: the open-source Feishu capability set already evaluated in research, plus the existing open-tag external adapter boundaries.
- Produces: a documented implementation decision that names the chosen Feishu/OpenAPI/MCP bridge approach and the parts open-tag still owns.

- [ ] **Step 1: Write the decision note**

```md
# Feishu MCP Bridge Notes

Decisions:
- Use official Feishu OpenAPI/MCP tooling for reusable capability calls where possible.
- Use existing event/CLI bridge behavior where it already solves transport.
- Keep open-tag responsible for identity binding, permission mapping, and channel semantics.

Rejected:
- Full custom Feishu protocol stack.
- A separate Feishu auth plane detached from open-tag identities.
```

- [ ] **Step 2: Review the notes against the current architecture**

Run: `sed -n '1,220p' docs/superpowers/specs/2026-07-04-feishu-mcp-bridge-notes.md`
Expected: the note clearly states what is reused and what stays in repo-owned code.

- [ ] **Step 3: Update the project docs**

```md
// ARCHITECTURE.md: add Feishu MCP bridge to the external adapter boundary section.
// docs/tech-debt-tracker.md: record any remaining gaps in Feishu reuse as deliberate follow-up debt.
```

- [ ] **Step 4: Verify the documentation mentions the reuse-first rule**

Run: `rg -n "Feishu|MCP|reuse|OpenAPI|CLI|bridge" ARCHITECTURE.md docs/tech-debt-tracker.md docs/superpowers/specs/2026-07-04-feishu-mcp-bridge-notes.md -S`
Expected: hits show the reuse-first rule and the boundaries cleanly.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md docs/tech-debt-tracker.md docs/superpowers/specs/2026-07-04-feishu-mcp-bridge-notes.md
git commit -m "docs: record Feishu MCP bridge reuse strategy"
```

### Task 2: Add the Feishu binding and conversation-mapping primitives

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/server/feishuBinding.ts`
- Modify: `src/server/routes-api/auth.ts`
- Test: `test/feishuBinding.unit.test.ts`

**Interfaces:**
- Consumes: `external_identities`, `external_delivery_contexts`, human auth user id, and the existing revocation pattern from `wechatBinding.ts`.
- Produces: `getFeishuBinding(userId)`, `linkFeishuIdentity(...)`, `unlinkFeishuBinding(userId)`, `findFeishuBindingByExternalUser(externalUserId)`, plus conversation-context helpers for one Feishu room/group ↔ one open-tag channel mapping.

- [ ] **Step 1: Write the failing test**

```typescript
import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/server/feishuBinding.ts");

test("binding lookups are user-scoped and provider-scoped", async () => {
  const binding = await mod.linkFeishuIdentity({
    userId: "user-1",
    externalUserId: "feishu-u-1",
    externalRoomId: "feishu-room-1",
  });
  assert.equal(binding.provider, "feishu_personal");
  assert.equal(binding.userId, "user-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/feishuBinding.unit.test.ts`
Expected: FAIL because the Feishu binding helpers do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// Reuse the existing external identity shape where possible.
// Keep active-provider uniqueness per user.
// Add a separate Feishu provider constant and room mapping helpers.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/feishuBinding.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/server/feishuBinding.ts src/server/routes-api/auth.ts test/feishuBinding.unit.test.ts
git commit -m "feat(feishu): add binding primitives"
```

### Task 3: Expose the open-tag MCP capability surface used by Feishu

**Files:**
- Create: `src/server/mcp/feishuTools.ts`
- Create: `src/server/mcp/index.ts`
- Modify: `src/server/index.ts`
- Test: `test/feishuMcp.unit.test.ts`

**Interfaces:**
- Consumes: open-tag permissions and existing message/task/channel helpers.
- Produces: a narrow MCP tool set for message creation, channel lookup, task action, and reply routing that the Feishu bridge can call.

- [ ] **Step 1: Write the failing test**

```typescript
import test from "node:test";
import assert from "node:assert/strict";

const mcp = await import("../src/server/mcp/feishuTools.ts");

test("mcp surface exposes the minimal bridge tools", () => {
  assert.equal(typeof mcp.sendChannelMessage, "function");
  assert.equal(typeof mcp.resolveFeishuConversation, "function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/feishuMcp.unit.test.ts`
Expected: FAIL because the MCP surface does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// Export only the tools Feishu needs first.
// Keep authorization checks inside the tool implementations.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/feishuMcp.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/feishuTools.ts src/server/mcp/index.ts src/server/index.ts test/feishuMcp.unit.test.ts
git commit -m "feat(mcp): add Feishu bridge tools"
```

### Task 4: Wire the Feishu bridge to the reusable transport path

**Files:**
- Create: `src/server/feishuGateway.ts`
- Create: `src/server/feishuBridge.ts`
- Modify: `src/server/index.ts`
- Test: `test/feishuGateway.integration.ts`

**Interfaces:**
- Consumes: Feishu event payloads, the binding helpers from Task 2, and the MCP tool surface from Task 3.
- Produces: inbound text routing for linked users and outbound text delivery for MCP results, while leaving open-tag permission checks intact.

- [ ] **Step 1: Write the failing test**

```typescript
// 1. Seed a Feishu binding for one human user.
// 2. Send a valid inbound text event from that external identity.
// 3. Assert the bridge routes it through MCP and into open-tag.
// 4. Send an unbound event.
// 5. Assert it is rejected or ignored.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/feishuGateway.integration.ts`
Expected: FAIL because the Feishu gateway and bridge do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// Prefer any existing Feishu event bridge or SDK path first.
// Only fill in the open-tag-specific identity and routing glue here.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/feishuGateway.integration.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/feishuGateway.ts src/server/feishuBridge.ts src/server/index.ts test/feishuGateway.integration.ts
git commit -m "feat(feishu): wire bridge through MCP"
```

### Task 5: Verify the slice and update user-facing docs

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `FEATURES.md`
- Modify: `README.md`
- Test: `npm run typecheck`

**Interfaces:**
- Consumes: the implemented Feishu bridge, binding primitives, and MCP surface.
- Produces: updated docs that describe the Feishu collaboration flow as a human-bound, reuse-first bridge.

- [ ] **Step 1: Run static verification**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Update the architecture and feature docs**

```md
// ARCHITECTURE.md: describe Feishu as a human-bound external channel with MCP-backed capability reuse.
// FEATURES.md: mark the Feishu bridge slice as implemented.
// README.md: add the verified Feishu/MCP usage path if it is user-visible.
```

- [ ] **Step 3: Re-run the targeted integration tests**

Run: `npx tsx --test test/feishuBinding.unit.test.ts && npx tsx --test test/feishuMcp.unit.test.ts && npx tsx test/feishuGateway.integration.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md FEATURES.md README.md
git commit -m "docs: describe Feishu MCP bridge"
```
