## 1. Gateway contract

- [x] 1.1 Define the internal inbound payload shape for WeChat messages targeting `#all`
- [x] 1.2 Define the outbound status/result payload shape back to WeChat

## 2. WeChat Bot endpoint connection

- [x] 2.1 Add account-settings UI for showing the ClawBot/OpenClaw gateway endpoint
- [x] 2.2 Add token-gated OpenClaw-style `sendmessage` inbound endpoint
- [x] 2.3 Add token-gated OpenClaw-style `getupdates` outbound polling endpoint
- [x] 2.4 Add tests for inbound command routing and outbound status polling

## 3. WeChat adapter

- [x] 3.1 Add a thin WeChat gateway module that receives personal WeChat messages
- [x] 3.2 Parse `@Bot #角色` commands and map them to internal routing fields
- [x] 3.3 Ignore ineligible messages without creating open-tag messages or tasks
- [x] 3.4 Keep WeChat SDK and ClawBot/OpenClaw runtime concerns outside open-tag core

## 4. open-tag integration

- [x] 4.1 Route eligible WeChat messages into the existing `#all` public channel path
- [x] 4.2 Forward resolved role-tag commands to the existing agent/task execution flow
- [x] 4.3 Emit minimal progress updates from open-tag back through the gateway

## 5. Verification

- [x] 5.1 Add tests for message acceptance, role parsing, and unknown-role rejection
- [x] 5.2 Add an end-to-end check that a WeChat message can produce a task and receive a completion reply
