import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("account settings exposes WeChat Bot gateway controls and endpoints", async () => {
  const src = await readFile(new URL("../web/src/views/misc.tsx", import.meta.url), "utf8");
  assert.match(src, /wechatBindingTitle/);
  assert.match(src, /\/api\/auth\/wechat-openclaw-login/);
  assert.match(src, /\/api\/integrations\/wechat\/openclaw/);
  assert.match(src, /\/api\/auth\/wechat-binding/);
  assert.doesNotMatch(src, /\/api\/auth\/wechat-sessions/);
  assert.doesNotMatch(src, /wechat-binding\/code/);
  assert.doesNotMatch(src, /wechat-binding\/confirm/);
});

test("account settings hides QR/waiting copy after OpenClaw login is confirmed", async () => {
  const src = await readFile(new URL("../web/src/views/misc.tsx", import.meta.url), "utf8");
  assert.match(src, /const wechatLoginConfirmed = wechatLogin\?\.status === "confirmed"/);
  assert.match(src, /!wechatLoginConfirmed && wechatLogin\.qrDataUrl/);
  assert.match(src, /!wechatLoginConfirmed && !wechatLogin\.qrDataUrl/);
  assert.match(src, /wechatLoginConfirmed && <div className="kv">\{t\("misc\.wechatBindingConnected"/);
  assert.match(src, /wechatMsg && !wechatLoginConfirmed/);
});

test("locales include WeChat Bot gateway copy", async () => {
  const en = await readFile(new URL("../web/src/locales/en.json", import.meta.url), "utf8");
  const zh = await readFile(new URL("../web/src/locales/zh.json", import.meta.url), "utf8");
  for (const key of ["wechatBindingTitle", "wechatBindingConnect", "wechatBindingGatewayInfo", "wechatBindingWaitingQr", "wechatBindingStatus_qr_ready", "wechatBindingConnected", "wechatBindingUnlink"]) {
    assert.match(en, new RegExp(`"${key}"`));
    assert.match(zh, new RegExp(`"${key}"`));
  }
  assert.doesNotMatch(en, /Generate code/);
  assert.doesNotMatch(zh, /生成绑定码/);
  assert.match(en, /OpenClaw\/ClawBot/);
  assert.match(zh, /OpenClaw\/ClawBot/);
});
