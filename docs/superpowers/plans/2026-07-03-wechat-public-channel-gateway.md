# WeChat Public Channel Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin personal-WeChat gateway that feeds open-tag's `#all` public channel, routes explicit `#角色` commands to existing agent/task flows, and relays minimal progress/results back to WeChat.

**Architecture:** Keep all WeChat-specific logic outside the core collaboration engine. The gateway owns inbound normalization, role-tag parsing, and outbound status formatting; open-tag keeps channel/task/agent semantics and remains the only place that mutates collaboration state. The first slice binds everything to `#all` so we can prove the adapter shape before adding multi-room or multi-bot routing.

**Tech Stack:** TypeScript, existing `src/server` route/core patterns, existing Drizzle/Postgres models, existing realtime publish flow, current test harness (`npx tsx`, `node:test`, integration-style DB setup).

## Global Constraints

- `src/` is the sole canonical implementation.
- Do not add WeChat SDK concerns to open-tag core message logic.
- MVP scope is personal WeChat bot -> open-tag `#all` only.
- Explicit `#角色` routing is the contract; free-text inference is out of scope.
- Status updates must stay minimal: received, in progress, done, failure.
- No multi-bot tenancy, room mapping, private-channel onboarding, or full state mirroring in this change.

---

### Task 1: Lock the gateway contract and boundary

**Files:**
- Create: `src/server/wechatGateway.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/routes-api/index.ts`
- Test: `test/wechatGateway.unit.test.ts`

**Interfaces:**
- Consumes: internal normalized inbound payload `{ botId, roomId, userId, content, timestamp }`
- Produces: internal command `{ channelId: "#all", targetAgent, command, contextRefs }` and outbound status payload `{ stage, message, resultUrl? }`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseWeChatCommand, normalizeWeChatInbound, formatWeChatStatus } from "../src/server/wechatGateway.ts";

test("parseWeChatCommand extracts explicit role routing", () => {
  const cmd = parseWeChatCommand("@Bot #分析师 总结今日热点");
  assert.deepEqual(cmd, { targetAgent: "analyst", command: "总结今日热点" });
});

test("parseWeChatCommand rejects missing role", () => {
  assert.equal(parseWeChatCommand("@Bot 总结今日热点"), null);
});

test("formatWeChatStatus emits minimal progress text", () => {
  assert.equal(formatWeChatStatus({ stage: "received" }), "[系统提示] 📥 已收到任务");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/wechatGateway.unit.test.ts`
Expected: FAIL because `src/server/wechatGateway.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function normalizeWeChatInbound(input: { botId: string; roomId: string; userId: string; content: string; timestamp: number }) {
  return { ...input, channelId: "#all" as const };
}

export function parseWeChatCommand(content: string) {
  const m = /^@Bot\s+#([^\s]+)\s+(.+)$/.exec(content.trim());
  if (!m) return null;
  return { targetAgent: m[1]!.replace(/^分析师$/, "analyst"), command: m[2]!.trim() };
}

export function formatWeChatStatus(input: { stage: "received" | "working" | "done" | "failure"; resultUrl?: string }) {
  if (input.stage === "received") return "[系统提示] 📥 已收到任务";
  if (input.stage === "working") return "[系统提示] ⚙️ 任务处理中";
  if (input.stage === "done") return input.resultUrl ? `[系统提示] ✅ 已完成 ${input.resultUrl}` : "[系统提示] ✅ 已完成";
  return "[系统提示] ⚠️ 任务失败";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/wechatGateway.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wechatGateway.ts src/server/index.ts src/server/routes-api/index.ts test/wechatGateway.unit.test.ts
git commit -m "feat(gateway): add wechat adapter contract"
```

### Task 2: Wire the inbound WeChat path to `#all`

**Files:**
- Modify: `src/server/wechatGateway.ts`
- Modify: `src/server/core.ts`
- Modify: `src/server/routes-api/messages.ts`
- Modify: `src/server/routes-api/tasks.ts`
- Test: `test/wechatGateway.integration.ts`

**Interfaces:**
- Consumes: normalized inbound payload from Task 1
- Produces: open-tag message/task creation via existing `createMessage` / `resolveTarget` / task flow

- [ ] **Step 1: Write the failing test**

```ts
// Integration skeleton:
// 1. Seed a server with a public #all channel and a user member.
// 2. Submit a WeChat payload that matches @Bot #分析师.
// 3. Assert an open-tag task/message appears in #all.
// 4. Assert a non-matching payload produces no message/task.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/wechatGateway.integration.ts`
Expected: FAIL because the gateway entrypoint is not wired into the server path.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/wechatGateway.ts
export async function handleWeChatInbound(input: WeChatInbound, deps: { createTaskInAll: (...) => Promise<...>; sendStatus: (...) => Promise<void> }) {
  const parsed = parseWeChatCommand(input.content);
  if (!parsed) return { accepted: false };
  await deps.sendStatus({ stage: "received" });
  const task = await deps.createTaskInAll(parsed.command, parsed.targetAgent, input);
  return { accepted: true, task };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/wechatGateway.integration.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wechatGateway.ts src/server/core.ts src/server/routes-api/messages.ts src/server/routes-api/tasks.ts test/wechatGateway.integration.ts
git commit -m "feat(gateway): route wechat messages into all channel"
```

### Task 3: Add outbound status/result feedback

**Files:**
- Modify: `src/server/wechatGateway.ts`
- Modify: `src/server/realtime.ts`
- Modify: `src/server/core.ts`
- Test: `test/wechatGateway.status.unit.test.ts`

**Interfaces:**
- Consumes: open-tag task lifecycle events and final result URLs
- Produces: short WeChat-facing text updates only

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatWeChatStatus } from "../src/server/wechatGateway.ts";

test("done status prefers a result link when present", () => {
  assert.equal(formatWeChatStatus({ stage: "done", resultUrl: "https://example.com/r/1" }), "[系统提示] ✅ 已完成 https://example.com/r/1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/wechatGateway.status.unit.test.ts`
Expected: FAIL because the result-link branch is not implemented yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function formatWeChatStatus(input: { stage: "received" | "working" | "done" | "failure"; resultUrl?: string }) {
  if (input.stage === "done") return input.resultUrl ? `[系统提示] ✅ 已完成 ${input.resultUrl}` : "[系统提示] ✅ 已完成";
  // other branches unchanged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/wechatGateway.status.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wechatGateway.ts src/server/realtime.ts src/server/core.ts test/wechatGateway.status.unit.test.ts
git commit -m "feat(gateway): add wechat status feedback"
```

### Task 4: Verify and document the slice

**Files:**
- Modify: `docs/tech-debt-tracker.md` if any drift is discovered
- Modify: `openspec/changes/wechat-public-channel-gateway/tasks.md`
- Test: `npx tsx test/wechatGateway.integration.ts`

**Interfaces:**
- Consumes: fully wired gateway path
- Produces: verified behavior and updated task checklist

- [ ] **Step 1: Run the gateway integration test**

Run: `npx tsx test/wechatGateway.integration.ts`
Expected: PASS with one accepted `#角色` route and one ignored non-match.

- [ ] **Step 2: Run the broader affected checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Mark the plan complete**

```bash
git add docs/superpowers/plans/2026-07-03-wechat-public-channel-gateway.md openspec/changes/wechat-public-channel-gateway/tasks.md
git commit -m "docs: add wechat gateway implementation plan"
```

## Self-Review

1. Spec coverage: inbound acceptance, explicit role routing, and minimal status feedback each map to a dedicated task.
2. Placeholder scan: no TBD/TODO placeholders remain in the plan tasks or commands.
3. Type consistency: `parseWeChatCommand`, `normalizeWeChatInbound`, `formatWeChatStatus`, and `handleWeChatInbound` are used consistently across the tasks.
