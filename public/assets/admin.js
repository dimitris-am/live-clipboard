import { api, el, formatBytes, relativeTime, toast } from "./common.js";

const $ = (id) => document.getElementById(id);

let publicOrigin = "";
let openSlug = null; // keeps one "Manage" panel open across re-renders

function generatePin() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(values, (n) => String(n % 10)).join("");
}

function showExpired() {
  $("expired").hidden = false;
}

async function load() {
  const [config, rooms] = await Promise.all([api("/api/config"), api("/api/rooms")]);
  if (config.expired || rooms.expired) return showExpired();
  if (!config.ok || !rooms.ok) {
    toast(rooms.data?.error ?? config.data?.error ?? "Could not load rooms.");
    return;
  }
  publicOrigin = config.data.publicOrigin;
  render(rooms.data);
}

function render(rooms) {
  $("rooms-empty").hidden = rooms.length > 0;
  $("rooms-table").hidden = rooms.length === 0;
  $("rooms").replaceChildren(...rooms.map(roomRow));
}

function roomRow(room) {
  if (room.deletionIncomplete) {
    return el("tr", {}, [
      el("td", { colspan: "6" }, [
        el("strong", { class: "mono", text: room.slug }),
        " ",
        el("span", { class: "error", text: "Deletion incomplete." }),
        " ",
        el("button", {
          type: "button",
          text: "Retry deletion",
          onclick: (event) => deleteRoom(room.slug, room.slug, event.currentTarget),
        }),
      ]),
    ]);
  }

  const link = `${publicOrigin}/r/${room.slug}`;
  return el("tr", {}, [
    el("td", {}, [
      el("div", {}, [
        el("strong", { text: room.title }),
        room.archived ? " " : null,
        room.archived ? el("span", { class: "badge", text: "archived" }) : null,
      ]),
      el("div", { class: "mono muted", text: room.slug }),
      el("div", { class: "row-links" }, [
        el("a", { href: link, target: "_blank", rel: "noopener", text: "Public link" }),
        el("button", { type: "button", class: "link", text: "Copy link", onclick: () => copy(link) }),
        el("a", { href: `/r/${room.slug}`, text: "Owner board" }),
      ]),
      managePanel(room),
    ]),
    el("td", { class: "mono", text: room.pin }),
    el("td", { text: String(room.participantCount) }),
    el("td", { text: String(room.postCount) }),
    el("td", { text: formatBytes(room.bytesUsed) }),
    el("td", { text: relativeTime(room.createdAt) }),
  ]);
}

function managePanel(room) {
  const title = el("input", { value: room.title, maxlength: "80", "aria-label": "Title" });
  const rename = el("form", { onsubmit: (event) => { event.preventDefault(); void patchRoom(room.slug, { title: title.value }); } }, [
    title,
    el("button", { type: "submit", text: "Rename" }),
  ]);

  const pin = el("input", { maxlength: "12", placeholder: "New PIN", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "New PIN" });
  const changePin = el("form", { onsubmit: (event) => { event.preventDefault(); void changeRoomPin(room.slug, pin.value); } }, [
    pin,
    el("button", { type: "button", text: "Generate", onclick: () => { pin.value = generatePin(); } }),
    el("button", { type: "submit", text: "Change PIN" }),
    el("span", { class: "muted", text: "Everyone in the room will be signed out." }),
  ]);

  const archive = el("form", { onsubmit: (event) => { event.preventDefault(); void patchRoom(room.slug, { archived: !room.archived }); } }, [
    el("button", { type: "submit", text: room.archived ? "Unarchive" : "Archive" }),
    el("span", { class: "muted", text: room.archived ? "Participants can post again." : "The room becomes read-only." }),
  ]);

  const confirmSlug = el("input", { placeholder: room.slug, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": `Type ${room.slug} to delete` });
  const remove = el("form", { onsubmit: (event) => { event.preventDefault(); void deleteRoom(room.slug, confirmSlug.value, event.submitter); } }, [
    confirmSlug,
    el("button", { type: "submit", class: "danger", text: "Delete room" }),
    el("span", { class: "muted", text: "Type the slug to confirm. Deletes every post and file." }),
  ]);

  return el(
    "details",
    {
      class: "manage",
      open: openSlug === room.slug,
      ontoggle: (event) => {
        if (event.currentTarget.open) openSlug = room.slug;
        else if (openSlug === room.slug) openSlug = null;
      },
    },
    [el("summary", { text: "Manage" }), rename, changePin, archive, remove],
  );
}

async function afterAction(res, message) {
  if (res.expired) return showExpired();
  if (!res.ok) {
    toast(res.data?.error ?? "Something went wrong.");
    if (res.status === 500) await load(); // shows "Deletion incomplete" with Retry
    return;
  }
  toast(message);
  await load();
}

async function patchRoom(slug, body) {
  const res = await api(`/api/rooms/${slug}`, { method: "PATCH", body });
  const message = body.archived === undefined ? "Saved" : body.archived ? "Room archived" : "Room unarchived";
  await afterAction(res, message);
}

async function changeRoomPin(slug, pin) {
  const res = await api(`/api/rooms/${slug}/pin`, { method: "PUT", body: { pin } });
  await afterAction(res, "PIN changed. Everyone was signed out.");
}

async function deleteRoom(slug, confirm, button) {
  if (button) button.disabled = true;
  const res = await api(`/api/rooms/${slug}`, { method: "DELETE", body: { confirm } });
  if (button) button.disabled = false;
  if (res.ok && openSlug === slug) openSlug = null;
  await afterAction(res, "Room deleted");
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast(text);
  }
}

$("create-generate").addEventListener("click", () => {
  $("create-pin").value = generatePin();
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const res = await api("/api/rooms", {
    method: "POST",
    body: { slug: $("create-slug").value.trim(), title: $("create-title").value, pin: $("create-pin").value },
  });
  if (res.expired) return showExpired();
  $("create-error").hidden = res.ok;
  $("create-error").textContent = res.ok ? "" : res.data?.error ?? "Could not create the room.";
  if (res.ok) {
    form.reset();
    toast("Room created");
    await load();
  }
});

$("reload").addEventListener("click", () => location.reload());

void load();
