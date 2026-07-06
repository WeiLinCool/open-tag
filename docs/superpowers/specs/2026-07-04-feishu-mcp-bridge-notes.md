# Feishu MCP Bridge Notes

Decisions:
- Reuse official Feishu OpenAPI / event subscription tooling where possible for transport.
- Reuse any proven open-source Feishu event bridge when it already solves callback or polling.
- Keep open-tag responsible for identity binding, permission mapping, channel visibility, and delivery context.
- Expose the open-tag side as a narrow MCP capability surface so Feishu is not the only caller.

Rejected:
- A full custom Feishu protocol stack.
- A separate Feishu auth plane detached from open-tag users.
- Treating Feishu as a standalone workspace instead of a human-bound external channel.

Current implementation shape:
- Feishu binding lives in `src/server/feishuBinding.ts`.
- The bridge entrypoint lives in `src/server/feishuGateway.ts`.
- The reusable capability surface lives in `src/server/mcp/feishuTools.ts`.
- Shared outbound context is stored in `external_delivery_contexts` via `src/server/externalContexts.ts`.

Open gap:
- The transport still uses the in-repo bridge boundary rather than a vendor-hosted Feishu app flow.
- Message cards, Docs, and Bitable are intentionally deferred to the next slice.
