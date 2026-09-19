import { api, el, formatBytes, relativeTime, splitLinks, toast } from "./common.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

const slug = decodeURIComponent(location.pathname.split("/")[1] ?? "");
const base = `/${slug}`;
const $ = (id) => document.getElementById(id);
const composerText = $("composer-text");

const state = {
  you: null, // { name, role }
  room: null, // { slug, title, archived }
  posts: new Map(), // id → WirePost
  nodes: new Map(), // id → { key, node }, so unchanged posts (and their images) are not rebuilt
  socket: null,
  failures: 0,
  retryTimer: 0,
  pingTimer: 0,
  pongTimer: 0,
  stopped: true,
};

const isOwner = () => state.you?.role === "owner";

// ── Views ──────────────────────────────────────────────────────────────────

function show(view) {
  for (const id of ["join", "board", "expired", "gone"]) $(id).hidden = id !== view;
  const inRoom = view === "board";
  $("status").hidden = !inRoom;
  // Owners get the people dropdown in place of the plain count.
  $("online").hidden = !inRoom || isOwner();
  $("people").hidden = !inRoom || !isOwner();
  if (!inRoom) $("people").open = false;
  $("you").hidden = !inRoom;
  $("export").hidden = !inRoom;
  $("leave").hidden = !inRoom || isOwner();
}

function setOnline(count) {
  $("online").textContent = `${count} online`;
  $("people-summary").textContent = `${count} online`;
}

let peopleLoad = 0;

/** Fetches the owner's people list and renders it into the dropdown. Stale responses are ignored. */
async function loadPeople() {
  const list = $("people-list");
  const token = ++peopleLoad;
  if (list.childElementCount === 0) list.replaceChildren(el("li", { class: "muted", text: "Loading…" }));
  const res = await api(`${base}/api/people`);
  if (token !== peopleLoad) return;
  if (!res.ok) {
    list.replaceChildren(el("li", { class: "muted", text: res.data?.error ?? "Could not load the list." }));
    return;
  }
  const items = res.data.map((person) =>
    el("li", { class: person.online ? "online" : "offline" }, [
      el("span", { class: "name", text: person.name }),
      person.role === "owner" ? el("span", { class: "muted", text: "owner" }) : null,
      person.online ? null : el("span", { class: "muted", text: "offline" }),
    ]),
  );
  list.replaceChildren(...(items.length ? items : [el("li", { class: "muted", text: "Nobody has joined yet." })]));
}

function stopLive() {
  state.stopped = true;
  clearTimeout(state.retryTimer);
  stopHeartbeat();
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close(1000);
  }
}

function showJoin(message) {
  stopLive();
  state.you = null;
  $("room-title").textContent = "Live Clipboard";
  $("join-heading").textContent = `Join ${slug}`;
  $("join-error").textContent = message ?? "";
  $("join-error").hidden = !message;
  show("join");
  $("join-pin").focus();
}

function showExpired() {
  stopLive();
  show("expired");
}

function showGone() {
  stopLive();
  $("room-title").textContent = "Live Clipboard";
  show("gone");
}

function enterBoard(you) {
  state.you = you;
  state.stopped = false;
  state.failures = 0;
  $("you").textContent = you.role === "owner" ? `${you.name} (owner)` : you.name;
  show("board");
  connect();
}

function setStatus(name, label) {
  $("status").dataset.state = name;
  $("status").textContent = label;
}

// ── Live connection ────────────────────────────────────────────────────────

/** Sends "ping" every 25s; if no "pong" answers within 10s, the socket is presumed dead. */
function startHeartbeat(socket) {
  stopHeartbeat();
  state.pingTimer = setInterval(() => {
    if (state.socket !== socket) return;
    socket.send("ping");
    clearTimeout(state.pongTimer);
    state.pongTimer = setTimeout(() => {
      if (state.socket === socket) socket.close();
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(state.pingTimer);
  state.pingTimer = 0;
  clearTimeout(state.pongTimer);
  state.pongTimer = 0;
}

function connect() {
  clearTimeout(state.retryTimer);
  if (state.stopped) return;
  setStatus(state.failures ? "reconnecting" : "connecting", state.failures ? "Reconnecting…" : "Connecting…");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}${base}/api/live`);
  state.socket = socket;

  socket.onopen = () => {
    state.failures = 0;
    setStatus("live", "Live");
    startHeartbeat(socket);
  };
  socket.onmessage = (event) => {
    if (event.data === "pong") {
      clearTimeout(state.pongTimer);
      return;
    }
    try {
      handle(JSON.parse(event.data));
    } catch (err) {
      console.error(err);
    }
  };
  socket.onclose = (event) => {
    stopHeartbeat();
    if (state.socket !== socket) return; // closed on purpose by stopLive()
    state.socket = null;
    if (event.code === 4401) return showJoin("Your session ended. Join again.");
    if (event.code === 4404) return showGone();
    state.failures += 1;
    setStatus("reconnecting", "Reconnecting…");
    if (state.failures >= 2) {
      void probe().then((handled) => {
        if (!handled) scheduleReconnect();
      });
    } else {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  if (state.stopped) return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, state.failures - 1)) * (0.8 + Math.random() * 0.4);
  state.retryTimer = setTimeout(connect, delay);
}

/** A failed WebSocket upgrade hides its status code, so ask over HTTP. Returns true if the view changed. */
async function probe() {
  const me = await api(`${base}/api/me`);
  if (me.expired || (me.status === 401 && me.data?.error === "Owner sign-in required")) {
    showExpired();
    return true;
  }
  if (me.status === 401) {
    showJoin("Your session ended. Join again.");
    return true;
  }
  if (me.status === 404) {
    showGone();
    return true;
  }
  return false;
}

function handle(msg) {
  switch (msg.type) {
    case "snapshot":
      state.room = msg.room;
      state.you = msg.you;
      state.posts = new Map(msg.posts.map((post) => [post.id, post]));
      state.nodes.clear();
      setOnline(msg.online);
      if ($("people").open) void loadPeople();
      renderRoom();
      renderPosts();
      break;
    case "post.added":
      state.posts.set(msg.post.id, msg.post);
      renderPosts(msg.post.id);
      break;
    case "post.deleted":
      state.posts.delete(msg.id);
      renderPosts();
      break;
    case "post.pinned": {
      const post = state.posts.get(msg.id);
      if (post) {
        post.pinned = msg.pinned;
        post.pinnedAt = msg.pinnedAt;
        renderPosts();
      }
      break;
    }
    case "room.updated":
      state.room = { ...state.room, ...msg.room };
      renderRoom();
      renderPosts();
      break;
    case "online":
      setOnline(msg.count);
      if ($("people").open) void loadPeople();
      break;
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderRoom() {
  $("room-title").textContent = state.room.title;
  document.title = `${state.room.title} · Live Clipboard`;
  $("archived-banner").hidden = !state.room.archived;
  $("composer").hidden = state.room.archived;
}

function renderPosts(freshId) {
  const all = [...state.posts.values()];
  const pinned = all.filter((p) => p.pinned).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
  const feed = all
    .filter((p) => !p.pinned)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

  for (const id of state.nodes.keys()) if (!state.posts.has(id)) state.nodes.delete(id);
  $("pinned-heading").hidden = pinned.length === 0;
  $("pinned").replaceChildren(...pinned.map(nodeFor));
  $("feed").replaceChildren(...feed.map(nodeFor));
  $("empty").hidden = feed.length > 0;

  const fresh = freshId ? state.nodes.get(freshId)?.node : null;
  if (fresh) {
    fresh.classList.add("fresh");
    setTimeout(() => fresh.classList.remove("fresh"), 50);
  }
}

function nodeFor(post) {
  const key = JSON.stringify([post.pinned, post.pinnedAt, state.you?.role, state.room?.archived]);
  const cached = state.nodes.get(post.id);
  if (cached && cached.key === key) return cached.node;
  const node = postNode(post);
  state.nodes.set(post.id, { key, node });
  return node;
}

function postNode(post) {
  const actions = [];
  if (post.kind === "text") {
    actions.push(el("button", { type: "button", text: "Copy", onclick: () => copyText(post.text) }));
  } else {
    actions.push(el("a", { class: "button-link", href: post.file.url, download: post.file.name, text: "Download" }));
  }
  if (isOwner()) {
    actions.push(el("button", { type: "button", text: post.pinned ? "Unpin" : "Pin", onclick: () => setPinned(post.id, !post.pinned) }));
  }
  if (isOwner() || (post.mine && !state.room?.archived)) {
    actions.push(el("button", { type: "button", class: "danger", text: "Delete", onclick: (event) => deletePost(post.id, event.currentTarget) }));
  }

  const head = el("div", { class: "post-head" }, [
    el("span", { class: "post-author", text: post.authorName }),
    post.authorRole === "owner" ? el("span", { class: "badge", text: "owner" }) : null,
    el("time", {
      class: "muted",
      datetime: new Date(post.createdAt).toISOString(),
      dataset: { time: String(post.createdAt) },
      text: relativeTime(post.createdAt),
    }),
    el("span", { class: "post-actions" }, actions),
  ]);

  let body;
  if (post.kind === "text") {
    body = el(
      "pre",
      { class: "post-text" },
      splitLinks(post.text).map((part) =>
        part.type === "link"
          ? el("a", { href: part.value, target: "_blank", rel: "noopener noreferrer", text: part.value })
          : part.value,
      ),
    );
  } else {
    const image = INLINE_IMAGES.has(post.file.type)
      ? el("a", { href: post.file.url, target: "_blank", rel: "noopener" }, [
          el("img", { class: "thumb", src: post.file.url, alt: post.file.name, loading: "lazy" }),
        ])
      : null;
    body = el("div", { class: "post-file" }, [
      el("span", { text: `📎 ${post.file.name} · ${formatBytes(post.file.size)}` }),
      image,
    ]);
  }
  return el("li", { class: "post", dataset: { id: post.id } }, [head, body]);
}

// ── Actions ────────────────────────────────────────────────────────────────

function reportFailure(res) {
  if (res.expired) return showExpired();
  if (res.status === 401) return void probe();
  const wait = res.data?.retryAfter ? ` Try again in ${res.data.retryAfter} s.` : "";
  toast(`${res.data?.error ?? "Something went wrong."}${wait}`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed. Select the text and copy it by hand.");
  }
}

async function setPinned(id, pinned) {
  const res = await api(`${base}/api/posts/${id}/pin`, { method: "POST", body: { pinned } });
  if (!res.ok) reportFailure(res);
}

async function deletePost(id, button) {
  button.disabled = true;
  const res = await api(`${base}/api/posts/${id}`, { method: "DELETE" });
  if (!res.ok) {
    button.disabled = false;
    reportFailure(res);
  }
}

async function submitText() {
  const text = composerText.value;
  if (text.trim() === "") return;
  const button = $("composer-submit");
  button.disabled = true;
  const res = await api(`${base}/api/posts`, { method: "POST", body: { text } });
  button.disabled = false;
  if (!res.ok) return reportFailure(res);
  if (composerText.value === text) composerText.value = "";
  composerText.focus();
}

function canUpload() {
  return !$("board").hidden && state.room && !state.room.archived;
}

function uploadBlockedMessage() {
  return state.room?.archived ? "This room is archived. It is read-only." : "Join the room to share files.";
}

function startUpload(file) {
  const progress = el("progress", { max: "100", value: "0" });
  const row = el("li", { class: "upload" }, [el("span", { text: `${file.name} · ${formatBytes(file.size)}` }), progress]);
  $("uploads").append(row);

  const failRow = (message) => {
    progress.remove();
    row.append(
      el("span", { class: "error", text: message }),
      el("button", { type: "button", text: "Retry", onclick: () => { row.remove(); startUpload(file); } }),
      el("button", { type: "button", class: "link", text: "Dismiss", onclick: () => row.remove() }),
    );
  };

  if (file.size === 0) return failRow("This file is empty.");
  if (file.size > MAX_FILE_BYTES) return failRow("Files can be at most 25 MB.");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${base}/api/files`);
  xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name || "pasted-file"));
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100);
  };
  xhr.onload = () => {
    if (xhr.status === 201) return row.remove();
    let message = "Upload failed.";
    try {
      message = JSON.parse(xhr.responseText).error ?? message;
    } catch {
      // keep the generic message
    }
    failRow(message);
  };
  xhr.onerror = () => failRow("Upload failed. Check your connection.");
  xhr.send(file);
}

function uploadFiles(files) {
  if (!canUpload()) return;
  for (const file of files) startUpload(file);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("join-name").value;
  $("join-submit").disabled = true;
  const res = await api(`${base}/api/join`, { method: "POST", body: { pin: $("join-pin").value, name } });
  $("join-submit").disabled = false;
  if (res.ok) {
    $("join-pin").value = "";
    try {
      localStorage.setItem("clip-name", name.trim());
    } catch {
      // storage unavailable (private mode); the name just isn't remembered
    }
    return enterBoard({ name: res.data.name, role: "participant" });
  }
  if (res.status === 429 && res.data?.retryAfter) {
    const minutes = Math.ceil(res.data.retryAfter / 60);
    return showJoin(`Too many attempts, try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
  showJoin(res.data?.error ?? "Could not join. Try again.");
});

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitText();
});

composerText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submitText();
  }
});

document.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0) {
    event.preventDefault();
    if (!canUpload()) return toast(uploadBlockedMessage());
    uploadFiles(files);
    return;
  }
  if ($("board").hidden) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target === composerText || ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
  if ($("composer").hidden) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  composerText.value += text;
  composerText.focus();
});

// Phones cannot paste or drop files, so the composer also offers a file picker.
$("file-input").addEventListener("change", (event) => {
  const input = event.currentTarget;
  uploadFiles([...input.files]);
  input.value = "";
});

document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (canUpload()) document.body.classList.add("dropping");
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dropping");
});
document.addEventListener("drop", (event) => {
  document.body.classList.remove("dropping");
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  if (!canUpload()) return toast(uploadBlockedMessage());
  uploadFiles(files);
});

// The export is a plain download; the room is stamped in the reader's own timezone.
$("export").href = `${base}/export?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`;

$("leave").addEventListener("click", async () => {
  await api(`${base}/api/leave`, { method: "POST" });
  showJoin();
});

$("reload").addEventListener("click", () => location.reload());

$("people").addEventListener("toggle", () => {
  if ($("people").open) void loadPeople();
});
document.addEventListener("click", (event) => {
  const people = $("people");
  if (people.open && !people.contains(event.target)) people.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("people").open = false;
});

setInterval(() => {
  for (const node of document.querySelectorAll("time[data-time]")) {
    node.textContent = relativeTime(Number(node.dataset.time));
  }
}, 30_000);

try {
  $("join-name").value = localStorage.getItem("clip-name") ?? "";
} catch {
  // storage unavailable
}

async function start() {
  const me = await api(`${base}/api/me`);
  if (me.expired || (me.status === 401 && me.data?.error === "Owner sign-in required")) return showExpired();
  if (me.ok) return enterBoard(me.data);
  if (me.status === 401) return showJoin();
  if (me.status === 404) return showGone();
  toast(me.data?.error ?? "Could not load the room.");
}

void start();
