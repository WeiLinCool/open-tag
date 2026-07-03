import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const MAX_HTML_PREVIEW_CHARS = 4000;
const MAX_HTML_PREVIEW_WIDTH = 960;
const MAX_HTML_PREVIEW_HEIGHT = 16000;
const MAX_HTML_PREVIEW_BYTES = 900_000;

function resolveChromeExecutable(): string | undefined {
  const envPath = process.env.OPEN_TAG_CHROME_PATH?.trim();
  if (envPath) return envPath;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function isHtmlAttachment(filename: string, mimeType: string | null): boolean {
  return (mimeType ?? "").toLowerCase().includes("html") || /\.(html?|xhtml)$/i.test(filename);
}

export function htmlToPreviewText(html: string, filename: string, maxChars = MAX_HTML_PREVIEW_CHARS): string {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
  const text = plain.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return clipped ? `HTML预览：${filename}\n${clipped}` : `HTML预览：${filename}`;
}

export function fallbackWechatFilename(filename: string): string {
  const base = filename.replace(/\.(html?|xhtml)$/i, "");
  return `${base || "file"}.txt`;
}

export async function renderHtmlLongPreview(html: string): Promise<Buffer> {
  const title = extractHtmlPreviewTitle(html);
  const summary = htmlToPreviewText(html, "HTML").split("\n").slice(1).join(" ").slice(0, 160) || "HTML 长图预览";
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromeExecutable(),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1600 },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            html, body { margin: 0; padding: 0; background: #fff; color: #111; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .sheet { width: 1000px; margin: 0 auto; }
            .cover { padding: 48px 40px 36px; border-bottom: 1px solid #e7e7e7; background: linear-gradient(180deg, #ffffff 0%, #fafafa 100%); }
            .eyebrow { display: inline-block; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #666; margin-bottom: 16px; }
            .title { margin: 0; font-size: 30px; line-height: 1.25; font-weight: 700; color: #111; }
            .summary { margin: 12px 0 0; font-size: 16px; line-height: 1.7; color: #444; max-width: 860px; }
            .wrap { padding: 36px 40px 72px; box-sizing: border-box; }
          </style>
        </head>
        <body>
          <div class="sheet">
            <div class="cover">
              <div class="eyebrow">HTML preview</div>
              <h1 class="title">${escapeHtml(title)}</h1>
              <p class="summary">${escapeHtml(summary)}</p>
            </div>
            <div class="wrap">${html}</div>
          </div>
        </body>
      </html>`);
    const shot = await page.screenshot({ type: "png", fullPage: true });
    await page.close();
    return compressPng(Buffer.from(shot));
  } finally {
    await browser.close();
  }
}

function extractHtmlPreviewTitle(html: string): string {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (titleTag) return stripHtmlEntities(titleTag).slice(0, 80);
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.trim();
  if (heading) return stripHtmlEntities(heading).slice(0, 80);
  const text = htmlToPreviewText(html, "HTML", 140).split("\n").slice(1).join(" ").trim();
  return (text || "HTML 预览").slice(0, 80);
}

function stripHtmlEntities(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compressPng(input: Buffer): Buffer {
  const decoded = PNG.sync.read(input);
  if (decoded.width > MAX_HTML_PREVIEW_WIDTH || decoded.height > MAX_HTML_PREVIEW_HEIGHT || input.length > MAX_HTML_PREVIEW_BYTES) {
    const scale = Math.min(
      MAX_HTML_PREVIEW_WIDTH / decoded.width,
      MAX_HTML_PREVIEW_HEIGHT / decoded.height,
      Math.sqrt(MAX_HTML_PREVIEW_BYTES / Math.max(input.length, 1)),
      1,
    );
    const width = Math.max(1, Math.floor(decoded.width * scale));
    const height = Math.max(1, Math.floor(decoded.height * scale));
    const canvas = new PNG({ width, height });
    const src = decoded.data;
    const dst = canvas.data;
    for (let y = 0; y < height; y++) {
      const sy = Math.min(decoded.height - 1, Math.floor(y / scale));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(decoded.width - 1, Math.floor(x / scale));
        const s = (decoded.width * sy + sx) << 2;
        const d = (width * y + x) << 2;
        dst[d] = src[s]!;
        dst[d + 1] = src[s + 1]!;
        dst[d + 2] = src[s + 2]!;
        dst[d + 3] = src[s + 3]!;
      }
    }
    return PNG.sync.write(canvas, { colorType: 6 });
  }
  return input;
}
