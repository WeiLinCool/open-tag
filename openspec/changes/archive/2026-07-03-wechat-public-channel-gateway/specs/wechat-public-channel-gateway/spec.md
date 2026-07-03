## ADDED Requirements

### Requirement: Operator can connect a ClawBot/OpenClaw WeChat endpoint
The system MUST expose a token-gated WeChat bot gateway endpoint that ClawBot/OpenClaw can use to pass messages into open-tag and poll status/result messages back out.

#### Scenario: Operator views the gateway endpoint
- **WHEN** an authenticated user opens account settings
- **THEN** the system MUST show the ClawBot/OpenClaw gateway endpoint instead of a personal account binding-code or QR-session flow

#### Scenario: Bot posts an inbound text command
- **WHEN** ClawBot/OpenClaw posts a text message to `sendmessage`
- **THEN** the gateway MUST parse the message as a WeChat bot command and route eligible explicit role commands into open-tag

#### Scenario: Bot polls outbound status
- **WHEN** ClawBot/OpenClaw posts to `getupdates`
- **THEN** the gateway MUST return queued text status/result messages in an OpenClaw-style response

#### Scenario: Unauthorized bot request is rejected
- **WHEN** a ClawBot/OpenClaw request omits or sends the wrong gateway token
- **THEN** the system MUST reject the request without exposing the endpoint

### Requirement: WeChat bot can post into the public channel
The system MUST accept messages from a personal WeChat bot and route eligible messages into the open-tag `#all` public channel as standard channel content.

#### Scenario: User sends a normal message
- **WHEN** the WeChat bot receives a message addressed to the bot in a linked conversation
- **THEN** the gateway MUST deliver the message into open-tag `#all` as channel content

#### Scenario: Non-eligible message is ignored
- **WHEN** the WeChat bot receives a message that does not match the gateway's eligible message format
- **THEN** the gateway MUST NOT create an open-tag message or task

### Requirement: Explicit role tags route tasks to agents
The system MUST recognize explicit `#角色` tags in WeChat messages and route the command to the corresponding open-tag agent or task handler.

#### Scenario: Analyst command
- **WHEN** a WeChat message contains `@Bot #分析师 总结今日热点`
- **THEN** the gateway MUST extract the role tag and forward `总结今日热点` to the analyst routing path in open-tag

#### Scenario: Unknown role is rejected
- **WHEN** a WeChat message contains a role tag that cannot be resolved
- **THEN** the gateway MUST return a failure response to the bot and MUST NOT route the task

### Requirement: WeChat gateway returns execution status
The system MUST send minimal execution-state updates from open-tag back to the WeChat bot so the conversation reflects task progress.

#### Scenario: Task accepted
- **WHEN** open-tag accepts a routed task
- **THEN** the gateway MUST send a short status message indicating the task was received

#### Scenario: Task completed
- **WHEN** open-tag finishes the task successfully
- **THEN** the gateway MUST send the final result or result link back to WeChat
