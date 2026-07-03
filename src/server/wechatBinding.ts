import crypto from "node:crypto";
import { and, eq, gt, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export const WECHAT_PROVIDER = "wechat_personal";
const CODE_TTL_MS = 10 * 60 * 1000;

export interface MintedWeChatBindingCode {
  code: string;
  userId: string;
  provider: typeof WECHAT_PROVIDER;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface ClaimWeChatBindingInput {
  code: string;
  externalUserId: string;
  externalRoomId?: string | null;
  botId?: string | null;
}

function normalizeCode(code: string): string {
  return String(code ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeCode(code)).digest("hex");
}

function newBindingCode(): string {
  return crypto.randomBytes(5).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8).padEnd(8, "X");
}

export async function mintWeChatBindingCode(userId: string): Promise<MintedWeChatBindingCode> {
  const code = newBindingCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.insert(schema.externalIdentityCodes).values({
    userId,
    provider: WECHAT_PROVIDER,
    codeHash: hashCode(code),
    expiresAt,
  });
  return { code, userId, provider: WECHAT_PROVIDER, expiresAt, usedAt: null };
}

export async function claimWeChatBindingCode(input: ClaimWeChatBindingInput) {
  const codeHash = hashCode(input.code);
  const externalUserId = String(input.externalUserId ?? "").trim();
  if (!externalUserId) throw new Error("external user id required");
  const now = new Date();
  const existingIdentity = (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    eq(schema.externalIdentities.externalUserId, externalUserId),
    isNull(schema.externalIdentities.revokedAt),
  )))[0];
  if (existingIdentity) throw new Error("wechat identity already bound");

  const [row] = await db.update(schema.externalIdentityCodes).set({
    externalUserId,
    externalRoomId: input.externalRoomId ? String(input.externalRoomId).trim() : null,
    botId: input.botId ? String(input.botId).trim() : null,
  }).where(and(
    eq(schema.externalIdentityCodes.provider, WECHAT_PROVIDER),
    eq(schema.externalIdentityCodes.codeHash, codeHash),
    gt(schema.externalIdentityCodes.expiresAt, now),
    isNull(schema.externalIdentityCodes.usedAt),
  )).returning();
  if (!row) throw new Error("invalid or expired binding code");
  return row;
}

export async function confirmWeChatBinding(userId: string, code: string) {
  const codeHash = hashCode(code);
  const now = new Date();
  const row = (await db.select().from(schema.externalIdentityCodes).where(and(
    eq(schema.externalIdentityCodes.userId, userId),
    eq(schema.externalIdentityCodes.provider, WECHAT_PROVIDER),
    eq(schema.externalIdentityCodes.codeHash, codeHash),
    gt(schema.externalIdentityCodes.expiresAt, now),
    isNull(schema.externalIdentityCodes.usedAt),
    isNotNull(schema.externalIdentityCodes.externalUserId),
  )))[0];
  if (!row?.externalUserId) throw new Error("binding code has not been claimed by WeChat");

  const activeForUser = (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.userId, userId),
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  )))[0];
  if (activeForUser) throw new Error("user already has a WeChat binding");

  const activeForExternal = (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    eq(schema.externalIdentities.externalUserId, row.externalUserId),
    isNull(schema.externalIdentities.revokedAt),
  )))[0];
  if (activeForExternal) throw new Error("wechat identity already bound");

  const [identity] = await db.insert(schema.externalIdentities).values({
    userId,
    provider: WECHAT_PROVIDER,
    externalUserId: row.externalUserId,
    externalRoomId: row.externalRoomId,
    botId: row.botId,
  }).returning();
  await db.update(schema.externalIdentityCodes).set({ usedAt: now }).where(eq(schema.externalIdentityCodes.id, row.id));
  return identity!;
}

export async function getWeChatBinding(userId: string) {
  return (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.userId, userId),
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  )))[0] ?? null;
}

export async function findWeChatBindingByExternalUser(externalUserId: string) {
  const id = String(externalUserId ?? "").trim();
  if (!id) return null;
  return (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    eq(schema.externalIdentities.externalUserId, id),
    isNull(schema.externalIdentities.revokedAt),
  )))[0] ?? null;
}

export async function unlinkWeChatBinding(userId: string) {
  const [row] = await db.update(schema.externalIdentities).set({ revokedAt: new Date() }).where(and(
    eq(schema.externalIdentities.userId, userId),
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  )).returning();
  return row ?? null;
}
