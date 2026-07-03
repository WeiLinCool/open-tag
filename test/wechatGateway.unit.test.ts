process.env.JWT_SECRET ??= "unit-test-jwt-secret-unit-test-jwt-secret-32";
process.env.DAEMON_BOOTSTRAP_KEY ??= "unit-test-daemon-bootstrap-key-unit";

const mod = await import("../src/server/wechatGateway.ts");

let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

console.log("\n[1] normalizeWeChatInbound");
check(
  "pins the public channel and trims fields",
  JSON.stringify(mod.normalizeWeChatInbound({
    botId: " bot ",
    roomId: " room ",
    userId: " user ",
    msgType: " text ",
    content: " hello ",
    timestamp: 123,
  })) === JSON.stringify({
    botId: "bot",
    roomId: "room",
    userId: "user",
    msgType: "text",
    content: "hello",
    timestamp: 123,
    channelId: "#all",
  }),
);

console.log("\n[2] parseWeChatCommand");
check(
  "maps explicit analyst commands",
  JSON.stringify(mod.parseWeChatCommand("@Bot #分析师 总结今日热点")) === JSON.stringify({
    roleTag: "分析师",
    targetAgent: "analyst",
    command: "总结今日热点",
  }),
);
check("rejects missing role tags", mod.parseWeChatCommand("@Bot 总结今日热点") === null);

console.log("\n[3] formatWeChatStatus");
check("emits received status", mod.formatWeChatStatus({ stage: "received" }) === "[系统提示] 📥 已收到任务");
check("emits working status", mod.formatWeChatStatus({ stage: "working" }) === "[系统提示] ⚙️ 任务处理中");
check("emits done status with result", mod.formatWeChatStatus({ stage: "done", resultUrl: "thread:abc" }) === "[系统提示] ✅ 已完成 thread:abc");

console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
