import { and, desc, eq, gt, isNull, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export const WECHAT_PROVIDER = "wechat_personal";
const SESSION_TTL_MS = 5 * 60 * 1000;

export type WeChatLoginSessionStatus = "pending" | "qr_ready" | "scanned" | "confirmed" | "expired" | "failed";

export type WeChatSessionEvent =
  | { sessionId: string; type: "qr"; adapterSessionId?: string | null; qrPayload?: string | null; qrDataUrl?: string | null; expiresAt?: string | Date | null }
  | { sessionId: string; type: "scanned" }
  | { sessionId: string; type: "login"; botId?: string | null; externalUserId: string; externalNickname?: string | null; externalAvatarUrl?: string | null }
  | { sessionId: string; type: "failed"; reason?: string | null };

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function parseExpiry(value: string | Date | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : fallback;
}

function assertActiveSession(session: typeof schema.wechatLoginSessions.$inferSelect) {
  if (session.status === "confirmed") throw new Error("wechat scan session already confirmed");
  if (session.status === "failed") throw new Error("wechat scan session failed");
  if (session.expiresAt.getTime() <= Date.now()) throw new Error("wechat scan session expired");
}

export function serializeWeChatBinding(binding: typeof schema.externalIdentities.$inferSelect | null) {
  return binding ? {
    id: binding.id,
    provider: binding.provider,
    externalUserId: binding.externalUserId,
    externalRoomId: binding.externalRoomId,
    botId: binding.botId,
    externalNickname: binding.externalNickname,
    externalAvatarUrl: binding.externalAvatarUrl,
    createdAt: binding.createdAt,
  } : null;
}

export function serializeWeChatLoginSession(session: typeof schema.wechatLoginSessions.$inferSelect | null) {
  return session ? {
    id: session.id,
    provider: WECHAT_PROVIDER,
    status: session.status as WeChatLoginSessionStatus,
    adapterSessionId: session.adapterSessionId,
    qrPayload: session.qrPayload,
    qrDataUrl: session.qrDataUrl,
    botId: session.botId,
    externalUserId: session.externalUserId,
    externalNickname: session.externalNickname,
    externalAvatarUrl: session.externalAvatarUrl,
    failureReason: session.failureReason,
    expiresAt: session.expiresAt,
    confirmedAt: session.confirmedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  } : null;
}

export async function createWeChatLoginSession(userId: string) {
  const active = await getWeChatBinding(userId);
  if (active) throw new Error("user already has a WeChat binding");

  const now = new Date();
  await db.update(schema.wechatLoginSessions).set({ status: "expired", updatedAt: now }).where(and(
    eq(schema.wechatLoginSessions.userId, userId),
    inArray(schema.wechatLoginSessions.status, ["pending", "qr_ready", "scanned"]),
  ));

  const [session] = await db.insert(schema.wechatLoginSessions).values({
    userId,
    status: "pending",
    expiresAt: sessionExpiry(),
  }).returning();
  return session!;
}

export async function getWeChatLoginSessionForUser(userId: string, sessionId: string) {
  return (await db.select().from(schema.wechatLoginSessions).where(and(
    eq(schema.wechatLoginSessions.id, sessionId),
    eq(schema.wechatLoginSessions.userId, userId),
  )))[0] ?? null;
}

export async function listPendingWeChatLoginSessions(limit = 20) {
  return await db.select().from(schema.wechatLoginSessions).where(and(
    inArray(schema.wechatLoginSessions.status, ["pending", "qr_ready", "scanned"]),
    gt(schema.wechatLoginSessions.expiresAt, new Date()),
  )).orderBy(desc(schema.wechatLoginSessions.createdAt)).limit(Math.max(1, Math.min(limit, 100)));
}

export async function applyWeChatSessionEvent(event: WeChatSessionEvent) {
  const sessionId = normalizeText(event.sessionId);
  if (!sessionId) throw new Error("wechat scan session id required");
  const session = (await db.select().from(schema.wechatLoginSessions).where(eq(schema.wechatLoginSessions.id, sessionId)))[0];
  if (!session) throw new Error("wechat scan session not found");
  assertActiveSession(session);

  const now = new Date();
  if (event.type === "qr") {
    const qrDataUrl = normalizeText(event.qrDataUrl);
    const qrPayload = normalizeText(event.qrPayload);
    if (!qrDataUrl && !qrPayload) throw new Error("wechat qr payload required");
    const [updated] = await db.update(schema.wechatLoginSessions).set({
      status: "qr_ready",
      adapterSessionId: normalizeText(event.adapterSessionId) || session.adapterSessionId,
      qrDataUrl: qrDataUrl || null,
      qrPayload: qrPayload || null,
      expiresAt: parseExpiry(event.expiresAt, session.expiresAt),
      updatedAt: now,
    }).where(eq(schema.wechatLoginSessions.id, session.id)).returning();
    return { session: updated!, binding: null };
  }

  if (event.type === "scanned") {
    const [updated] = await db.update(schema.wechatLoginSessions).set({
      status: "scanned",
      updatedAt: now,
    }).where(eq(schema.wechatLoginSessions.id, session.id)).returning();
    return { session: updated!, binding: null };
  }

  if (event.type === "failed") {
    const [updated] = await db.update(schema.wechatLoginSessions).set({
      status: "failed",
      failureReason: normalizeText(event.reason) || null,
      updatedAt: now,
    }).where(eq(schema.wechatLoginSessions.id, session.id)).returning();
    return { session: updated!, binding: null };
  }

  const externalUserId = normalizeText(event.externalUserId);
  if (!externalUserId) throw new Error("external user id required");
  const existingIdentity = await findWeChatBindingByExternalUser(externalUserId);
  if (existingIdentity) throw new Error("wechat identity already bound");
  const activeForUser = await getWeChatBinding(session.userId);
  if (activeForUser) throw new Error("user already has a WeChat binding");

  const [binding] = await db.insert(schema.externalIdentities).values({
    userId: session.userId,
    provider: WECHAT_PROVIDER,
    externalUserId,
    botId: normalizeText(event.botId) || null,
    externalNickname: normalizeText(event.externalNickname) || null,
    externalAvatarUrl: normalizeText(event.externalAvatarUrl) || null,
  }).returning();
  const [updated] = await db.update(schema.wechatLoginSessions).set({
    status: "confirmed",
    botId: normalizeText(event.botId) || null,
    externalUserId,
    externalNickname: normalizeText(event.externalNickname) || null,
    externalAvatarUrl: normalizeText(event.externalAvatarUrl) || null,
    confirmedAt: now,
    updatedAt: now,
  }).where(eq(schema.wechatLoginSessions.id, session.id)).returning();
  return { session: updated!, binding: binding! };
}

export async function getWeChatBinding(userId: string) {
  return (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.userId, userId),
    eq(schema.externalIdentities.provider, WECHAT_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  )))[0] ?? null;
}

export async function findWeChatBindingByExternalUser(externalUserId: string) {
  const id = normalizeText(externalUserId);
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
