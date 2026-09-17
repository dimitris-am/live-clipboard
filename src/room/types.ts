/** What the Worker hands the room. Owner creds are only built after authenticateOwner(). */
export type Cred =
  | { kind: "owner"; email: string; name: string }
  | { kind: "session"; sessionId: string };

/** A resolved, currently valid identity. Stored as each WebSocket's attachment. */
export type Actor =
  | { role: "owner"; email: string; name: string }
  | { role: "participant"; sessionId: string; name: string };

export type RoomRow = {
  slug: string;
  title: string;
  pin: string;
  pin_version: number;
  archived: number;
  bytes_used: number;
  created_at: number;
};

export type SessionRow = {
  id: string;
  name: string;
  pin_version: number;
  expires_at: number;
};

export type PostRow = {
  id: string;
  kind: string;
  text: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  r2_key: string | null;
  author_name: string;
  author_role: string;
  author_session: string | null;
  author_email: string | null;
  created_at: number;
  pinned: number;
  pinned_at: number | null;
};

export type RoomInfo = {
  slug: string;
  title: string;
  pin: string;
  archived: boolean;
  postCount: number;
  participantCount: number;
  bytesUsed: number;
  createdAt: number;
};

export type JoinOk = { sessionId: string; name: string; maxAgeSeconds: number };

/** One line of the owner's people list. Participants who joined stay listed until their session ends. */
export type Person = { name: string; role: Actor["role"]; online: boolean };

export type WirePost = {
  id: string;
  kind: "text" | "file";
  text?: string;
  file?: { name: string; size: number; type: string; url: string };
  authorName: string;
  authorRole: "owner" | "participant";
  createdAt: number;
  pinned: boolean;
  pinnedAt: number | null;
  mine: boolean;
};

export type UploadGrant = { postId: string; r2Key: string };
export type FileMeta = { postId: string; r2Key: string; name: string; size: number; type: string };
export type FileRef = { r2Key: string; name: string; type: string };

export type ServerMessage =
  | {
      type: "snapshot";
      room: { slug: string; title: string; archived: boolean };
      you: { name: string; role: Actor["role"] };
      online: number;
      posts: WirePost[];
    }
  | { type: "post.added"; post: WirePost }
  | { type: "post.deleted"; id: string }
  | { type: "post.pinned"; id: string; pinned: boolean; pinnedAt: number | null }
  | { type: "room.updated"; room: { title: string; archived: boolean } }
  | { type: "online"; count: number };

export function ownerCred(owner: { email: string; name: string }): Cred {
  return { kind: "owner", email: owner.email, name: owner.name };
}
