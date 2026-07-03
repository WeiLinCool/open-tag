import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { htmlToPreviewText, renderHtmlLongPreview } from "../src/server/htmlPreview.ts";

test("renders a nonblank long preview png", { timeout: 30000 }, async () => {
  const html = "<h1>标题</h1><p>第一段</p><p>第二段</p>";
  const png = await renderHtmlLongPreview(html);
  assert.ok(png.length > 1000);
  assert.ok(png.length < 900000);
  const decoded = PNG.sync.read(png);
  assert.equal(decoded.width > 0, true);
  assert.equal(decoded.height > 0, true);
  assert.match(htmlToPreviewText(html, "方案.html"), /标题/);
});
