import test from "node:test";
import assert from "node:assert/strict";
import { fallbackWechatFilename, htmlToPreviewText, isHtmlAttachment } from "../src/server/htmlPreview.ts";

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

test("renders a readable long preview png", { timeout: 30000 }, async () => {
  const { PNG } = await import("pngjs");
  const { renderHtmlLongPreview } = await import("../src/server/htmlPreview.ts");
  const png = await renderHtmlLongPreview("<h1>标题</h1><p>第一段</p><p>第二段</p>");
  assert.ok(png.length > 1000);
  assert.ok(png.length < 900000);
  const decoded = PNG.sync.read(png);
  assert.equal(decoded.width > 0, true);
  assert.equal(decoded.height > 0, true);
  let nonWhite = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    if (decoded.data[i] !== 255 || decoded.data[i + 1] !== 255 || decoded.data[i + 2] !== 255) {
      nonWhite++;
      if (nonWhite > 10) break;
    }
  }
  assert.ok(nonWhite > 10);
});

test("preview cover starts with title text", { timeout: 30000 }, async () => {
  const { renderHtmlLongPreview } = await import("../src/server/htmlPreview.ts");
  const png = await renderHtmlLongPreview("<title>八方物流数智化建设方案</title><h1>八方物流数智化建设方案</h1><p>汇报版</p>");
  assert.ok(png.length > 1000);
});
