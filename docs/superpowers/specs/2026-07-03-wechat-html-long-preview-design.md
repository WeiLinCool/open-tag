# Design — WeChat HTML delivery via single long-image preview

- **Date:** 2026-07-03
- **Status:** approved-for-plan
- **Scope tier:** delivery strategy change for HTML artifacts only

## Problem

HTML attachments are the right source format for open-tag, but they are the wrong delivery
format for WeChat. The current WeChat bridge can move bytes, but WeChat mobile clients are
unreliable for `.html` downloads and do not provide a good reading experience for original
HTML content. The result is a mismatch:

1. open-tag has the original HTML content and should remain the source of truth;
2. WeChat users want a fast visual summary on mobile;
3. desktop/web users should continue to inspect the original in open-tag;
4. the same artifact should not be forced into a single transport shape that satisfies both.

The practical conclusion is to stop treating HTML as a file-first WeChat payload. HTML should
be delivered to WeChat as a visual preview artifact, while the original HTML stays in open-tag.

## Goals

- Keep the original HTML content in open-tag unchanged.
- For WeChat, deliver HTML as a single long-image preview plus a text summary.
- Keep the mobile WeChat experience fast and readable.
- Preserve a clear path back to the original open-tag message or attachment.
- Make the behavior specific to HTML only; do not change image, PDF, Word, or other file
  handling.

## Non-goals

- No attempt to make WeChat natively open `.html` as an interactive document.
- No multi-page preview carousel.
- No full HTML editor or transformer.
- No change to non-HTML attachment delivery.
- No change to the open-tag channel rendering model beyond preserving the original artifact.

## Design

### 1. HTML stays original in open-tag

When an agent produces an HTML artifact, open-tag continues to store and render the original
file in the channel. That file is the canonical artifact for desktop/web review and for any
follow-up actions inside open-tag.

The WeChat bridge does not replace the original with a down-converted file. It adds a delivery
view for WeChat only.

### 2. WeChat gets a single long-image preview

For HTML attachments, the bridge generates one vertically stacked preview image that captures
the important visible structure of the document. The image is optimized for mobile reading:

- single image only;
- tall enough to preserve page flow;
- readable text hierarchy;
- no interaction required to understand the preview;
- safe fallback if some HTML features cannot be rendered.

The preview is sent as an `image_item`, because that is the most reliable way to display
visual content in WeChat across mobile clients.

### 3. WeChat also gets a short text summary

The long image is paired with a text message that summarizes what the artifact is and where the
original lives in open-tag. The text should make the split explicit:

- this is a preview;
- the original HTML is still available in open-tag;
- the review link points back to the source message / attachment.

This keeps mobile users from mistaking the preview for the canonical original.

### 4. Desktop/web review stays on open-tag

For users on open-tag web/PC, the canonical HTML file remains available through the existing
attachment flow. The WeChat preview is only a convenience layer.

If the WeChat user needs the source, the message should point back to open-tag rather than try
to duplicate the original HTML semantics inside WeChat.

## Data flow

1. Agent creates or uploads an HTML artifact in open-tag.
2. open-tag stores the original HTML attachment as-is.
3. The WeChat bridge detects that the attachment is HTML.
4. The bridge generates one long preview image from the HTML.
5. The bridge sends:
   - a text summary;
   - one image message containing the long preview;
   - a link or identifier that points back to the original open-tag artifact.
6. The original HTML remains available in the open-tag channel for full review.

## Failure handling

- If preview generation fails, the bridge should fall back to text-only delivery plus a link
  back to open-tag.
- If the HTML file cannot be read, do not block delivery of the rest of the message thread.
- If the preview image is too large, degrade the preview rather than dropping the artifact.
- If the transport to WeChat fails, keep the original attachment in open-tag and retry the
  outbound delivery path normally.

## Testing strategy

- Unit test that HTML attachments are classified into the preview path.
- Unit test that non-HTML files keep their existing delivery path.
- Integration test that an HTML artifact produces:
  - a text summary,
  - one image preview message,
  - a reference back to the original open-tag item.
- Regression test that the original HTML attachment still remains accessible in open-tag.

## Files expected to change

- `src/server/wechatOpenClawBridge.ts` or a small preview helper used by it
- `src/server/attachments.ts` only if preview extraction needs shared filename/mime handling
- `test/wechatOpenClawBridge.integration.ts`
- `test/attachments.unit.test.ts` or a dedicated HTML preview unit test

## Result

HTML becomes a two-view artifact:

- open-tag: canonical original
- WeChat: single long-image preview for mobile convenience

That closes the loop without forcing WeChat to be the system of record for HTML.
