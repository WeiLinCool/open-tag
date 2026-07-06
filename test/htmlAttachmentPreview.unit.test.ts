// Unit regression for chat HTML attachments.
// Run: npx tsx --test --test-force-exit test/htmlAttachmentPreview.unit.test.ts
//
// The attachment endpoint intentionally serves text/html as a forced download for XSS safety.
// Chat must therefore fetch HTML attachments and render them in the in-app preview modal instead
// of navigating to the raw attachment URL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");

test("Chat HTML attachments open an in-app preview instead of the browser download path", () => {
  assert.match(chatSrc, /import\s*\{\s*HtmlRenderer\s*\}\s*from\s*"\.\.\/components\/HtmlRenderer/);
  assert.match(chatSrc, /const isHtmlAttachment\s*=/);
  assert.match(chatSrc, /if \(isHtmlAttachment\(a\)\)/);
  assert.match(chatSrc, /fetch\(url\)/);
  assert.match(chatSrc, /<HtmlRenderer html=\{html\}/);
  const htmlBranchStart = chatSrc.indexOf("if (isHtmlAttachment(a))");
  const fallbackStart = chatSrc.indexOf("return (\n        <a className=\"msg-att\"", htmlBranchStart);
  assert.ok(htmlBranchStart > -1, "missing HTML attachment branch");
  assert.ok(fallbackStart > htmlBranchStart, "missing ordinary attachment fallback after HTML branch");
  const htmlBranch = chatSrc.slice(htmlBranchStart, fallbackStart);
  assert.doesNotMatch(
    htmlBranch,
    /<a\s+className="msg-att"[\s\S]*?target="_blank"/,
    "HTML attachments must not use the raw target=_blank attachment link because the server forces text/html to download",
  );
});
