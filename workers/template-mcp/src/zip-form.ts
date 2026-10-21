import { TEMPLATE_ZIP_FORM_MAX_BYTES, TEMPLATE_ZIP_LIMITS } from "@anjuna/contracts";

/** Bound multipart bytes before formData() buffers the request, including chunked requests. */
export async function readZipForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType)) throw new Error("Expected multipart/form-data");
  if (Number(request.headers.get("content-length")) > TEMPLATE_ZIP_FORM_MAX_BYTES) throw new Error("ZIP upload exceeds 30 MB");
  if (!request.body) throw new Error("ZIP file is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TEMPLATE_ZIP_FORM_MAX_BYTES) {
        await reader.cancel();
        throw new Error("ZIP upload exceeds 30 MB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0) throw new Error("ZIP file is required");
  if (file.size > TEMPLATE_ZIP_LIMITS.maxArchiveBytes) throw new Error("ZIP upload exceeds 30 MB");
  return form;
}
