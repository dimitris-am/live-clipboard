import type { Actor, PostRow, WirePost } from "./types";

/** Shapes one stored post for one viewer. Session IDs and emails never leave the server. */
export function toWirePost(row: PostRow, slug: string, viewer: Actor): WirePost {
  const mine =
    viewer.role === "owner" ? row.author_email === viewer.email : row.author_session === viewer.sessionId;
  const base = {
    id: row.id,
    authorName: row.author_name,
    authorRole: row.author_role === "owner" ? ("owner" as const) : ("participant" as const),
    createdAt: row.created_at,
    pinned: row.pinned === 1,
    pinnedAt: row.pinned_at,
    mine,
  };
  if (row.kind === "file") {
    return {
      ...base,
      kind: "file",
      file: {
        name: row.file_name ?? "file",
        size: row.file_size ?? 0,
        type: row.file_type ?? "application/octet-stream",
        url: `/r/${slug}/files/${row.id}`,
      },
    };
  }
  return { ...base, kind: "text", text: row.text ?? "" };
}
