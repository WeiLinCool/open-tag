import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export const FEISHU_PROVIDER = "feishu_personal";

export interface FeishuIdentityInput {
  userId: string;
  externalUserId: string;
  externalRoomId?: string | null;
  botId?: string | null;
  externalNickname?: string | null;
  externalAvatarUrl?: string | null;
}

export async function linkFeishuIdentity(input: FeishuIdentityInput) {
  const [existing] = await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.provider, FEISHU_PROVIDER),
    eq(schema.externalIdentities.externalUserId, input.externalUserId),
    isNull(schema.externalIdentities.revokedAt),
  ));
  if (existing) throw new Error("feishu identity already bound");
  const [activeForUser] = await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.userId, input.userId),
    eq(schema.externalIdentities.provider, FEISHU_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  ));
  if (activeForUser) throw new Error("user already has a Feishu binding");
  const [row] = await db.insert(schema.externalIdentities).values({
    userId: input.userId,
    provider: FEISHU_PROVIDER,
    externalUserId: input.externalUserId,
    externalRoomId: input.externalRoomId ?? null,
    botId: input.botId ?? null,
    externalNickname: input.externalNickname ?? null,
    externalAvatarUrl: input.externalAvatarUrl ?? null,
  }).returning();
  return row!;
}

export async function getFeishuBinding(userId: string) {
  return (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.userId, userId),
    eq(schema.externalIdentities.provider, FEISHU_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  )))[0] ?? null;
}

export async function findFeishuBindingByExternalUser(externalUserId: string) {
  return (await db.select().from(schema.externalIdentities).where(and(
    eq(schema.externalIdentities.provider, FEISHU_PROVIDER),
    eq(schema.externalIdentities.externalUserId, externalUserId),
    isNull(schema.externalIdentities.revokedAt),
  )))[0] ?? null;
}

export async function unlinkFeishuBinding(userId: string) {
  const [row] = await db.update(schema.externalIdentities).set({ revokedAt: new Date() }).where(and(
    eq(schema.externalIdentities.userId, userId),
    eq(schema.externalIdentities.provider, FEISHU_PROVIDER),
    isNull(schema.externalIdentities.revokedAt),
  )).returning();
  return row ?? null;
}
