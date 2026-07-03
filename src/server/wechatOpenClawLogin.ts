import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";

export type OpenClawLoginStatus = "starting" | "qr_ready" | "running" | "confirmed" | "failed";

export interface OpenClawLoginSession {
  id: string;
  userId: string | null;
  status: OpenClawLoginStatus;
  qrPayload: string | null;
  qrDataUrl: string | null;
  output: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessions = new Map<string, OpenClawLoginSession & { child?: ChildProcess }>();
let weixinPluginReady = false;

export function extractOpenClawQrPayload(output: string): string | null {
  const m = /(https:\/\/(?:login\.weixin\.qq\.com\/(?:l|qrcode)\/|liteapp\.weixin\.qq\.com\/q\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/.exec(output);
  return m?.[1] ?? null;
}

export function openClawLoginCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (env.OPENCLAW_BIN?.trim()) {
    return { command: env.OPENCLAW_BIN.trim(), args: ["channels", "login", "--channel", "openclaw-weixin"] };
  }
  return { command: "openclaw", args: ["channels", "login", "--channel", "openclaw-weixin"] };
}

export function openClawWeixinSetupCommands(env: NodeJS.ProcessEnv): Array<{ command: string; args: string[] }> {
  const command = env.OPENCLAW_BIN?.trim() || "openclaw";
  return [
    { command, args: ["plugins", "install", "@tencent-weixin/openclaw-weixin"] },
    { command, args: ["plugins", "enable", "openclaw-weixin"] },
  ];
}

export function isOpenClawPluginAlreadyInstalledOutput(output: string): boolean {
  return output.includes("plugin already exists:") && output.includes("openclaw plugins update") && output.includes("--force");
}

function openClawProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: [path.join(process.cwd(), "node_modules", ".bin"), env.PATH].filter(Boolean).join(path.delimiter),
  };
}

export function serializeOpenClawLoginSession(session: OpenClawLoginSession | null) {
  return session ? {
    id: session.id,
    userId: session.userId,
    status: session.status,
    qrPayload: session.qrPayload,
    qrDataUrl: session.qrDataUrl,
    output: session.output.slice(-4000),
    error: session.error,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  } : null;
}

export async function createOpenClawLoginSession(userId?: string): Promise<OpenClawLoginSession> {
  const now = new Date();
  const session: OpenClawLoginSession & { child?: ChildProcess } = {
    id: crypto.randomUUID(),
    userId: userId ?? null,
    status: "starting",
    qrPayload: null,
    qrDataUrl: null,
    output: "",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(session.id, session);

  void startOpenClawLogin(session);
  return session;
}

async function startOpenClawLogin(session: OpenClawLoginSession & { child?: ChildProcess }): Promise<void> {
  try {
    await ensureOpenClawWeixinPlugin(session);
  } catch (err) {
    session.status = "failed";
    session.error = err instanceof Error ? err.message : String(err);
    session.updatedAt = new Date();
    return;
  }

  const env = openClawProcessEnv(process.env);
  const { command, args } = openClawLoginCommand(env);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;

  const append = async (chunk: Buffer | string) => {
    session.output += String(chunk);
    session.updatedAt = new Date();
    const payload = extractOpenClawQrPayload(session.output);
    if (payload && payload !== session.qrPayload) {
      session.qrPayload = payload;
      session.qrDataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 220 });
      session.status = "qr_ready";
      session.updatedAt = new Date();
    } else if (!session.qrPayload && session.status === "starting") {
      session.status = "running";
    }
  };

  child.stdout?.on("data", (chunk) => { void append(chunk); });
  child.stderr?.on("data", (chunk) => { void append(chunk); });
  child.on("error", (err) => {
    session.status = "failed";
    session.error = err.message;
    session.updatedAt = new Date();
  });
  child.on("exit", (code) => {
    if (session.status === "qr_ready" && code === 0) {
      session.status = "confirmed";
      if (session.userId) markLatestOpenClawWeixinAccountOwner(session.userId);
    }
    else if (code !== 0 && session.status !== "qr_ready") {
      session.status = "failed";
      session.error = `openclaw login exited with code ${code}`;
    }
    session.updatedAt = new Date();
  });
}

export function markLatestOpenClawWeixinAccountOwner(userId: string, openClawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw")): void {
  const accountsDir = path.join(openClawHome, "openclaw-weixin", "accounts");
  let latest: { file: string; mtimeMs: number } | null = null;
  try {
    for (const name of fs.readdirSync(accountsDir)) {
      if (!name.endsWith(".json") || name.endsWith(".sync.json") || name.endsWith(".context-tokens.json")) continue;
      const file = path.join(accountsDir, name);
      const stat = fs.statSync(file);
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs };
    }
    if (!latest) return;
    const data = JSON.parse(fs.readFileSync(latest.file, "utf8"));
    data.openTagOwnerUserId = userId;
    fs.writeFileSync(latest.file, JSON.stringify(data, null, 2), "utf8");
    try { fs.chmodSync(latest.file, 0o600); } catch { /* best-effort */ }
  } catch {
    // Best-effort metadata stamp; bridge can still fall back to WECHAT_GATEWAY_SERVER_SLUG.
  }
}

export function getOpenClawLoginSession(id: string): OpenClawLoginSession | null {
  return sessions.get(id) ?? null;
}

async function ensureOpenClawWeixinPlugin(session: OpenClawLoginSession): Promise<void> {
  if (weixinPluginReady || process.env.OPENCLAW_SKIP_WEIXIN_SETUP === "true") {
    weixinPluginReady = true;
    return;
  }

  const env = openClawProcessEnv(process.env);
  for (const { command, args } of openClawWeixinSetupCommands(env)) {
    await runSetupCommand(command, args, env, session);
  }
  weixinPluginReady = true;
}

function runSetupCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  session: OpenClawLoginSession,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer | string) => {
      const text = String(chunk);
      output += text;
      session.output += text;
      session.updatedAt = new Date();
      if (session.status === "starting") session.status = "running";
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || isOpenClawPluginAlreadyInstalledOutput(output)) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}: ${output.slice(-1000).trim()}`));
    });
  });
}
