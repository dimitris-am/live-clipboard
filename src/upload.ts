import { normalizeContentType, sanitizeFileName } from "./files";
import { errorResponse, json } from "./http";
import { MAX_FILE_BYTES } from "./limits";
import type { Result } from "./results";
import type { Cred, FileMeta, UploadGrant } from "./room/types";

/** The two Room methods an upload needs; tests pass fakes. */
export type UploadRoom = {
  authorizeUpload(cred: Cred, size: number, name: string): Promise<Result<UploadGrant>>;
  commitFile(cred: Cred, meta: FileMeta): Promise<Result<{ id: string }>>;
};

/** authorize → stream to R2 → commit; deletes the R2 object if anything after storing fails. */
export async function uploadFile(request: Request, files: R2Bucket, room: UploadRoom, cred: Cred): Promise<Response> {
  const size = Number(request.headers.get("Content-Length"));
  if (!request.body || !Number.isInteger(size) || size < 1) {
    return json({ error: "Choose a file that is not empty" }, 400);
  }
  if (size > MAX_FILE_BYTES) return json({ error: "Files can be at most 25 MB" }, 413);

  let rawName: string;
  try {
    rawName = decodeURIComponent(request.headers.get("X-File-Name") ?? "");
  } catch {
    return json({ error: "The file name could not be read" }, 400);
  }
  const name = sanitizeFileName(rawName);
  const type = normalizeContentType(request.headers.get("Content-Type"));

  const grant = await room.authorizeUpload(cred, size, name);
  if (!grant.ok) return errorResponse(grant);
  const { postId, r2Key } = grant.value;

  // A raw request.body fails R2 with "Provided readable stream must have a known length".
  const { readable, writable } = new FixedLengthStream(size);
  try {
    await Promise.all([
      request.body.pipeTo(writable),
      files.put(r2Key, readable, { httpMetadata: { contentType: type } }),
    ]);
  } catch {
    await files.delete(r2Key);
    return json({ error: "The upload did not complete" }, 400);
  }

  let committed: Result<{ id: string }>;
  try {
    committed = await room.commitFile(cred, { postId, r2Key, name, size, type });
  } catch {
    committed = { ok: false, status: 500, error: "The upload could not be saved" };
  }
  if (!committed.ok) {
    await files.delete(r2Key);
    return errorResponse(committed);
  }
  return json({ id: committed.value.id }, 201);
}
