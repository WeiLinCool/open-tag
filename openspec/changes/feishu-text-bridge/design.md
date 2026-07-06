# Feishu MCP Bridge Design

## Problem Shape
This is not a full Feishu platform integration. The first release only needs a one-user personal-account bridge with text messages in and text replies out. The better boundary is to expose open-tag capabilities through MCP, then keep Feishu as the transport and identity bridge.

The design should fit the existing open-tag pattern for external adapters: keep the core message engine unchanged, keep the adapter boundary thin, and persist only the external identity mapping and delivery context needed for round-tripping.

The implementation preference is explicit:

1. reuse official Feishu OpenAPI/MCP tooling where possible;
2. reuse proven open-source Feishu event/CLI bridges where they already solve the transport problem;
3. only build new code for open-tag-specific binding, permission mapping, and channel semantics.

## Architecture
Use two small boundaries in `src/server/`.

- An MCP server boundary exports open-tag capabilities as reusable tools.
- A Feishu bridge boundary owns the link state between one open-tag user and one Feishu personal identity, converts incoming text into MCP tool calls, and posts tool results back to the same Feishu conversation.
- A shared delivery-context record stores the cross-system conversation identity so replies can round-trip without special-casing core messaging.

The core rule is: Feishu is a thin external transport bound to a human account, while MCP is the reusable capability surface, not a new auth plane.
The second rule is: if an existing open-source component already provides the Feishu transport or capability surface safely, prefer it over a new in-repo implementation.

## Data Flow
1. A user links a Feishu personal account to their open-tag account.
2. Feishu sends an event for a text message.
3. The bridge verifies the event, looks up the link, and calls the relevant MCP tool as the bound user.
4. MCP runs against open-tag permissions and returns a result.
5. The bridge sends the result back to the same Feishu conversation.

## Error Handling
- Reject requests with invalid or missing Feishu credentials.
- Reject MCP calls that cannot be mapped to a linked identity.
- Preserve the original open-tag message even if outbound Feishu delivery fails.
- Log delivery failures and leave the bridge retryable.

## Testing
- Unit tests for link resolution and event normalization.
- Unit tests for MCP tool dispatch and permission-bound calls.
- Integration tests for one linked account sending text in and receiving text back.
- Regression coverage that the WeChat integration paths are untouched.

## Notes
This phase intentionally excludes message cards, Docs, Bitable, and group-bot behavior. Those belong in the next phase once the personal text bridge and MCP surface are stable.
It also intentionally avoids re-implementing Feishu protocol handling when the same function can be satisfied by an existing open-source adapter or official SDK/CLI.
