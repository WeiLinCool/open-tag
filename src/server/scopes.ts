// Agent permission scopes (14 scopes).
// Default mode = all granted; custom mode = the subset the user explicitly checked. Enforcement happens at the /agent-api gateway.
export interface ScopeDef { key: string; group: string; label: string; description: string; }

export const SCOPES: ScopeDef[] = [
  { key: "inbox:receive", group: "scopes.groupNotifications", label: "scopes.inboxReceiveLabel", description: "scopes.inboxReceiveDesc" },
  { key: "server:read", group: "scopes.groupServer", label: "scopes.serverReadLabel", description: "scopes.serverReadDesc" },
  { key: "channel:read", group: "scopes.groupChannels", label: "scopes.channelReadLabel", description: "scopes.channelReadDesc" },
  { key: "channel:join", group: "scopes.groupChannels", label: "scopes.channelJoinLabel", description: "scopes.channelJoinDesc" },
  { key: "channel:leave", group: "scopes.groupChannels", label: "scopes.channelLeaveLabel", description: "scopes.channelLeaveDesc" },
  { key: "thread:unfollow", group: "scopes.groupThreads", label: "scopes.threadUnfollowLabel", description: "scopes.threadUnfollowDesc" },
  { key: "message:read", group: "scopes.groupMessages", label: "scopes.messageReadLabel", description: "scopes.messageReadDesc" },
  { key: "message:send", group: "scopes.groupMessages", label: "scopes.messageSendLabel", description: "scopes.messageSendDesc" },
  { key: "attachment:upload", group: "scopes.groupAttachments", label: "scopes.attachmentUploadLabel", description: "scopes.attachmentUploadDesc" },
  { key: "attachment:view", group: "scopes.groupAttachments", label: "scopes.attachmentViewLabel", description: "scopes.attachmentViewDesc" },
  { key: "task:read", group: "scopes.groupTasks", label: "scopes.taskReadLabel", description: "scopes.taskReadDesc" },
  { key: "task:write", group: "scopes.groupTasks", label: "scopes.taskWriteLabel", description: "scopes.taskWriteDesc" },
  { key: "knowledge:read", group: "scopes.groupKnowledge", label: "scopes.knowledgeReadLabel", description: "scopes.knowledgeReadDesc" },
  { key: "action:prepare", group: "scopes.groupAction", label: "scopes.actionPrepareLabel", description: "scopes.actionPrepareDesc" },
];
export const ALL_SCOPE_KEYS = SCOPES.map((s) => s.key);
const SCOPE_SET = new Set(ALL_SCOPE_KEYS);
export const isScopeLiteral = (s: unknown): s is string => typeof s === "string" && SCOPE_SET.has(s);

export interface AgentScopes { granted: string[]; mode: "default" | "custom"; revision: number; updatedAt: string; }

/** agent.scopes null = default mode (all granted); otherwise use the stored custom set. */
export function effectiveScopes(stored: AgentScopes | null | undefined): AgentScopes {
  if (!stored) return { granted: [...ALL_SCOPE_KEYS], mode: "default", revision: 0, updatedAt: new Date(0).toISOString() };
  return stored;
}
export function agentHasScope(stored: AgentScopes | null | undefined, scope: string): boolean {
  return effectiveScopes(stored).granted.includes(scope);
}
