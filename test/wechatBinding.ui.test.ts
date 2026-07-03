import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("account settings exposes WeChat binding controls and endpoints", async () => {
  const src = await readFile(new URL("../web/src/views/misc.tsx", import.meta.url), "utf8");
  assert.match(src, /wechatBindingTitle/);
  assert.match(src, /\/api\/auth\/wechat-binding\/code/);
  assert.match(src, /\/api\/auth\/wechat-binding\/confirm/);
  assert.match(src, /\/api\/auth\/wechat-binding/);
});

test("locales include WeChat binding copy", async () => {
  const en = await readFile(new URL("../web/src/locales/en.json", import.meta.url), "utf8");
  const zh = await readFile(new URL("../web/src/locales/zh.json", import.meta.url), "utf8");
  for (const key of ["wechatBindingTitle", "wechatBindingGenerate", "wechatBindingInputPlaceholder", "wechatBindingUnlink"]) {
    assert.match(en, new RegExp(`"${key}"`));
    assert.match(zh, new RegExp(`"${key}"`));
  }
});
