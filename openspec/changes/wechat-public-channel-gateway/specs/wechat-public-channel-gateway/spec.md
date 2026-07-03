## ADDED Requirements

### Requirement: User can bind a personal WeChat identity from account settings
The system MUST let a logged-in open-tag user generate a one-time binding code from account settings and bind a personal WeChat identity to that user through the web UI.

#### Scenario: User generates a binding code
- **WHEN** an authenticated user opens account settings and requests a WeChat binding code
- **THEN** the system MUST create a short-lived single-use code tied to that user

#### Scenario: Bot claims the binding code
- **WHEN** the personal WeChat bot receives the binding code from a WeChat user
- **THEN** the system MUST record the WeChat user id on that pending code without completing the binding yet

#### Scenario: User confirms the code
- **WHEN** the user submits a valid unexpired binding code in the web UI
- **THEN** the system MUST persist a personal-WeChat-to-open-tag-user binding

#### Scenario: Reuse is rejected
- **WHEN** a code that has already been used or expired is submitted
- **THEN** the system MUST reject the request and MUST NOT create or overwrite a binding

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
