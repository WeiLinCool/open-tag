import test from "node:test";
import assert from "node:assert/strict";
import {
  extractOpenClawQrPayload,
  isOpenClawPluginAlreadyInstalledOutput,
  openClawLoginCommand,
  openClawWeixinSetupCommands,
} from "../src/server/wechatOpenClawLogin.ts";

test("extractOpenClawQrPayload finds WeChat login URLs in OpenClaw output", () => {
  assert.equal(
    extractOpenClawQrPayload("scan https://login.weixin.qq.com/l/abc123 in terminal"),
    "https://login.weixin.qq.com/l/abc123",
  );
  assert.equal(
    extractOpenClawQrPayload("二维码链接：https://login.weixin.qq.com/qrcode/uuid-456"),
    "https://login.weixin.qq.com/qrcode/uuid-456",
  );
  assert.equal(
    extractOpenClawQrPayload(
      "请扫码登录：https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=dd9e489db93ac246b7b11ac4357e979e&bot_type=3",
    ),
    "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=dd9e489db93ac246b7b11ac4357e979e&bot_type=3",
  );
});

test("openClawLoginCommand defaults to the local openclaw channel login", () => {
  const cmd = openClawLoginCommand({});
  assert.equal(cmd.command, "openclaw");
  assert.deepEqual(cmd.args, ["channels", "login", "--channel", "openclaw-weixin"]);
});

test("openClawLoginCommand accepts an installed openclaw binary", () => {
  const cmd = openClawLoginCommand({ OPENCLAW_BIN: "openclaw" });
  assert.equal(cmd.command, "openclaw");
  assert.deepEqual(cmd.args, ["channels", "login", "--channel", "openclaw-weixin"]);
});

test("openClawWeixinSetupCommands installs and enables the Weixin plugin", () => {
  assert.deepEqual(openClawWeixinSetupCommands({}), [
    { command: "openclaw", args: ["plugins", "install", "@tencent-weixin/openclaw-weixin"] },
    { command: "openclaw", args: ["plugins", "enable", "openclaw-weixin"] },
  ]);
});

test("isOpenClawPluginAlreadyInstalledOutput recognizes OpenClaw's non-fatal existing plugin error", () => {
  const output = [
    "Downloading @tencent-weixin/openclaw-weixin…",
    "plugin already exists: /Users/wlz/.openclaw/npm/projects/tencent-weixin-openclaw-weixin/node_modules/@tencent-weixin/openclaw-weixin (delete it first)",
    "Use `openclaw plugins update <id-or-npm-spec>` to upgrade the tracked plugin, or rerun install with `--force` to replace it.",
  ].join("\n");

  assert.equal(isOpenClawPluginAlreadyInstalledOutput(output), true);
  assert.equal(isOpenClawPluginAlreadyInstalledOutput("network timeout while installing plugin"), false);
});
