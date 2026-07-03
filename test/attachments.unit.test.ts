// Regression test: an upload whose saveObject fails BEFORE the file stream is consumed
// (e.g. s3Config() validation throws) must make parseUpload REJECT — not hang (busboy never
// emits "close") and not crash the process (unhandledRejection). Pre-fix this hangs/crashes.
// Run: npx tsx --test --test-force-exit test/attachments.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("parseUpload preserves utf-8 multipart filenames", { timeout: 8000 }, async () => {
  process.env.OPEN_TAG_STORAGE = "local";
  const { parseUpload } = await import("../src/server/attachments.ts");

  const B = "----otUtf8Boundary";
  const filename = "报告-测试.html";
  const body = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/html\r\n\r\n<html></html>\r\n--${B}--\r\n`,
  );
  const req: any = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${B}` };

  const out = await parseUpload(req);
  assert.equal(out.files[0]?.filename, filename);
});

test("parseUpload rejects (not hangs/crashes) when saveObject fails before consuming the stream", { timeout: 8000 }, async () => {
  const script = `
    import assert from "node:assert/strict";
    import { Readable } from "node:stream";
    process.env.OPEN_TAG_STORAGE = "s3";
    process.env.OPEN_TAG_S3_ENDPOINT = "http://127.0.0.1:9000";
    process.env.OPEN_TAG_S3_KEY = "k";
    process.env.OPEN_TAG_S3_SECRET = "s";
    delete process.env.OPEN_TAG_S3_BUCKET;
    const { parseUpload } = await import("./src/server/attachments.ts");
    const B = "----otTestBoundary";
    const body = Buffer.from(\`--\${B}\\r\\nContent-Disposition: form-data; name="files"; filename="t.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\nhello-bytes\\r\\n--\${B}--\\r\\n\`);
    const req = Readable.from([body]);
    req.headers = { "content-type": \`multipart/form-data; boundary=\${B}\` };
    await assert.rejects(parseUpload(req), /OPEN_TAG_S3_BUCKET/);
  `;
  await execFileAsync("npx", ["tsx", "--input-type=module", "-e", script], { cwd: process.cwd() });
});
