import { normalizeCode, CODE_LENGTH } from "./code.js";

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let state = null;
let editing = null; // the system being edited ({} for a new one), or null
const notes = new Map(); // system id -> { text, cls } after Open
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
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

const PALETTE = ["#0a6ed1", "#188a42", "#8e44ad", "#c0392b", "#d35400", "#16a085", "#2c3e50", "#b8860b"];
function colorOf(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((words[0] || "?")[0] + (words[1] ? words[1][0] : "")).toUpperCase();
}
const KIND = { webgui: "Web GUI", fiori: "Fiori", other: "SAP" };
function hostOf(u) {
  try {
    const url = new URL(u);
    return url.host;
  } catch {
    return u;
  }
}

// ---------------------------------------------------------------- status

function renderStatus(s) {
  const pill = $("pill");
  const card = $("status");
  const actions = $("status-actions");
  actions.replaceChildren();
  let pillText = "Ready";
  let cls = "";
  let title = "Ready";
  let detail = "Your agent connects when it needs SAP.";
  const notPaired = s.status === "no_code" || s.status === "bad_managed_code";
  if (s.paused) {
    pillText = "Paused";
    cls = "warn";
    title = "Sharing paused";
    detail = "Your agent sees no tab until you resume.";
    actions.append(el("button", { class: "primary", type: "button", onclick: () => send({ cmd: "resume" }).then(refresh) }, "Resume sharing"));
  } else if (s.status === "connected") {
    pillText = "Connected";
    cls = "ok";
    title = "Connected to your agent";
    detail = s.agent ? `Working in “${s.agent.title || "a SAP tab"}”` : s.shared.length ? `It sees ${s.shared.length} tab${s.shared.length > 1 ? "s" : ""} of your systems.` : "It sees the tabs of your systems once you open them.";
  } else if (notPaired) {
    pillText = "Not paired";
    cls = "warn";
    title = "Not connected to an agent yet";
    detail = s.status === "bad_managed_code" ? "The pairing code set by your organization is invalid. Ask your IT department." : "Pair once, below.";
  } else if (s.status === "wrong_code") {
    pillText = "Pairing";
    cls = "bad";
    title = "The agent uses another pairing code";
    detail = "Pair again with this computer.";
    if (!s.code.managed) actions.append(el("button", { class: "primary", type: "button", onclick: pairNow }, "Pair again"));
  } else if (s.status === "busy") {
    pillText = "Busy";
    cls = "bad";
    title = "Your agent is connected to another browser";
    detail = "Close the other Chrome or profile, then click Reconnect.";
    actions.append(el("button", { type: "button", onclick: () => send({ cmd: "reconnect" }).then(() => setTimeout(refresh, 300)) }, "Reconnect"));
  } else if (s.status === "untrusted" || s.status === "tampered") {
    pillText = "Blocked";
    cls = "bad";
    title = "Connection refused";
    detail = s.status === "untrusted" ? `The program on port ${s.port} did not prove it is your agent; nothing was shared.` : `A message on port ${s.port} did not come from your agent; the connection was closed.`;
  }
  pill.className = `pill ${cls}`;
  $("pill-text").textContent = pillText;
  card.className = `card status ${cls}`;
  $("status-title").textContent = title;
  $("status-detail").textContent = detail;

  // Pairing card.
  $("pairing").hidden = !notPaired || s.code.managed;
  if (!$("pairing").hidden) {
    $("pair-text").textContent = s.helper.ok ? "One click: the extension reads the pairing code from this computer." : "Install the helper first. In a terminal, run:";
    if (!s.helper.ok && !$("pair-text").nextElementSibling?.classList.contains("cmd")) $("pair-text").after(el("p", { class: "cmd" }, el("code", {}, "npx -y sap-gui-mcp-server extension install")));
    if (s.helper.ok) $("pairing").querySelector(".cmd")?.remove();
    $("pair").textContent = s.helper.ok ? "Pair with this computer" : "I ran it: pair now";
  }
}

async function pairNow() {
  const hint = $("pair-hint");
  hint.className = "muted small";
  hint.textContent = "Pairing…";
  const r = await send({ cmd: "pair" }).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) hint.textContent = "Paired.";
  else {
    hint.className = "error small";
    hint.textContent = r.error === "helper_missing" ? "The helper is not installed (or Chrome must be restarted after installing it). Run the command above, or pair with a code." : r.error;
    if (r.error === "helper_missing") $("pair-manual").open = true;
  }
  refresh();
}

// ---------------------------------------------------------------- systems

function systemMeta(x) {
  return `${KIND[x.kind] || "SAP"} · ${hostOf(x.url)}`;
}

function systemWho(x) {
  const parts = [];
  if (x.client) parts.push(`client ${x.client}`);
  if (x.sso) parts.push("single sign-on");
  else if (x.user) parts.push(x.user + (x.passwordIn ? " 🔑" : ""));
  return parts.join(" · ");
}

function logonNote(x) {
  if (x.sso) return "single sign-on";
  if (x.passwordIn === "keychain") return "password in keychain";
  if (x.passwordIn === "profile") return "password in this Chrome profile";
  return x.user ? "no password saved" : "";
}

function renderSystems(s) {
  const list = $("systems");
  list.replaceChildren();
  for (const x of s.systems) {
    const note = notes.get(x.id);
    const busy = opening.has(x.id) || x.loggingOn;
    const row = el(
      "li",
      { class: "sys" },
      el("div", { class: "badge", style: `background:${colorOf(x.name)}` }, initials(x.name)),
      el(
        "div",
        { class: "body" },
        el("div", { class: "name" }, x.name, x.open ? el("span", { class: "dot", title: "open in a tab" }) : null),
        el("div", { class: "meta", title: x.url }, systemMeta(x)),
        systemWho(x) ? el("div", { class: "meta", title: logonNote(x) }, systemWho(x)) : null,
        note ? el("div", { class: `note ${note.cls}` }, note.text) : null,
      ),
      el("button", { class: "open", type: "button", disabled: busy, title: x.sso || !x.passwordIn ? "Open in a tab" : "Open and log on", onclick: () => openSystem(x) }, busy ? "Opening…" : "Open"),
      el("button", { class: "more", type: "button", title: "Edit", onclick: () => startEdit(x) }, "⋯"),
    );
    list.append(row);
  }
  $("empty").hidden = s.systems.length > 0;

  // "Add the SAP page I'm on"
  const t = s.currentTab;
  const sug = t && !t.system && t.suggestion && t.suggestion.sapLike ? t.suggestion : null;
  $("add-current").hidden = !sug;
  if (sug) $("add-current-detail").textContent = `${KIND[sug.kind]} · ${hostOf(sug.url)}${sug.client ? ` · client ${sug.client}` : ""}`;
}

async function openSystem(x) {
  opening.add(x.id);
  notes.set(x.id, { text: x.sso || !x.passwordIn ? "Opening…" : "Logging on…", cls: "" });
  render(state);
  const r = await send({ cmd: "openSystem", id: x.id }).catch((e) => ({ ok: false, error: e.message }));
  opening.delete(x.id);
  if (r.ok) {
    const text = { logged_on: `Logged on${x.user ? ` as ${x.user}` : ""}`, already: "Already open", sso: "Opened", needs_user: "Log on in the tab" }[r.state] || "Opened";
    notes.set(x.id, { text, cls: r.state === "needs_user" ? "" : "ok" });
  } else notes.set(x.id, { text: r.error, cls: "bad" });
  setTimeout(() => {
    notes.delete(x.id);
    if (state) render(state);
  }, r.ok ? 4000 : 15000);
  refresh();
}

// ---------------------------------------------------------------- edit

function startEdit(x, prefill) {
  editing = x || {};
  const v = { name: "", url: "", client: "", language: "", user: "", sso: false, ...(prefill || {}), ...(x || {}) };
  $("edit-title").textContent = x ? `Edit ${x.name}` : "Add a system";
  $("f-name").value = v.name;
  $("f-url").value = v.url;
  $("f-client").value = v.client;
  $("f-language").value = v.language;
  $("f-user").value = v.user;
  $("f-sso").checked = !!v.sso;
  $("f-password").value = "";
  $("f-password").type = "password";
  $("f-password").placeholder = x && x.passwordIn ? "saved — type to replace" : "optional";
  $("f-clear-pw").checked = false;
  $("clear-pw-row").hidden = !(x && x.passwordIn);
  $("delete").hidden = !x;
  $("edit-error").hidden = true;
  updateCredFields();
  $("list-view").hidden = true;
  $("edit-view").hidden = false;
  (v.name ? $("f-user") : $("f-name")).focus();
}

function stopEdit() {
  editing = null;
  $("f-password").value = "";
  $("edit-view").hidden = true;
  $("list-view").hidden = false;
  if (state) render(state);
}

function updateCredFields() {
  const sso = $("f-sso").checked;
  $("cred-fields").hidden = sso;
  const h = state && state.helper;
  $("pw-where").textContent =
    h && h.keychain
      ? `Kept in your keychain (${h.keychain}).`
      : h && h.ok
        ? "Kept in this Chrome profile: the helper found no keychain on this computer."
        : "Kept in this Chrome profile. For the keychain, run npx -y sap-gui-mcp-server extension install.";
}

$("f-sso").addEventListener("change", updateCredFields);
$("f-show").addEventListener("click", () => {
  const p = $("f-password");
  p.type = p.type === "password" ? "text" : "password";
  $("f-show").textContent = p.type === "password" ? "Show" : "Hide";
});
$("cancel").addEventListener("click", stopEdit);
$("add").addEventListener("click", () => startEdit(null));
$("add-current").addEventListener("click", () => {
  const sug = state && state.currentTab && state.currentTab.suggestion;
  if (sug) startEdit(null, { name: sug.name, url: sug.url, client: sug.client, language: sug.language });
});

$("edit-view").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("edit-error");
  err.hidden = true;
  let pattern;
  try {
    const u = new URL($("f-url").value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    pattern = `${u.protocol}//${u.hostname}/*`;
  } catch {
    err.textContent = "The address must be a full URL, such as https://sap.example.com/sap/bc/ui2/flp.";
    err.hidden = false;
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
  const clearPassword = $("f-clear-pw").checked;
  // Asked in the click itself, so Chrome sees the user's gesture.
  chrome.permissions
    .request({ origins: [pattern] })
    .then((granted) => {
      if (!granted) throw new Error("Chrome did not allow the extension on this site, so it cannot open or share it.");
      return send({ cmd: "saveSystem", system, password, clearPassword });
    })
    .then(() => stopEdit())
    .catch((x) => {
      err.textContent = x.message;
      err.hidden = false;
    })
    .finally(refresh);
});

$("delete").addEventListener("click", async () => {
  if (!editing || !editing.id) return;
  if (!confirm(`Delete ${editing.name}? Its saved password is deleted too.`)) return;
  await send({ cmd: "deleteSystem", id: editing.id });
  stopEdit();
  refresh();
});

// ---------------------------------------------------------------- footer

function renderFooter(s) {
  $("pause").textContent = s.paused ? "Resume sharing" : "Pause sharing";
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
$("pair").addEventListener("click", pairNow);
$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = normalizeCode($("code").value);
  const hint = $("pair-hint");
  if (n.length !== CODE_LENGTH) {
    hint.className = "error small";
    hint.textContent = `A pairing code has ${CODE_LENGTH} letters and digits; this one has ${n.length}.`;
    return;
  }
  try {
    await send({ cmd: "setCode", code: n });
    $("code").value = "";
    hint.className = "muted small";
    hint.textContent = "Saved.";
  } catch (err) {
    hint.className = "error small";
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

// ---------------------------------------------------------------- loop

function render(s) {
  state = s;
  renderStatus(s);
  if (!editing) renderSystems(s);
  renderFooter(s);
}

async function refresh() {
  try {
    render(await send({ cmd: "state", tabId: activeTabId }));
  } catch (e) {
    $("status-title").textContent = "Error";
    $("status-detail").textContent = e.message;
  }
}

$("automation").hidden = !navigator.webdriver;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
activeTabId = tab ? tab.id : null;
send({ cmd: "wake" }).catch(() => {});
await refresh();
setInterval(refresh, 1000);
