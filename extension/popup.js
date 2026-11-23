import { normalizeCode, CODE_LENGTH } from "./code.js";
import { ICONS } from "./icons.js";

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let state = null;
let editing = null; // the system being edited ({} for a new one), or null
let confirming = null; // id of the system whose removal is being confirmed
let focusConfirm = false;
const notes = new Map(); // system id -> { text, cls } after an action
const opening = new Set();

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (r && r.error && r.ok !== false) throw new Error(r.error);
    return r;
  });
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "icon") setIcon(e, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

function setIcon(node, name) {
  node.dataset.icon = name;
  node.innerHTML = ICONS[name] || "";
}
const icon = (name) => el("span", { icon: name });
for (const node of document.querySelectorAll("[data-icon]")) setIcon(node, node.dataset.icon);

// A system's avatar: its initials in one of the platform's category tones,
// by its place in the list, so neighbours never share a colour.
const TONES = ["blue", "violet", "teal", "amber", "green"];
const toneAt = (i) => TONES[i % TONES.length];
function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((words[0] || "?")[0] + (words[1] ? words[1][0] : "")).toUpperCase();
}
const KIND = { webgui: "Web GUI", fiori: "Fiori", other: "SAP" };
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
/** "localhost:8010 · client 800": where a system is, short. The full address is in its tooltip. */
function whereOf(x) {
  return hostOf(x.url) + (x.client ? ` · client ${x.client}` : "");
}
/** The same, as two parts: a long host is shortened, the client never. */
function whereLine(x) {
  return el("div", { class: "meta where", title: x.url }, el("span", { class: "host" }, hostOf(x.url)), x.client ? el("span", { class: "client" }, ` · client ${x.client}`) : null);
}

// ---------------------------------------------------------------- status

const STATUS = {
  ready: { pill: "Ready", tone: "", icon: "info" },
  ok: { pill: "Connected", tone: "ok", icon: "plugZap" },
  wait: { pill: "", tone: "wait", icon: "pause" },
  bad: { pill: "", tone: "bad", icon: "triangleAlert" },
};

function renderStatus(s) {
  const actions = $("status-actions");
  actions.replaceChildren();
  const notPaired = s.status === "no_code" || s.status === "bad_managed_code";
  let kind = "ready";
  let pill = "Ready";
  let title;
  let detail;
  if (s.paused) {
    kind = "wait";
    pill = "Paused";
    title = "Sharing is paused";
    detail = "Your agent cannot see or open any SAP tab until you resume.";
    actions.append(el("button", { class: "btn sm", type: "button", onclick: () => send({ cmd: "resume" }).then(refresh) }, icon("play"), "Resume sharing"));
  } else if (s.status === "connected") {
    kind = "ok";
    pill = "Connected";
    title = "Your agent is connected";
    if (s.agent) detail = `Working in ${s.agent.system ? `${s.agent.system}` : `“${s.agent.title || "a SAP tab"}”`}.`;
    else detail = s.systems.length ? "It opens your systems when it needs them." : "Add a SAP system below so it can work in it.";
  } else if (notPaired) {
    kind = "wait";
    pill = "Not paired";
    title = "Not connected to an agent yet";
    detail = s.status === "bad_managed_code" ? "The pairing code set by your organization is invalid. Ask your IT department." : "";
  } else if (s.status === "wrong_code") {
    kind = "bad";
    pill = "Pair again";
    title = "Your agent uses another pairing code";
    detail = "Pair this browser again to reconnect.";
    if (!s.code.managed) actions.append(el("button", { class: "btn sm", type: "button", onclick: pairNow }, "Pair again"));
  } else if (s.status === "busy") {
    kind = "bad";
    pill = "Busy";
    title = "Your agent is using another browser";
    detail = "Close the other Chrome window or profile, then reconnect.";
    actions.append(el("button", { class: "btn sm", type: "button", onclick: () => send({ cmd: "reconnect" }).then(() => setTimeout(refresh, 300)) }, "Reconnect"));
  } else if (s.status === "untrusted" || s.status === "tampered") {
    kind = "bad";
    pill = "Blocked";
    title = "Connection refused";
    detail = s.status === "untrusted" ? `The program on port ${s.port} did not prove it is your agent. Nothing was shared.` : `A message on port ${s.port} did not come from your agent. The connection was closed.`;
  } else if (s.systems.length) {
    title = "Ready for your agent";
    detail = "Ask it to work in one of your systems. It connects by itself.";
  } else {
    title = "Add your SAP system to start";
    detail = "Then ask your agent to work in it.";
  }
  const look = STATUS[kind];
  $("pill").className = `pill ${look.tone}`;
  $("pill-text").textContent = pill;
  $("status").className = `status ${look.tone}`;
  setIcon($("status-icon"), look.icon);
  $("status-title").textContent = title;
  $("status-detail").textContent = detail || "";

  // Pairing replaces the status while there is nothing to connect to.
  const pairing = notPaired && !s.code.managed;
  $("pairing").hidden = !pairing;
  $("status").hidden = pairing;
  if (pairing) {
    $("pair-text").textContent = s.helper.ok
      ? "One click: the extension reads the pairing code from this computer."
      : "Install the helper first. In a terminal, run:";
    $("pair-cmd").hidden = s.helper.ok;
    $("pair").textContent = s.helper.ok ? "Pair with this computer" : "I ran it, pair now";
  }
}

async function pairNow() {
  const hint = $("pair-hint");
  hint.className = "hint";
  hint.textContent = "Pairing…";
  const r = await send({ cmd: "pair" }).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) hint.textContent = "Paired.";
  else {
    hint.className = "hint error";
    hint.textContent =
      r.error === "helper_missing"
        ? "The helper is not installed, or Chrome needs a restart after installing it. Run the command above, or pair with a code."
        : r.error;
    if (r.error === "helper_missing") $("pair-manual").open = true;
  }
  refresh();
}

// ---------------------------------------------------------------- systems

/** What the row's one button does: log on when a password is saved, else open. */
function goLabel(x) {
  if (opening.has(x.id) || x.loggingOn) return x.passwordIn && !x.sso && !x.open ? "Logging on…" : "Opening…";
  return x.passwordIn && !x.sso && !x.open ? "Log on" : "Open";
}

function whoLine(x) {
  const parts = [KIND[x.kind] || "SAP"];
  if (x.sso) parts.push("single sign-on");
  else if (x.user) parts.push(x.user);
  return parts.join(" · ");
}

function passwordNote(x) {
  if (x.passwordIn === "keychain") return "Password saved in your keychain";
  if (x.passwordIn === "profile") return "Password saved in this Chrome profile";
  return null;
}

function systemRow(x, i) {
  const note = notes.get(x.id);
  const busy = opening.has(x.id) || x.loggingOn;
  if (confirming === x.id) {
    return el(
      "li",
      { class: "sys confirming" },
      el("div", { class: "body" }, el("div", { class: "name" }, el("span", {}, `Remove ${x.name}?`)), el("div", { class: "note" }, x.passwordIn ? "Its saved password is deleted too." : "You can add it again later.")),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn sm", type: "button", onclick: () => ((confirming = null), render(state)) }, "Cancel"),
        el("button", { class: "btn sm danger", type: "button", "data-autofocus": true, onclick: () => removeSystem(x) }, "Remove"),
      ),
    );
  }
  const pw = passwordNote(x);
  return el(
    "li",
    { class: "sys", "data-id": x.id },
    el("span", { class: `avatar tone-${toneAt(i)}`, "aria-hidden": "true" }, initials(x.name)),
    el(
      "div",
      { class: "body" },
      el("div", { class: "name" }, el("span", {}, x.name), x.open ? el("i", { class: "open-dot", title: "Open in a tab", "aria-label": "open in a tab" }) : null),
      whereLine(x),
      el("div", { class: "meta" }, el("span", {}, whoLine(x)), pw ? el("span", { icon: "keyRound", title: pw, "aria-label": pw }) : null),
      note ? el("div", { class: `note ${note.cls}`, role: "status" }, note.text) : null,
    ),
    el("button", { class: "btn sm go", type: "button", disabled: busy, title: x.url, onclick: () => openSystem(x) }, goLabel(x)),
    el("button", {
      class: "icon-btn more",
      type: "button",
      icon: "ellipsis",
      "aria-label": `More for ${x.name}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      onclick: (e) => openMenu(e.currentTarget, x),
    }),
  );
}

function currentSuggestion(s) {
  const t = s.currentTab;
  return t && !t.system && t.suggestion && t.suggestion.sapLike ? t.suggestion : null;
}

function renderSystems(s) {
  const focused = document.activeElement && document.activeElement.closest(".sys");
  const focusKey = focused ? [focused.dataset.id, [...focused.querySelectorAll("button")].indexOf(document.activeElement)] : null;
  $("systems").replaceChildren(...s.systems.map((x, i) => systemRow(x, i)));
  if (focusKey) $("systems").querySelector(`.sys[data-id="${focusKey[0]}"]`)?.querySelectorAll("button")[focusKey[1]]?.focus();
  if (focusConfirm) $("systems").querySelector("[data-autofocus]")?.focus();
  focusConfirm = false;

  const has = s.systems.length > 0;
  const sug = currentSuggestion(s);
  $("list-head").hidden = !has;
  $("count").textContent = has ? String(s.systems.length) : "";
  $("empty").hidden = has;
  $("add-current").hidden = !(has && sug);
  if (sug) $("add-current-detail").textContent = `${KIND[sug.kind] || "SAP"} · ${whereOf(sug)}`;

  if (!has) {
    const add = $("empty-add");
    const pairingShown = !$("pairing").hidden;
    add.className = `btn ${pairingShown ? "" : "primary"}`;
    if (sug) {
      $("empty-text").textContent = "This tab is a SAP system. Add it, and your agent can open it and log on.";
      add.replaceChildren(el("span", {}, "Add this SAP page"), el("span", { class: "empty-detail" }, whereOf(sug)));
      $("empty-manual").hidden = false;
    } else {
      $("empty-text").textContent = "Open your SAP system in a tab (the Web GUI or the Fiori launchpad), then add it here.";
      add.replaceChildren(el("span", {}, "Add a system"));
      $("empty-manual").hidden = true;
    }
  }
}

function addFromCurrent() {
  const sug = state && currentSuggestion(state);
  if (sug) startEdit(null, { name: sug.name, url: sug.url, client: sug.client, language: sug.language });
  else startEdit(null);
}

function flash(id, note, ms) {
  notes.set(id, note);
  setTimeout(() => {
    notes.delete(id);
    if (state && !editing) render(state);
  }, ms);
}

async function openSystem(x) {
  opening.add(x.id);
  notes.delete(x.id);
  render(state);
  const r = await send({ cmd: "openSystem", id: x.id }).catch((e) => ({ ok: false, error: e.message }));
  opening.delete(x.id);
  if (r.ok) {
    const text = { logged_on: `Logged on${x.user ? ` as ${x.user}` : ""}`, already: "Switched to its tab", sso: "Opened", needs_user: "Log on in the tab" }[r.state] || "Opened";
    flash(x.id, { text, cls: r.state === "needs_user" ? "" : "ok" }, 4000);
  } else flash(x.id, { text: r.error, cls: "bad" }, 15000);
  refresh();
}

async function removeSystem(x) {
  confirming = null;
  await send({ cmd: "deleteSystem", id: x.id }).catch((e) => showListError(e.message));
  refresh();
}

async function forgetPassword(x) {
  const system = { id: x.id, name: x.name, url: x.url, client: x.client, language: x.language, user: x.user, sso: x.sso };
  const r = await send({ cmd: "saveSystem", system, password: "", clearPassword: true }).catch((e) => ({ ok: false, error: e.message }));
  if (r && r.ok === false) showListError(r.error);
  else flash(x.id, { text: "Password forgotten", cls: "" }, 4000);
  refresh();
}

function showListError(text) {
  $("list-error").textContent = text;
  $("list-error").hidden = false;
  setTimeout(() => ($("list-error").hidden = true), 10000);
}

// ---------------------------------------------------------------- the ⋯ menu

let menuOwner = null;

function openMenu(button, x) {
  if (menuOwner === button) return closeMenu();
  closeMenu();
  const menu = $("menu");
  const item = (label, iconName, onpick, cls = "") =>
    el("button", { class: `menu-item ${cls}`, type: "button", role: "menuitem", tabindex: "-1", onclick: () => (closeMenu(), onpick()) }, icon(iconName), label);
  const items = [item("Edit", "pencil", () => startEdit(x))];
  if (x.passwordIn && !x.sso) items.push(item("Open without logging on", "externalLink", () => chrome.tabs.create({ url: x.url })));
  if (x.passwordIn) items.push(item("Forget the password", "keyRound", () => forgetPassword(x)));
  items.push(el("div", { class: "menu-sep", role: "separator" }));
  items.push(item("Remove", "trash", () => ((confirming = x.id), (focusConfirm = true), render(state)), "danger"));
  menu.replaceChildren(...items);
  menu.setAttribute("aria-label", x.name);
  menu.hidden = false;
  const b = button.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const top = b.bottom + 4 + m.height > document.documentElement.clientHeight && b.top - 4 - m.height > 0 ? b.top - 4 - m.height : b.bottom + 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, b.right - m.width)}px`;
  menuOwner = button;
  button.setAttribute("aria-expanded", "true");
  menu.querySelector(".menu-item").focus();
}

function closeMenu(returnFocus = false) {
  const menu = $("menu");
  if (menu.hidden) return;
  menu.hidden = true;
  if (menuOwner) {
    menuOwner.setAttribute("aria-expanded", "false");
    if (returnFocus && menuOwner.isConnected) menuOwner.focus();
  }
  menuOwner = null;
}

$("menu").addEventListener("keydown", (e) => {
  const items = [...$("menu").querySelectorAll(".menu-item")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
  else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
  else if (e.key === "Home") items[0].focus();
  else if (e.key === "End") items[items.length - 1].focus();
  else if (e.key === "Escape" || e.key === "Tab") closeMenu(true);
  else return;
  e.preventDefault();
});
document.addEventListener("mousedown", (e) => {
  if (!$("menu").hidden && !$("menu").contains(e.target) && !e.target.closest(".more")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && confirming) {
    confirming = null;
    render(state);
  }
});

// ---------------------------------------------------------------- edit

function startEdit(x, prefill) {
  closeMenu();
  editing = x || {};
  const v = { name: "", url: "", client: "", language: "", user: "", sso: false, ...(prefill || {}), ...(x || {}) };
  $("edit-title").textContent = x ? `Edit ${x.name}` : "Add a system";
  $("f-name").value = v.name;
  $("f-url").value = v.url;
  $("f-url").removeAttribute("aria-invalid");
  $("f-client").value = v.client;
  $("f-language").value = v.language;
  $("f-user").value = v.user;
  $("f-sso").checked = !!v.sso;
  const pw = $("f-password");
  pw.value = "";
  pw.type = "password";
  pw.placeholder = x && x.passwordIn ? "Saved. Type a new one to replace it" : "";
  setIcon($("f-show"), "eye");
  $("f-show").setAttribute("aria-label", "Show password");
  $("f-show").setAttribute("aria-pressed", "false");
  $("edit-error").hidden = true;
  updateCredFields();
  $("list-view").hidden = true;
  $("edit-view").hidden = false;
  (v.name ? (v.sso ? $("save") : $("f-user")) : $("f-name")).focus();
}

function stopEdit() {
  const id = editing && editing.id;
  editing = null;
  $("f-password").value = "";
  $("edit-view").hidden = true;
  $("list-view").hidden = false;
  if (state) render(state);
  const row = id && $("systems").querySelector(`.sys[data-id="${id}"] .more`);
  if (row) row.focus();
}

function updateCredFields() {
  $("cred-fields").hidden = $("f-sso").checked;
  const h = state && state.helper;
  $("pw-where").textContent =
    h && h.keychain
      ? `Saved in your keychain: ${h.keychain}.`
      : h && h.ok
        ? "Saved in this Chrome profile: the helper found no keychain on this computer."
        : "Saved in this Chrome profile. To use your keychain, run npx -y sap-gui-mcp-server extension install.";
}

$("f-sso").addEventListener("change", updateCredFields);
$("f-show").addEventListener("click", () => {
  const p = $("f-password");
  const show = p.type === "password";
  p.type = show ? "text" : "password";
  setIcon($("f-show"), show ? "eyeOff" : "eye");
  $("f-show").setAttribute("aria-label", show ? "Hide password" : "Show password");
  $("f-show").setAttribute("aria-pressed", String(show));
});
$("cancel").addEventListener("click", stopEdit);
$("edit-view").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    stopEdit();
  }
});
$("add").addEventListener("click", () => startEdit(null));
$("add-current").addEventListener("click", addFromCurrent);
$("empty-add").addEventListener("click", addFromCurrent);
$("empty-manual").addEventListener("click", () => startEdit(null));

$("edit-view").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("edit-error");
  err.hidden = true;
  if (!$("f-name").value.trim()) {
    err.textContent = "Give the system a name, such as ECC dev.";
    err.hidden = false;
    $("f-name").focus();
    return;
  }
  let pattern;
  try {
    const u = new URL($("f-url").value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    pattern = `${u.protocol}//${u.hostname}/*`;
    $("f-url").removeAttribute("aria-invalid");
  } catch {
    err.textContent = "Type the full address, such as https://sap.example.com/sap/bc/ui2/flp.";
    err.hidden = false;
    $("f-url").setAttribute("aria-invalid", "true");
    $("f-url").focus();
    return;
  }
  const system = {
    id: editing && editing.id,
    name: $("f-name").value,
    url: $("f-url").value,
    client: $("f-client").value,
    language: $("f-language").value,
    user: $("f-user").value,
    sso: $("f-sso").checked,
  };
  const password = system.sso ? "" : $("f-password").value;
  // Asked in the click itself, so Chrome sees the user's gesture.
  chrome.permissions
    .request({ origins: [pattern] })
    .then((granted) => {
      if (!granted) throw new Error("Chrome did not allow the extension on this site, so it cannot open or share it.");
      return send({ cmd: "saveSystem", system, password });
    })
    .then(() => stopEdit())
    .catch((x) => {
      err.textContent = x.message;
      err.hidden = false;
    })
    .finally(refresh);
});

// ---------------------------------------------------------------- footer

function renderFooter(s) {
  setIcon($("pause-icon"), s.paused ? "play" : "pause");
  $("pause-text").textContent = s.paused ? "Resume sharing" : "Pause sharing";
  const portInput = $("port");
  if (document.activeElement !== portInput) portInput.value = s.portSetting.value ?? "";
  portInput.disabled = s.portSetting.managed;
  $("managed").hidden = !s.managedOrigins.length;
  $("managed").textContent = `Sites set by your organization: ${s.managedOrigins.join(", ")}`;
  $("version").textContent = `Version ${s.version}${s.status === "connected" ? ` · port ${s.port}` : ""}${s.portSetting.managed ? " · port set by your organization" : ""}${s.helper.ok ? " · helper installed" : ""}`;
}

$("pause").addEventListener("click", async () => {
  await send({ cmd: state && state.paused ? "resume" : "pause" });
  refresh();
});
$("settings-toggle").addEventListener("click", () => {
  const open = $("settings").hidden;
  $("settings").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
});
$("pair").addEventListener("click", pairNow);
$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = normalizeCode($("code").value);
  const hint = $("pair-hint");
  if (n.length !== CODE_LENGTH) {
    hint.className = "hint error";
    hint.textContent = `A pairing code has ${CODE_LENGTH} letters and digits; this one has ${n.length}.`;
    return;
  }
  try {
    await send({ cmd: "setCode", code: n });
    $("code").value = "";
    hint.className = "hint";
    hint.textContent = "Saved.";
  } catch (err) {
    hint.className = "hint error";
    hint.textContent = err.message;
  }
  refresh();
});
$("port-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("port").value.trim();
  try {
    await send({ cmd: "setPort", port: v === "" ? null : Number(v) });
  } catch (err) {
    $("version").textContent = err.message;
  }
  refresh();
});
$("reconnect").addEventListener("click", async () => {
  await send({ cmd: "reconnect" });
  setTimeout(refresh, 300);
});

// The automation note: once dismissed, it stays away in this profile.
const NOTICE_KEY = "automationNoticeDismissed";
$("automation-close").addEventListener("click", () => {
  $("automation").hidden = true;
  chrome.storage.local.set({ [NOTICE_KEY]: true });
});

// ---------------------------------------------------------------- loop

function render(s) {
  state = s;
  renderStatus(s);
  // While the menu is open the rows stay as they are, so it keeps its anchor.
  if (!editing && $("menu").hidden) renderSystems(s);
  renderFooter(s);
}

async function refresh() {
  try {
    render(await send({ cmd: "state", tabId: activeTabId }));
  } catch (e) {
    $("status").className = "status bad";
    $("status-title").textContent = "Something went wrong";
    $("status-detail").textContent = e.message;
  }
}

if (navigator.webdriver) {
  const stored = await chrome.storage.local.get(NOTICE_KEY).catch(() => ({}));
  $("automation").hidden = !!stored[NOTICE_KEY];
}
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
activeTabId = tab ? tab.id : null;
send({ cmd: "wake" }).catch(() => {});
await refresh();
setInterval(refresh, 1000);
