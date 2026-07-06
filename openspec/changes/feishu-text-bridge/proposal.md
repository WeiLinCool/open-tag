# Feishu MCP Bridge Proposal

## Problem
open-tag already treats external channels as bound to a human open-tag identity, not as separate permission systems. Feishu should follow the same model, but the text loop alone is a thin transport problem. The better implementation path is to reuse existing open-source Feishu capability layers where possible, especially official MCP/OpenAPI tooling and existing event/CLI bridges, then keep open-tag focused on the identity, permission, and channel-meaning layer.

## Goals
- Bind a single personal Feishu account to one open-tag human identity.
- Reuse open-source Feishu capability layers instead of rebuilding protocol and transport plumbing from scratch.
- Expose open-tag capabilities through MCP tools that can be reused beyond Feishu.
- Forward linked Feishu text into MCP using the bound user's permissions and visibility.
- Send MCP results back to the same Feishu conversation as text.
- Keep the first release focused on the text loop only.

## Non-Goals
- No message cards.
- No Docs/Bitable integration.
- No group-wide Feishu bot rollout.
- No thread sync, file sync, or rich interactive actions.
- No rewrite of the existing WeChat gateway.
- No independent Feishu login system outside open-tag's own user accounts.

## Scope
This change covers an open-tag MCP capability surface, a minimal Feishu bridge assembled from existing open-source components where possible, and the binding state needed to connect one Feishu identity to one open-tag user.

It does not change the core agent runtime or message engine. Feishu remains a thin external edge, while MCP becomes the reusable capability layer that other clients can also call. The implementation should prefer official or proven open-source Feishu adapters before introducing new protocol code.

## Success Criteria
- A linked Feishu account can send a text message that is handled through open-tag MCP as the bound human user.
- MCP can return a result that is delivered back to the same Feishu conversation.
- Unlinked or unauthorized Feishu events are rejected or ignored.
- Existing WeChat behavior remains unchanged.
