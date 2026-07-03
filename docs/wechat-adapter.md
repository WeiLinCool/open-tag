# ClawBot / OpenClaw WeChat Gateway

open-tag treats WeChat as an external bot endpoint. The personal WeChat login session is
created through OpenClaw's Weixin QR login, then open-tag reads the saved local OpenClaw
Weixin account credentials and runs its own bridge:

1. long-poll iLink `getupdates` for inbound WeChat messages,
2. route explicit `@Bot #角色 ...` commands into open-tag `#all`,
3. send status/result text and agent-generated image/file attachments back through iLink
   `sendmessage`.

The token-gated `/api/integrations/wechat/openclaw/*` HTTP endpoints remain available for
ClawBot/OpenClaw-compatible adapters, but the local personal-WeChat MVP does not require the
OpenClaw gateway service to be installed or running.

## Local Development Token

Set the same token on open-tag and the ClawBot/OpenClaw bridge:

```bash
export WECHAT_GATEWAY_TOKEN="change-me"
```

In local development, when `NODE_ENV !== "production"` and `WECHAT_GATEWAY_TOKEN` is unset,
open-tag accepts `dev-wechat-gateway-token`. Production requires an explicit token.

## Endpoint Base

```text
http://localhost:7777/api/integrations/wechat/openclaw
```

## Web QR Login

Settings -> Account -> "Generate WeChat login QR" starts an OpenClaw login process on the
server:

```text
POST /api/auth/wechat-openclaw-login
GET  /api/auth/wechat-openclaw-login/:id
```

The server first prepares the local OpenClaw Weixin plugin:

```bash
openclaw plugins install @tencent-weixin/openclaw-weixin
openclaw plugins enable openclaw-weixin
```

Then it runs the login command from the project-local OpenClaw binary:

```bash
openclaw channels login --channel openclaw-weixin
```

The login process automatically receives `node_modules/.bin` in `PATH`. To force a specific
OpenClaw binary, set:

```bash
OPENCLAW_BIN=openclaw
```

open-tag parses the WeChat login URL from the OpenClaw output and renders it as a QR code in
the web UI. After the phone confirms login, OpenClaw stores the Weixin account under
`~/.openclaw/openclaw-weixin/`, and open-tag's in-process bridge picks it up automatically.

Bridge controls:

```bash
# disable the in-process OpenClaw Weixin poller
WECHAT_OPENCLAW_BRIDGE=false

# polling tick interval; each account long-poll may wait up to 35s
WECHAT_OPENCLAW_POLL_MS=5000

# override where OpenClaw stores account credentials
OPENCLAW_HOME=~/.openclaw
```

Headers:

```text
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <WECHAT_GATEWAY_TOKEN>
```

`x-wechat-gateway-token: <WECHAT_GATEWAY_TOKEN>` is also accepted for local adapters.

## Inbound: sendmessage

ClawBot/OpenClaw posts incoming WeChat text messages to:

```text
POST /api/integrations/wechat/openclaw/sendmessage
```

Body:

```json
{
  "msg": {
    "from_user_id": "wx_peer",
    "to_user_id": "wx_bot",
    "session_id": "wx_room_or_dm",
    "context_token": "reply-context",
    "create_time_ms": 1760000000000,
    "item_list": [
      { "type": 1, "text_item": { "text": "@Bot #分析师 总结今日热点" } }
    ]
  }
}
```

If the message contains an explicit `@Bot #角色` command, open-tag creates a `#all` task and
routes it to the matching agent.

## Outbound: getupdates

ClawBot/OpenClaw polls:

```text
POST /api/integrations/wechat/openclaw/getupdates
```

Body:

```json
{ "get_updates_buf": "" }
```

Response:

```json
{
  "ret": 0,
  "msgs": [
    {
      "to_user_id": "wx_room_or_dm",
      "session_id": "wx_room_or_dm",
      "message_type": 2,
      "message_state": 2,
      "item_list": [
        { "type": 1, "text_item": { "text": "[系统提示] 📥 已收到任务" } }
      ]
    }
  ],
  "get_updates_buf": "1",
  "longpolling_timeout_ms": 35000
}
```

The local in-process bridge supports text plus agent-generated attachments. When an agent
reply includes an open-tag attachment, the bridge reads the attachment bytes from open-tag
storage, calls iLink `getuploadurl`, AES-128-ECB encrypts the bytes, uploads the ciphertext to
the WeChat CDN, then sends either:

- image files (`image/*`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`) as `image_item`;
- HTML files as a single long-image preview `image_item` plus a short text summary that points
  back to the original open-tag attachment;
- all other files (Word, PDF, Excel, ZIP, etc.) as `file_item`.

Text and media are sent as separate `sendmessage` requests, matching the current
ClawBot/OpenClaw SDK practice where each message contains one `item_list` entry.
