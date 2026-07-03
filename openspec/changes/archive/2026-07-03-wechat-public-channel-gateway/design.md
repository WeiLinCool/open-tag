## Context

open-tag already has the core primitives needed for collaboration: channels, tasks, agents, and realtime updates. What it does not have yet is a thin external ingress that can translate a personal WeChat bot into those primitives without teaching the core about WeChat-specific APIs.

This change is intentionally an MVP. It targets one external surface, one public channel (`#all`), and explicit role tags for routing. That keeps the first integration small while preserving the adapter pattern needed for later platforms such as Feishu.

This change targets a bot endpoint integration: ClawBot/OpenClaw owns the personal-WeChat scan login and session maintenance, while open-tag exposes a token-gated backend endpoint that receives bot messages and returns queued replies. open-tag does not directly log in to, store, or operate a personal WeChat account.

## Goals / Non-Goals

**Goals:**
- Accept eligible personal-WeChat messages and map them into open-tag `#all`.
- Parse explicit `#角色` instructions and route them into existing open-tag agent/task flows.
- Return short status updates and final outcomes back to WeChat.
- Keep WeChat concerns isolated in an adapter layer.
- Expose a ClawBot/OpenClaw-compatible gateway surface (`sendmessage` inbound, `getupdates` outbound).
- Show the gateway endpoint in account settings so operators can connect their bot channel.

**Non-Goals:**
- Multi-bot tenancy and per-room mapping.
- Private-channel onboarding or automatic channel creation.
- Full state mirroring between WeChat and open-tag.
- Support for Feishu or other platforms in this change.
- A general external-identity platform for all providers in the first slice.

## Decisions

1. **Introduce a gateway/adapter boundary**
   - We will add a separate WeChat gateway layer that converts WeChat payloads into internal commands.
   - Alternative: call open-tag core directly from the bot. Rejected because it couples external SDKs to the core and makes later platform support harder.

2. **Bind MVP traffic to `#all`**
   - The first version uses the existing default public channel instead of introducing room mapping.
   - Alternative: auto-create channels per room. Rejected for MVP because it adds mapping, lifecycle, and onboarding complexity before the first integration is proven.

3. **Treat `#角色` as the explicit routing contract**
   - The gateway only forwards commands when a role tag is present, and uses that tag to select the target agent path.
   - Alternative: infer intent from free text. Rejected because it is less predictable and harder to test.

4. **Keep status updates minimal**
   - The gateway emits only a small set of progress messages: received, in progress, done, failure.
   - Alternative: mirror every internal state transition. Rejected because that would create noise in a high-exposure chat surface.

5. **Let ClawBot/OpenClaw own WeChat login**
   - Account settings exposes the open-tag gateway endpoint. ClawBot/OpenClaw performs WeChat扫码登录 and posts text messages to `sendmessage`; it polls `getupdates` for status/result text to send back to WeChat.
   - Alternative: have open-tag start its own personal-WeChat SDK session. Rejected because it conflates open-tag core with a specific WeChat SDK and still does not model ClawBot as the actual conversational endpoint.

## Risks / Trade-offs

- [Risk] WeChat platform quirks or SDK choice may force adapter changes later → Mitigation: keep the adapter thin and message-format driven.
- [Risk] `#all` can become noisy if bot traffic is high → Mitigation: restrict the MVP to explicit commands and minimal status updates.
- [Risk] Role parsing may not match the eventual open-tag routing taxonomy → Mitigation: make the gateway forward the parsed role as a stable internal field instead of hardcoding bot-specific logic in core.
- [Risk] Result payloads may be too large for WeChat → Mitigation: send short summaries and links, not full raw artifacts, when the output is long.
- [Risk] ClawBot/OpenClaw endpoint details may differ by version → Mitigation: keep the gateway payload parser narrow, text-first, and documented in `docs/wechat-adapter.md`.
- [Risk] Multiple bot accounts need isolation later → Mitigation: keep room/session ids on inbound/outbound messages even though MVP targets `#all`.

## Migration Plan

1. Add the gateway layer behind a narrow ClawBot/OpenClaw contract.
2. Wire inbound WeChat bot messages to the `#all` channel path.
3. Wire outbound task status/result messages into a pollable `getupdates` response.
4. Show the connection endpoint in settings.
5. Verify the loop in a local/dev environment before exposing it to real traffic.

Rollback:
- Disable the gateway entrypoint and the binding entrypoint, then leave open-tag core unchanged.
- No schema migration is required for the MVP path.

## Open Questions

- Which concrete ClawBot/OpenClaw deployment will call the open-tag gateway first.
- Whether the bot should send plain text only or also support attachments in a later slice.
- Whether status messages should be posted into `#all` only or also echoed in a dedicated operator channel.
- Whether unlink should be available to the user directly in settings or only to admins.
