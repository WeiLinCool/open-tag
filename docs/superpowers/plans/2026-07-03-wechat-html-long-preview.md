# WeChat HTML Long Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver HTML artifacts to WeChat as a single long-image preview plus text summary, while keeping the original HTML as the canonical open-tag artifact.

**Architecture:** HTML handling becomes a special path in the OpenClaw bridge. The bridge keeps the original HTML attachment in open-tag, generates a single vertical preview image for WeChat, and sends a short summary that points back to the source message/attachment. Non-HTML attachments keep their existing behavior.

**Tech Stack:** TypeScript, node:test, Playwright for headless HTML rendering, existing OpenClaw WeChat bridge, existing attachment storage.

## Global Constraints

- HTML must remain the original artifact in open-tag.
- WeChat must receive a single long-image preview for HTML, not an interactive `.html` attachment.
- The original HTML path in open-tag must remain untouched for desktop/web review.
- Non-HTML attachments must keep their current delivery behavior.
- TypeScript throughout; verification must include `npm run typecheck`.

---

### Task 1: Build the HTML preview helper

**Files:**
- Create: `src/server/htmlPreview.ts`
- Create: `test/htmlPreview.unit.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: HTML source string, attachment filename, MIME type.
- Produces: `isHtmlAttachment(filename, mimeType)`, `htmlToPreviewText(html, filename)`, `fallbackWechatFilename(filename)`, and a browser-backed `renderHtmlLongPreview(html)` that returns a PNG buffer.

- [ ] **Step 1: Write the failing tests**

Add `test/htmlPreview.unit.test.ts` with these assertions:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToPreviewText, isHtmlAttachment, fallbackWechatFilename } from "../src/server/htmlPreview.ts";

test("detects html attachments", () => {
  assert.equal(isHtmlAttachment("方案.html", "text/html"), true);
  assert.equal(isHtmlAttachment("方案.txt", "text/plain"), false);
});

test("builds a readable preview summary", () => {
  const out = htmlToPreviewText("<h1>标题</h1><p>正文</p>", "方案.html");
  assert.match(out, /HTML预览：方案\.html/);
  assert.match(out, /标题/);
  assert.match(out, /正文/);
});

test("falls back html filenames to txt for WeChat", () => {
  assert.equal(fallbackWechatFilename("方案.html"), "方案.txt");
  assert.equal(fallbackWechatFilename("方案.xhtml"), "方案.txt");
});
```

Run: `npx tsx --test --test-force-exit test/htmlPreview.unit.test.ts`

Expected: FAIL because `src/server/htmlPreview.ts` does not exist yet.

- [ ] **Step 2: Implement the helper minimally**

Create `src/server/htmlPreview.ts` with:

```ts
export function isHtmlAttachment(filename: string, mimeType: string | null): boolean;
export function htmlToPreviewText(html: string, filename: string, maxChars?: number): string;
export function fallbackWechatFilename(filename: string): string;
export async function renderHtmlLongPreview(html: string): Promise<Buffer>;
```

Implementation requirements:

```ts
import { chromium } from "playwright";

export function isHtmlAttachment(filename: string, mimeType: string | null): boolean {
  return (mimeType ?? "").toLowerCase().includes("html") || /\.(html?|xhtml)$/i.test(filename);
}

export function htmlToPreviewText(html: string, filename: string, maxChars = 4000): string {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
  const text = plain.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return clipped ? `HTML预览：${filename}\n${clipped}` : `HTML预览：${filename}`;
}

export function fallbackWechatFilename(filename: string): string {
  const base = filename.replace(/\.(html?|xhtml)$/i, "");
  return `${base || "file"}.txt`;
}

export async function renderHtmlLongPreview(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1600 },
      javaScriptEnabled: false,
    });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
    const shot = await page.screenshot({ type: "png", fullPage: true });
    await page.close();
    return Buffer.from(shot);
  } finally {
    await browser.close();
  }
}
```

Then run:

```bash
npm install playwright
npx tsx --test --test-force-exit test/htmlPreview.unit.test.ts
```

Expected: PASS.

- [ ] **Step 3: Verify the renderer can actually produce a long PNG**

Add `test/htmlPreview.render.integration.ts` with one fixture:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToPreviewText, renderHtmlLongPreview } from "../src/server/htmlPreview.ts";

test("renders a nonblank long preview png", { timeout: 30000 }, async () => {
  const html = "<h1>标题</h1><p>第一段</p><p>第二段</p>";
  const png = await renderHtmlLongPreview(html);
  assert.ok(png.length > 1000);
  assert.match(htmlToPreviewText(html, "方案.html"), /标题/);
});
```

Run: `npx tsx --test --test-force-exit test/htmlPreview.render.integration.ts`

Expected: PASS and the PNG buffer is non-empty.

- [ ] **Step 4: Commit**

```bash
git add src/server/htmlPreview.ts test/htmlPreview.unit.test.ts test/htmlPreview.render.integration.ts package.json package-lock.json
git commit -m "feat: add html long preview helper"
```

### Task 2: Wire the OpenClaw bridge to send HTML previews instead of HTML file cards

**Files:**
- Modify: `src/server/wechatOpenClawBridge.ts`
- Modify: `test/wechatOpenClawBridge.integration.ts`

**Interfaces:**
- Consumes: `isHtmlAttachment`, `htmlToPreviewText`, `fallbackWechatFilename`, `renderHtmlLongPreview`.
- Produces: HTML outbound behavior = one summary text + one image preview; the original HTML remains in open-tag.

- [ ] **Step 1: Write the failing bridge test**

Extend `test/wechatOpenClawBridge.integration.ts` so the HTML case asserts:

```ts
check("html attachment emits a text preview", ...text_item.text contains "HTML预览：行业报告-预览.html");
check("html attachment emits one image preview", ...item_list[0].type === 2);
check("html attachment no longer emits a html file card", !calls.some(...file_item.file_name endsWith(".html")));
```

Run: `npx tsx test/wechatOpenClawBridge.integration.ts`

Expected: FAIL because the bridge still treats HTML as a file-first outbound payload.

- [ ] **Step 2: Implement the HTML-specific branch**

Update `src/server/wechatOpenClawBridge.ts` so HTML attachments:

1. read the attachment bytes from open-tag storage;
2. generate one long preview PNG from the HTML;
3. send a text message containing the preview summary and original source reference;
4. send one `image_item` with the PNG preview;
5. do not send a `.html` `file_item` for HTML attachments.

The source reference text should name the original open-tag message and attachment id so the user can find the canonical artifact on desktop/web.

Non-HTML attachments must keep the existing image/file logic.

- [ ] **Step 3: Re-run the bridge integration test**

Run:

```bash
npx tsx test/wechatOpenClawBridge.integration.ts
```

Expected: PASS, with HTML producing preview text + image, and non-HTML unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/server/wechatOpenClawBridge.ts test/wechatOpenClawBridge.integration.ts
git commit -m "feat: send html previews to wechat"
```

### Task 3: Sync docs and verify the full path

**Files:**
- Modify: `docs/wechat-adapter.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: the final HTML preview behavior from Task 2.
- Produces: updated architecture/docs that explain HTML preview vs original artifact handling.

- [ ] **Step 1: Update the bridge docs**

Record that:

1. HTML remains canonical in open-tag.
2. WeChat receives a single long-image preview plus summary.
3. The original open-tag message/attachment remains the source of truth.
4. Non-HTML attachment behavior does not change.

- [ ] **Step 2: Update the architecture codemap**

Adjust the `wechatGateway.ts` / `wechatOpenClawBridge.ts` architecture entry so it says HTML is previewed as a long image for WeChat while the original stays in open-tag.

- [ ] **Step 3: Run the verification set**

Run:

```bash
npm run typecheck
npx tsx --test --test-force-exit test/htmlPreview.unit.test.ts
npx tsx --test --test-force-exit test/htmlPreview.render.integration.ts
npx tsx test/wechatOpenClawBridge.integration.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add docs/wechat-adapter.md ARCHITECTURE.md
git commit -m "docs: describe html long preview delivery"
```

## Verification checklist

- HTML preview text is readable on mobile.
- HTML preview image is one long image, not a multi-page carousel.
- HTML no longer depends on `.html` download behavior in WeChat.
- Original HTML stays accessible in open-tag.
- PNG/image and other file attachments keep their existing behavior.

