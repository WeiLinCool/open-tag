import { and, eq, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export interface ExternalDeliveryInput {
  serverId: string;
  channelId: string;
  sourceMessageId: string;
  taskMessageId?: string | null;
  platform: string;
  adapter: string;
  externalBotId: string;
  externalConversationId: string;
  externalUserId: string;
  replyToExternalUserId?: string | null;
  contextToken?: string | null;
}

export interface ExternalDeliveryContext {
  id: string;
  serverId: string;
  channelId: string;
  sourceMessageId: string;
  taskMessageId: string | null;
  platform: string;
  adapter: string;
  externalBotId: string;
  externalConversationId: string;
  externalUserId: string;
  replyToExternalUserId: string | null;
  contextToken: string | null;
  status: string;
}

export async function registerExternalDeliveryContext(input: ExternalDeliveryInput): Promise<ExternalDeliveryContext> {
  const [row] = await db.insert(schema.externalDeliveryContexts).values({
    serverId: input.serverId,
    channelId: input.channelId,
    sourceMessageId: input.sourceMessageId,
    taskMessageId: input.taskMessageId ?? null,
    platform: input.platform,
    adapter: input.adapter,
    externalBotId: input.externalBotId,
    externalConversationId: input.externalConversationId,
    externalUserId: input.externalUserId,
    replyToExternalUserId: input.replyToExternalUserId ?? null,
    contextToken: input.contextToken ?? null,
  }).onConflictDoUpdate({
    target: schema.externalDeliveryContexts.sourceMessageId,
    set: {
      taskMessageId: input.taskMessageId ?? null,
      externalConversationId: input.externalConversationId,
      externalUserId: input.externalUserId,
      replyToExternalUserId: input.replyToExternalUserId ?? null,
      contextToken: input.contextToken ?? null,
      status: "open",
      updatedAt: new Date(),
    },
  }).returning();
  return row!;
}

export async function findExternalDeliveryContextByMessage(messageId: string): Promise<ExternalDeliveryContext | null> {
  const row = (await db.select().from(schema.externalDeliveryContexts).where(or(
    eq(schema.externalDeliveryContexts.sourceMessageId, messageId),
    eq(schema.externalDeliveryContexts.taskMessageId, messageId),
  )).limit(1))[0];
  return row ?? null;
}

export async function findExternalDeliveryContextByThread(threadChannelId: string): Promise<ExternalDeliveryContext | null> {
  const thread = (await db.select({ parentMessageId: schema.channels.parentMessageId }).from(schema.channels).where(and(
    eq(schema.channels.id, threadChannelId),
    eq(schema.channels.type, "thread"),
  )).limit(1))[0];
  if (!thread?.parentMessageId) return null;
  return findExternalDeliveryContextByMessage(thread.parentMessageId);
}

export async function markExternalDeliveryDone(messageId: string): Promise<void> {
  await db.update(schema.externalDeliveryContexts).set({ status: "done", updatedAt: new Date() }).where(or(
    eq(schema.externalDeliveryContexts.sourceMessageId, messageId),
    eq(schema.externalDeliveryContexts.taskMessageId, messageId),
  ));
}
