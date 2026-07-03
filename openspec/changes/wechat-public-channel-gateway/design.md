## Context

open-tag already has the core primitives needed for collaboration: channels, tasks, agents, and realtime updates. What it does not have yet is a thin external ingress that can translate a personal WeChat bot into those primitives without teaching the core about WeChat-specific APIs.

This change is intentionally an MVP. It targets one external surface, one public channel (`#all`), and explicit role tags for routing. That keeps the first integration small while preserving the adapter pattern needed for later platforms such as Feishu.

This change now also includes the prerequisite identity-binding slice needed for a personal WeChat bot: a logged-in open-tag user can generate a one-time binding code from account settings, send it to the personal WeChat bot so the bot can claim it with the native WeChat user id, then confirm it through the web UI before the gateway starts routing task traffic.

## Goals / Non-Goals

**Goals:**
- Accept eligible personal-WeChat messages and map them into open-tag `#all`.
- Parse explicit `#角色` instructions and route them into existing open-tag agent/task flows.
- Return short status updates and final outcomes back to WeChat.
- Keep WeChat concerns isolated in an adapter layer.
- Let a logged-in open-tag user bind a personal WeChat identity through a one-time code generated in account settings.
- Make the binding one-time, short-lived, and user-scoped so the gateway can later resolve WeChat traffic to the correct open-tag user.

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

5. **Bind WeChat through a web-generated one-time code**
   - The account settings page generates a short-lived code for the current open-tag user. The user sends that code to the personal WeChat bot; the bot claims the code with its native WeChat `userId`; the user then enters the same code in the web UI so the binding lands in open-tag's auth model.
   - Alternative: create the binding entirely inside chat. Rejected because it makes the auth flow depend on bot session state and complicates later platform parity.

## Risks / Trade-offs

- [Risk] WeChat platform quirks or SDK choice may force adapter changes later → Mitigation: keep the adapter thin and message-format driven.
- [Risk] `#all` can become noisy if bot traffic is high → Mitigation: restrict the MVP to explicit commands and minimal status updates.
- [Risk] Role parsing may not match the eventual open-tag routing taxonomy → Mitigation: make the gateway forward the parsed role as a stable internal field instead of hardcoding bot-specific logic in core.
- [Risk] Result payloads may be too large for WeChat → Mitigation: send short summaries and links, not full raw artifacts, when the output is long.
- [Risk] A one-time binding code can be intercepted or reused → Mitigation: make the code short-lived, single-use, and bound to the current logged-in user.
- [Risk] A bound WeChat identity may need to be revoked or re-bound later → Mitigation: support explicit unlinking instead of silent overwrite in the first slice.

## Migration Plan

1. Add the account-setting binding flow and persist the WeChat-to-user link.
2. Add the gateway layer behind a narrow internal contract.
3. Wire inbound WeChat messages to the `#all` channel path and resolve them through the bound user.
4. Wire outbound task status/result messages back to the bot.
5. Verify the loop in a local/dev environment before exposing it to real traffic.

Rollback:
- Disable the gateway entrypoint and the binding entrypoint, then leave open-tag core unchanged.
- No schema migration is required for the MVP path.

## Open Questions

- Which WeChat bot framework will be used for the first implementation.
- Whether the bot should send plain text only or also support attachments in a later slice.
- Whether status messages should be posted into `#all` only or also echoed in a dedicated operator channel.
- Whether unlink should be available to the user directly in settings or only to admins.
