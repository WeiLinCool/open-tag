import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createLogger } from "../log.js";
import { readObject } from "./storage.js";
import { htmlToPreviewText, isHtmlAttachment, renderHtmlLongPreview } from "./htmlPreview.js";
import {
  drainWeChatOutbox,
  formatWeChatStatus,
  normalizeOpenClawMsg,
  routeOpenClawWeChatMessage,
  type WeChatOutboundAttachment,
  type WeChatOutboundStatus,
} from "./wechatGateway.js";

export interface OpenClawWeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  ownerUserId?: string;
}

interface BridgeState {
  accountId: string;
  cursor: string;
  busy: boolean;
}

const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_POLL_MS = 5000;
const LONG_POLL_TIMEOUT_MS = 35000;
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_FILE = 3;
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_ITEM_FILE = 4;
const MAX_HTML_PREVIEW_CHARS = 4000;
const states = new Map<string, BridgeState>();
let bridgeTimer: NodeJS.Timeout | null = null;
const log = createLogger("wechat-openclaw");

export function resolveOpenClawHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
}

export function loadOpenClawWeixinAccounts(openClawHome = resolveOpenClawHome()): OpenClawWeixinAccount[] {
  const baseDir = path.join(openClawHome, "openclaw-weixin");
  const indexPath = path.join(baseDir, "accounts.json");
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [];
  } catch {
    return [];
  }

  const accounts: OpenClawWeixinAccount[] = [];
  for (const accountId of ids) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(baseDir, "accounts", `${accountId}.json`), "utf8"));
      const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
      if (!token) continue;
      accounts.push({
        accountId,
        token,
        baseUrl: typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_ILINK_BASE_URL,
        ownerUserId: typeof parsed?.openTagOwnerUserId === "string" && parsed.openTagOwnerUserId.trim() ? parsed.openTagOwnerUserId.trim() : undefined,
      });
    } catch {
      // Ignore stale index entries.
    }
  }
  return accounts;
}

export function buildIlinkHeaders(token: string): Record<string, string> {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(uint32), "utf8").toString("base64"),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 6),
  };
}

export function ilinkUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export async function pollOpenClawWeixinAccount(
  account: OpenClawWeixinAccount,
  opts: { fetchImpl?: typeof fetch; state?: BridgeState } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const state = opts.state ?? states.get(account.accountId) ?? { accountId: account.accountId, cursor: "", busy: false };
  states.set(account.accountId, state);
  if (state.busy) return;
  state.busy = true;

  try {
    const updates = await postJson(fetchImpl, account, "ilink/bot/getupdates", {
      get_updates_buf: state.cursor,
      base_info: { channel_version: "2.4.6", bot_agent: "OpenTag/0.1.0" },
    }, LONG_POLL_TIMEOUT_MS);
    if (typeof updates?.get_updates_buf === "string") state.cursor = updates.get_updates_buf;
    const messages = Array.isArray(updates?.msgs) ? updates.msgs : [];
    for (const msg of messages) {
      const inbound = normalizeOpenClawMsg({ msg });
      inbound.targetUserId = account.ownerUserId;
      const routed = await routeOpenClawWeChatMessage(inbound);
      if (!routed.accepted) continue;
      await flushWeChatStatusOutbox(fetchImpl, account);
    }
    await flushWeChatStatusOutbox(fetchImpl, account);
  } catch (err) {
    log.warn("poll failed", { accountId: account.accountId, detail: String((err as Error)?.message ?? err) });
  } finally {
    state.busy = false;
  }
}

export async function flushWeChatStatusOutbox(fetchImpl: typeof fetch, account: OpenClawWeixinAccount): Promise<void> {
  for (const row of drainWeChatOutbox()) {
    const to = row.replyToUserId || row.roomId;
    await sendOpenClawTextOrMedia(fetchImpl, account, {
      taskId: row.taskId,
      to,
      contextToken: row.contextToken,
      payload: row.payload,
    });
  }
}

async function sendOpenClawTextOrMedia(
  fetchImpl: typeof fetch,
  account: OpenClawWeixinAccount,
  input: { taskId: string; to: string; contextToken?: string; payload: WeChatOutboundStatus },
): Promise<void> {
  const text = formatWeChatStatus(input.payload);
  const attachments = input.payload.attachments ?? [];
  if (text) {
    await sendOpenClawItem(fetchImpl, account, input, { type: MESSAGE_ITEM_TEXT, text_item: { text } });
  }
  for (const attachment of attachments) {
    const payload = await buildOpenClawMediaItem(fetchImpl, account, input.to, attachment);
    if (!payload) continue;
    if (payload.previewText) {
      await sendOpenClawItem(fetchImpl, account, input, {
        type: MESSAGE_ITEM_TEXT,
        text_item: { text: payload.previewText },
      });
    }
    if (payload.item) {
      await sendOpenClawItem(fetchImpl, account, input, payload.item);
    }
  }
}

async function sendOpenClawItem(
  fetchImpl: typeof fetch,
  account: OpenClawWeixinAccount,
  input: { taskId: string; to: string; contextToken?: string },
  item: unknown,
): Promise<void> {
  await postJson(fetchImpl, account, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: input.to,
      client_id: `open-tag-${input.taskId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      message_type: 2,
      message_state: 2,
      context_token: input.contextToken,
      item_list: [item],
    },
    base_info: { channel_version: "2.4.6", bot_agent: "OpenTag/0.1.0" },
  }, 15000);
}

async function buildOpenClawMediaItem(
  fetchImpl: typeof fetch,
  account: OpenClawWeixinAccount,
  toUserId: string,
  attachment: WeChatOutboundAttachment,
): Promise<{ previewText?: string; item?: any } | null> {
  const row = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, attachment.id)))[0];
  if (!row) return null;
  const buf = await readObject(row.storageKey);
  if (isHtmlAttachment(row.filename, row.mimeType)) {
    const sourceText = htmlToPreviewText(buf.toString("utf8"), row.filename);
    const sourceRef = `原件：open-tag 附件 ${row.id}${row.messageId ? `，消息 ${row.messageId}` : ""}`;
    try {
      const previewPng = await renderHtmlLongPreview(buf.toString("utf8"));
      const uploaded = await uploadOpenClawMediaBuffer(fetchImpl, account, {
        buf: previewPng,
        filename: `${row.filename.replace(/\.(html?|xhtml)$/i, "") || "html"}.png`,
        mediaType: UPLOAD_MEDIA_TYPE_IMAGE,
        toUserId,
      });
      const media = {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskeyHex, "hex").toString("base64"),
        encrypt_type: 1,
      };
      return {
        previewText: `${sourceText}\n${sourceRef}`,
        item: {
          type: MESSAGE_ITEM_IMAGE,
          image_item: {
            media,
            mid_size: uploaded.ciphertextSize,
          },
        },
      };
    } catch (err) {
      log.warn("html preview render failed", { attachmentId: row.id, detail: String((err as Error)?.message ?? err) });
      return { previewText: `${sourceText}\n${sourceRef}` };
    }
  }
  const mediaType = isImageAttachment(row.filename, row.mimeType) ? UPLOAD_MEDIA_TYPE_IMAGE : UPLOAD_MEDIA_TYPE_FILE;
  const uploaded = await uploadOpenClawMediaBuffer(fetchImpl, account, {
    buf,
    filename: row.filename,
    mediaType,
    toUserId,
  });
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskeyHex, "hex").toString("base64"),
    encrypt_type: 1,
  };
  if (mediaType === UPLOAD_MEDIA_TYPE_IMAGE) {
    return { item: {
      type: MESSAGE_ITEM_IMAGE,
      image_item: {
        media,
        mid_size: uploaded.ciphertextSize,
      },
    } };
  }
  return {
    item: {
      type: MESSAGE_ITEM_FILE,
      file_item: {
        media,
        file_name: row.filename,
        md5: crypto.createHash("md5").update(buf).digest("hex"),
        len: String(uploaded.plaintextSize),
      },
    },
  };
}

function isImageAttachment(filename: string, mimeType: string | null): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(filename);
}

function aesEcbPaddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function uploadOpenClawMediaBuffer(
  fetchImpl: typeof fetch,
  account: OpenClawWeixinAccount,
  input: { buf: Buffer; filename: string; mediaType: number; toUserId: string },
): Promise<{ downloadEncryptedQueryParam: string; aeskeyHex: string; plaintextSize: number; ciphertextSize: number }> {
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const plaintextSize = input.buf.length;
  const ciphertextSize = aesEcbPaddedSize(plaintextSize);
  const uploadInfo = await postJson(fetchImpl, account, "ilink/bot/getuploadurl", {
    filekey,
    media_type: input.mediaType,
    to_user_id: input.toUserId,
    rawsize: plaintextSize,
    rawfilemd5: crypto.createHash("md5").update(input.buf).digest("hex"),
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    base_info: { channel_version: "2.4.6", bot_agent: "OpenTag/0.1.0" },
  }, 15000);
  const uploadUrl = String(uploadInfo?.upload_full_url ?? "").trim() || buildCdnUploadUrl(String(uploadInfo?.upload_param ?? ""), filekey);
  if (!uploadUrl) throw new Error(`missing WeChat CDN upload URL for ${input.filename}`);
  const encrypted = encryptAesEcb(input.buf, aeskey);
  const res = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });
  if (!res.ok) throw new Error(`WeChat CDN upload failed ${res.status}: ${await res.text()}`);
  const downloadEncryptedQueryParam = res.headers.get("x-encrypted-param") ?? "";
  if (!downloadEncryptedQueryParam) throw new Error("WeChat CDN upload response missing x-encrypted-param");
  return { downloadEncryptedQueryParam, aeskeyHex: aeskey.toString("hex"), plaintextSize, ciphertextSize };
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  const p = uploadParam.trim();
  if (!p) return "";
  return `${DEFAULT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(p)}&filekey=${encodeURIComponent(filekey)}`;
}

export function startOpenClawWeixinBridge(): void {
  if (process.env.WECHAT_OPENCLAW_BRIDGE === "false") return;
  if (bridgeTimer) return;
  const tick = () => {
    for (const account of loadOpenClawWeixinAccounts()) {
      void pollOpenClawWeixinAccount(account);
    }
  };
  tick();
  bridgeTimer = setInterval(tick, Number(process.env.WECHAT_OPENCLAW_POLL_MS ?? DEFAULT_POLL_MS));
}

async function postJson(
  fetchImpl: typeof fetch,
  account: OpenClawWeixinAccount,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ilinkUrl(account.baseUrl, endpoint), {
      method: "POST",
      headers: buildIlinkHeaders(account.token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}
