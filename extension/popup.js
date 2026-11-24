import { normalizeCode, CODE_LENGTH } from "./code.js";
import { ICONS } from "./icons.js";

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let state = null;
let editing = null; // the system being edited ({} for a new one), or null
let confirming = null; // id of the system whose removal (or forgotten password) is being confirmed
let confirmAction = "remove";
let focusConfirm = false;
const notes = new Map(); // system id -> { text, type } after an action
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
const busyDots = () => el("span", { class: "busy", "aria-hidden": "true" }, el("i"), el("i"), el("i"));
for (const node of document.querySelectorAll("[data-icon]")) setIcon(node, node.dataset.icon);

// A system's avatar: its initials in one of Horizon's accent colours, by its place in the list,
// so neighbours never share one.
const ACCENTS = [6, 7, 8, 9, 1];
const accentAt = (i) => `accent-${ACCENTS[i % ACCENTS.length]}`;
function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((words[0] || "?")[0] + (words[1] ? words[1][0] : "")).toUpperCase();
}
const KIND = { webgui: "Web GUI", fiori: "Fiori launchpad", other: "SAP" };
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
/** "Web GUI, Client 800, Language EN": what a system is, in one line, labelled. */
function factsOf(x) {
  return [KIND[x.kind] || "SAP", x.client && `Client ${x.client}`, x.language && `Language ${x.language}`].filter(Boolean).join(", ");
}
/** "User JDOE, password in your keychain": how the extension logs on. */
function logonOf(x) {
  if (x.sso) return { icon: "sso", text: "Single sign-on" };
  const who = x.user ? `User ${x.user}, ` : "";
  if (x.passwordIn === "keychain") return { icon: "key", text: `${who}password in your keychain` };
  if (x.passwordIn === "profile") return { icon: "key", text: `${who}password in this Chrome profile` };
  return { icon: "person", text: `${who}you type the password` };
}

// ---------------------------------------------------------------- status

const BADGE = {
  connected: { type: "success", icon: "connected", text: "Connected" },
  ready: { type: "information", icon: "information", text: "Ready" },
  paused: { type: "warning", icon: "pause", text: "Paused" },
  unpaired: { type: "warning", icon: "warning", text: "Not Paired" },
  wrong: { type: "error", icon: "error", text: "Code Mismatch" },
  busy: { type: "warning", icon: "warning", text: "Busy" },
  blocked: { type: "error", icon: "error", text: "Blocked" },
};
const STRIP_ICON = { information: "information", success: "success", warning: "warning", error: "error" };

function renderStatus(s) {
  const actions = $("strip-actions");
  actions.replaceChildren();
  const notPaired = s.status === "no_code" || s.status === "bad_managed_code";
  const loggingOn = s.systems.find((x) => x.loggingOn);
  let badge = "ready";
  let type = "information";
  let title;
  let detail = "";
  if (s.paused) {
    badge = "paused";
    type = "warning";
    title = "Sharing is paused.";
    detail = "Your agent can't see or open any SAP tab until you click Resume Sharing below.";
  } else if (s.status === "wrong_code") {
    badge = "wrong";
    type = "error";
    title = "This extension and your agent don't match.";
    detail = "Click Pair Again to connect them.";
    if (!s.code.managed) actions.append(el("button", { class: "btn", type: "button", onclick: pairNow }, "Pair Again"));
  } else if (s.status === "busy") {
    badge = "busy";
    type = "warning";
    title = "Another agent app is already connected.";
    detail = "Your agent talks to one Chrome at a time. Close the other app (or Chrome profile), then click Reconnect.";
    actions.append(el("button", { class: "btn", type: "button", onclick: () => send({ cmd: "reconnect" }).then(() => setTimeout(refresh, 300)) }, "Reconnect"));
  } else if (s.status === "untrusted" || s.status === "tampered") {
    badge = "blocked";
    type = "error";
    title = "Connection refused.";
    detail = s.status === "untrusted" ? `The program on port ${s.port} did not prove it is your agent. Nothing was shared.` : `A message on port ${s.port} did not come from your agent. The connection was closed.`;
  } else if (loggingOn) {
    badge = s.status === "connected" ? "connected" : "ready";
    title = `Logging on to ${loggingOn.name}…`;
    detail = "The extension fills in SAP's logon page. Your agent sees the tab only once you're logged on.";
    type = "information";
  } else if (s.status === "connected") {
    badge = "connected";
    type = "success";
    title = "Your agent is connected.";
    detail = s.agent ? `Working in ${s.agent.system || `“${s.agent.title || "an SAP tab"}”`}.` : s.systems.length ? "It opens your systems when it needs them." : "Add an SAP system below so it can work in it.";
  } else if (notPaired) {
    badge = "unpaired";
    type = "warning";
    title = "Not connected to an agent yet.";
    detail = s.status === "bad_managed_code" ? "The pairing code set by your organization is invalid. Ask your IT department." : "";
  } else if (s.systems.length) {
    title = "Ready for your agent.";
    detail = "Ask it to work in one of your systems.";
  } else {
    title = "Add your SAP system to start.";
    detail = "Then ask your agent to work in it.";
  }
  const b = BADGE[badge];
  $("pill").className = `status-badge ${b.type}`;
  setIcon($("pill-icon"), b.icon);
  $("pill-text").textContent = b.text;
  $("strip").className = `strip ${type}`;
  setIcon($("strip-icon"), STRIP_ICON[type]);
  $("strip-title").textContent = title;
  $("strip-detail").textContent = detail;

  // Pairing replaces the strip while there is nothing to connect to.
  // Not paired, or paired with another code: the pairing card, with its code field for users without the helper.
  const pairing = (notPaired || s.status === "wrong_code") && !s.code.managed && !s.paused;
  $("pairing").hidden = !pairing;
  // The strip says what is not said elsewhere: not over the form, and not "Ready" (the badge says it).
  const quiet = type === "information" && !loggingOn;
  $("strip").hidden = pairing || !!editing || quiet;
  if (pairing) {
    $("pair-text").textContent = s.helper.ok ? "One click: the extension reads the pairing code from this computer." : "Install the helper first. In a terminal, run:";
    $("pair-cmd").hidden = s.helper.ok;
    $("pair").textContent = s.helper.ok ? "Pair with This Computer" : "I Ran It, Pair Now";
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

// What SAP answered last, as the row says it, and the one action that helps.
const ISSUE = {
  wrong_password: { type: "error", text: "SAP refused the saved password.", action: "password" },
  user_locked: { type: "error", text: "SAP says the user is locked. Once it's unlocked, log on again." },
  password_change: { type: "warning", text: "SAP asks for a new password. Change it in the tab, then save it here.", action: "password" },
  multiple_logon: { type: "warning", text: "SAP asks whether to end your other logons. Answer in the tab." },
  identity_provider: { type: "warning", text: "Sign in on your organization's sign-in page in the tab." },
  page_changed: { type: "warning", text: "The logon page looks different from SAP's. Log on in the tab." },
  timeout: { type: "warning", text: "SAP didn't answer within a minute. Check your VPN or the address." },
  sap_error: { type: "error", text: "SAP answered with an error page." },
  refused: { type: "error", text: "SAP didn't log you on." },
};

function issueOf(x) {
  const i = x.logonIssue && ISSUE[x.logonIssue.reason];
  if (!i) return null;
  const sap = x.logonIssue.message && ["user_locked", "refused", "sap_error"].includes(x.logonIssue.reason) ? ` SAP says: “${x.logonIssue.message}”` : "";
  return { ...i, text: i.text + sap };
}

/** The row's one button: Show Tab when open, Log On with a saved password, else Open. After SAP refused
 *  the saved password, Open (the user logs on in the tab): the extension does not try it again. */
function primaryOf(x) {
  const issue = issueOf(x);
  const logsOn = x.passwordIn && !x.sso;
  if (x.open && !x.loggingOn && !opening.has(x.id)) return { label: "Show Tab", run: () => openSystem(x) };
  // SAP refused the saved password: Open shows SAP's logon page for the user to type in; the link updates it.
  if (issue && issue.action === "password") return { label: "Open", run: () => chrome.tabs.create({ url: x.url }) };
  return { label: logsOn ? "Log On" : "Open", run: () => openSystem(x) };
}

function systemRow(x, i) {
  if (confirming === x.id) {
    const forget = confirmAction === "forget";
    return el(
      "li",
      { class: "item confirming", "data-id": x.id },
      el(
        "div",
        { class: "item-body" },
        el("div", { class: "item-title" }, forget ? `Forget the password of ${x.name}?` : `Remove ${x.name}?`),
        el("div", { class: "item-line" }, forget ? "It is deleted from your keychain; you type it at the next logon." : x.passwordIn ? "Its saved password is deleted too." : "You can add it again later."),
      ),
      el(
        "div",
        { class: "item-actions" },
        el("button", { class: "btn negative", type: "button", "data-autofocus": true, onclick: () => (forget ? ((confirming = null), forgetPassword(x)) : removeSystem(x)) }, forget ? "Forget" : "Remove"),
        el("button", { class: "btn transparent", type: "button", onclick: () => cancelRemove(x) }, "Cancel"),
      ),
    );
  }
  const busy = opening.has(x.id) || x.loggingOn;
  const note = notes.get(x.id);
  const issue = busy ? null : issueOf(x);
  const logon = logonOf(x);
  const primary = primaryOf(x);
  const shown = busy ? { text: x.passwordIn && !x.sso ? "Logging on…" : "Opening…", type: "information" } : note || issue;
  return el(
    "li",
    { class: "item", "data-id": x.id },
    el("span", { class: `avatar ${accentAt(i)}`, "aria-hidden": "true" }, initials(x.name)),
    el("div", { class: "item-title" }, el("span", {}, x.name)),
    el(
      "div",
      { class: "item-actions" },
      // Busy: aria-disabled, not disabled, so that the focus stays on the button.
      el("button", { class: "btn go", type: "button", "aria-disabled": busy ? "true" : null, title: x.url, onclick: () => !busy && primary.run() }, primary.label),
      el("button", {
        class: "icon-btn more",
        type: "button",
        icon: "overflow",
        title: "More",
        "aria-label": `More for ${x.name}`,
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        onclick: (e) => openMenu(e.currentTarget, x),
        onkeydown: (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu(e.currentTarget, x, e.key === "ArrowUp");
          }
        },
      }),
    ),
    el(
      "div",
      { class: "item-body" },
      el("div", { class: "item-line host", title: x.url }, hostOf(x.url)),
      el("div", { class: "item-line" }, factsOf(x)),
      el("div", { class: "item-line" }, icon(logon.icon), logon.text),
      shown
        ? el(
            "div",
            { class: `item-note ${shown.type}` },
            busy ? busyDots() : icon(STRIP_ICON[shown.type] || "information"),
            el("span", {}, shown.text, shown.action === "password" ? el("button", { class: "link", type: "button", onclick: () => startEdit(x, null, "password") }, "Update Password") : null),
          )
        : null,
    ),
  );
}

function currentSuggestion(s) {
  const t = s.currentTab;
  return t && !t.system && t.suggestion && t.suggestion.sapLike ? t.suggestion : null;
}

function suggestionLine(sug) {
  return [KIND[sug.kind] || "SAP", hostOf(sug.url), sug.client && `Client ${sug.client}`].filter(Boolean).join(", ");
}

let rowsDrawn = "";

function renderSystems(s) {
  // The rows are drawn again only when what they show changed: a click never lands on a row being replaced.
  const drawn = JSON.stringify([s.systems, [...notes], [...opening], confirming]);
  if (drawn !== rowsDrawn) {
    rowsDrawn = drawn;
    const focused = document.activeElement && document.activeElement.closest(".item");
    const focusKey = focused ? [focused.dataset.id, [...focused.querySelectorAll("button")].indexOf(document.activeElement)] : null;
    $("systems").replaceChildren(...s.systems.map((x, i) => systemRow(x, i)));
    if (focusKey) $("systems").querySelector(`.item[data-id="${focusKey[0]}"]`)?.querySelectorAll("button")[focusKey[1]]?.focus();
  }
  if (focusConfirm) $("systems").querySelector("[data-autofocus]")?.focus();
  focusConfirm = false;

  const has = s.systems.length > 0;
  const sug = currentSuggestion(s);
  $("list-head").hidden = !has;
  $("count").textContent = has ? `(${s.systems.length})` : "";
  $("empty").hidden = has;
  $("add-current").hidden = !(has && sug);
  if (sug) $("add-current-detail").textContent = suggestionLine(sug);

  if (!has) {
    const add = $("empty-add");
    // One emphasized button per view: pairing has it while it shows.
    add.className = `btn ${$("pairing").hidden ? "emphasized" : ""}`;
    $("empty-where").hidden = !sug;
    if (sug) {
      $("empty-text").textContent = "This tab is an SAP system. Add it, and your agent can open it and log on.";
      $("empty-where").textContent = suggestionLine(sug);
      add.textContent = "Add This SAP Page";
      $("empty-manual").hidden = false;
    } else {
      $("empty-text").textContent = "Open your SAP system in a tab (the Web GUI or the Fiori launchpad), then add it here.";
      add.textContent = "Add System";
      $("empty-manual").hidden = true;
    }
  }
}

function addFromCurrent() {
  const sug = state && currentSuggestion(state);
  if (sug) startEdit(null, { name: sug.name, url: sug.url, client: sug.client, language: sug.language });
  else startEdit(null);
}

// One live region for what an action did: row notes are drawn again, and would be announced unreliably.
function announce(text) {
  $("announcer").textContent = "";
  setTimeout(() => ($("announcer").textContent = text), 50);
}

function flash(id, note, ms) {
  notes.set(id, note);
  announce(note.text);
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
    const text = { logged_on: `Logged on${x.user ? ` as ${x.user}` : ""}.`, already: "Switched to its tab.", sso: "Opened.", needs_user: "Log on in the tab." }[r.state] || "Opened.";
    flash(x.id, { text, type: r.state === "needs_user" ? "information" : "success" }, 4000);
  } else if (!r.reason || !ISSUE[r.reason]) flash(x.id, { text: r.error, type: "error" }, 15000);
  refresh();
}

async function removeSystem(x) {
  confirming = null;
  const ids = state.systems.map((y) => y.id);
  const next = ids[ids.indexOf(x.id) + 1] || ids[ids.indexOf(x.id) - 1];
  await send({ cmd: "deleteSystem", id: x.id }).catch((e) => showListError(e.message));
  await refresh();
  ($("systems").querySelector(`.item[data-id="${next}"] .more`) || [$("add"), $("empty-add"), $("empty-manual")].find((b) => b.offsetParent)).focus();
}

function cancelRemove(x) {
  confirming = null;
  render(state);
  $("systems").querySelector(`.item[data-id="${x.id}"] .more`)?.focus();
}

async function forgetPassword(x) {
  const system = { id: x.id, name: x.name, url: x.url, client: x.client, language: x.language, user: x.user, sso: x.sso };
  const r = await send({ cmd: "saveSystem", system, password: "", clearPassword: true }).catch((e) => ({ ok: false, error: e.message }));
  if (r && r.ok === false) showListError(r.error);
  else flash(x.id, { text: "Password forgotten.", type: "success" }, 4000);
  await refresh();
  $("systems").querySelector(`.item[data-id="${x.id}"] .more`)?.focus();
}

function showListError(text) {
  $("list-error-text").textContent = text;
  $("list-error").hidden = false;
  setTimeout(() => ($("list-error").hidden = true), 10000);
}

// ---------------------------------------------------------------- the overflow menu

let menuOwner = null;

function openMenu(button, x, fromEnd = false) {
  if (menuOwner === button) return closeMenu();
  closeMenu();
  const menu = $("menu");
  const item = (label, iconName, onpick, cls = "") =>
    // A pick that opens something (the form, the confirmation) moves the focus itself; the others give it back.
    el("button", { class: `menu-item ${cls}`, type: "button", role: "menuitem", tabindex: "-1", onclick: () => (closeMenu(!/^(Edit|Remove)$/.test(label)), onpick()) }, icon(iconName), label);
  const items = [item("Edit", "edit", () => startEdit(x))];
  if (x.passwordIn && !x.sso) items.push(item("Open Without Logging On", "open", () => chrome.tabs.create({ url: x.url })));
  if (x.passwordIn) items.push(item("Forget Password", "key", () => ((confirming = x.id), (confirmAction = "forget"), (focusConfirm = true), render(state))));
  items.push(el("div", { class: "menu-sep", role: "separator" }));
  items.push(item("Remove", "delete", () => ((confirming = x.id), (confirmAction = "remove"), (focusConfirm = true), render(state)), "negative"));
  menu.replaceChildren(...items);
  if (!button.id) button.id = `more-${x.id}`;
  menu.setAttribute("aria-labelledby", button.id);
  menu.hidden = false;
  const b = button.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const top = b.bottom + 4 + m.height > document.documentElement.clientHeight && b.top - 4 - m.height > 0 ? b.top - 4 - m.height : b.bottom + 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, b.right - m.width)}px`;
  menuOwner = button;
  button.setAttribute("aria-expanded", "true");
  const all = menu.querySelectorAll(".menu-item");
  all[fromEnd ? all.length - 1 : 0].focus();
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
  else if (e.key === "Escape") closeMenu(true);
  else if (e.key === "Tab") return closeMenu(true); // Tab goes on from the More button
  else return;
  e.preventDefault();
});
document.addEventListener("mousedown", (e) => {
  if (!$("menu").hidden && !$("menu").contains(e.target) && !e.target.closest(".more")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && confirming) {
    const x = state.systems.find((y) => y.id === confirming);
    if (x) cancelRemove(x);
  }
});

// ---------------------------------------------------------------- edit

function startEdit(x, prefill, focus) {
  closeMenu();
  editing = x || {};
  const v = { name: "", url: "", client: "", language: "", user: "", sso: false, ...(prefill || {}), ...(x || {}) };
  $("edit-title").textContent = x ? `Edit ${x.name}` : "Add System";
  $("f-name").value = v.name;
  $("f-url").value = v.url;
  $("f-url").removeAttribute("aria-invalid");
  $("f-client").value = v.client;
  $("f-language").value = v.language;
  $("f-user").value = (v.user || "").toUpperCase();
  $("f-sso").checked = !!v.sso;
  const pw = $("f-password");
  pw.value = "";
  pw.type = "password";
  pw.placeholder = x && x.passwordIn ? "Saved; type a new one to replace it" : "";
  setIcon($("f-show"), "show");
  $("f-show").setAttribute("aria-label", "Show Password");
  $("f-show").setAttribute("aria-pressed", "false");
  $("edit-error").hidden = true;
  for (const f of ["f-name", "f-url"]) {
    $(f).removeAttribute("aria-invalid");
    $(`${f}-error`).hidden = true;
  }
  updateCredFields();
  $("list-view").hidden = true;
  $("edit-view").hidden = false;
  // The form's own buttons take the bottom: no Pause Sharing or Settings under them.
  document.querySelector(".footer").hidden = true;
  $("settings").hidden = true;
  $("settings-toggle").setAttribute("aria-expanded", "false");
  if (state) renderStatus(state);
  (focus === "password" ? pw : v.name ? (v.sso ? $("save") : $("f-user")) : $("f-name")).focus();
}

function stopEdit(savedId) {
  const id = (editing && editing.id) || savedId;
  const isNew = !(editing && editing.id) && !!savedId;
  editing = null;
  rowsDrawn = "";
  $("f-password").value = "";
  $("edit-view").hidden = true;
  $("list-view").hidden = false;
  document.querySelector(".footer").hidden = false;
  if (state) render(state);
  // Back on the row: its More button after an edit, its main button for a new system.
  const row = id && $("systems").querySelector(`.item[data-id="${id}"] ${isNew ? ".go" : ".more"}`);
  if (row) row.focus();
  else [$("add"), $("empty-add")].find((b) => b.offsetParent)?.focus();
}

const KEYCHAIN_NAME = { "macOS Keychain": "your Mac's keychain", "Windows (DPAPI)": "your Windows account's protected storage" };

function updateCredFields() {
  $("cred-fields").hidden = $("f-sso").checked;
  const h = state && state.helper;
  // Passwords go only to the keychain: without it the field is off, and says why.
  const can = !!(h && h.ok && h.keychain);
  $("f-password").disabled = !can;
  $("f-show").disabled = !can;
  $("pw-where").textContent = can
    ? `Saved in ${KEYCHAIN_NAME[h.keychain] || "your keychain"}, never in Chrome.`
    : h && h.ok
      ? "This computer has no keychain the helper can use, so no password is saved. You log on in the tab."
      : "To save a password, install the helper: run npx -y sap-ui-automation extension helper, then restart Chrome. Without it, you log on in the tab.";
  updateHttpWarning();
}

function updateHttpWarning() {
  let http = false;
  try {
    http = new URL($("f-url").value.trim()).protocol === "http:";
  } catch {}
  const warn = http && !$("f-sso").checked;
  $("f-url-http").hidden = !warn;
  $("f-url-hint").hidden = warn;
  $("f-url").classList.toggle("warning", warn);
}

$("f-sso").addEventListener("change", updateCredFields);
$("f-url").addEventListener("input", updateHttpWarning);
for (const f of ["f-name", "f-url"]) {
  $(f).addEventListener("input", () => {
    $(f).removeAttribute("aria-invalid");
    $(`${f}-error`).hidden = true;
  });
}
// SAP's users are upper case: shown as they will be saved.
$("f-user").addEventListener("input", () => {
  const e = $("f-user");
  const at = e.selectionStart;
  e.value = e.value.toUpperCase();
  e.setSelectionRange(at, at);
});
$("f-show").addEventListener("click", () => {
  const p = $("f-password");
  const show = p.type === "password";
  p.type = show ? "text" : "password";
  setIcon($("f-show"), show ? "hide" : "show");
  $("f-show").setAttribute("aria-label", show ? "Hide Password" : "Show Password");
  $("f-show").setAttribute("aria-pressed", String(show));
});
$("cancel").addEventListener("click", () => stopEdit());
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
  // A field's own error under it (Fiori's value state); anything else above the buttons.
  const fail = (text, field) => {
    if (field) {
      field.setAttribute("aria-invalid", "true");
      $(`${field.id}-error`).textContent = text;
      $(`${field.id}-error`).hidden = false;
      field.focus();
    } else {
      $("edit-error-text").textContent = text;
      err.hidden = false;
    }
  };
  err.hidden = true;
  for (const f of ["f-name", "f-url"]) {
    $(f).removeAttribute("aria-invalid");
    $(`${f}-error`).hidden = true;
  }
  if (!$("f-name").value.trim()) return fail("Give the system a name, such as ECC Dev.", $("f-name"));
  let pattern;
  try {
    const u = new URL($("f-url").value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    pattern = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return fail("Enter the full address, such as https://sap.example.com/sap/bc/ui2/flp.", $("f-url"));
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
    .then(async (r) => {
      await refresh();
      stopEdit(r && r.id);
    })
    .catch((x) => fail(x.message))
    .finally(refresh);
});

// ---------------------------------------------------------------- footer

function renderFooter(s) {
  setIcon($("pause-icon"), s.paused ? "play" : "pause");
  // While paused, Resume Sharing is the one action that matters: the view's emphasized button.
  $("pause").className = `btn ${s.paused ? "emphasized" : "transparent"}`;
  $("pause-text").textContent = s.paused ? "Resume Sharing" : "Pause Sharing";
  const portInput = $("port");
  if (document.activeElement !== portInput) portInput.value = s.portSetting.value ?? "";
  portInput.disabled = s.portSetting.managed;
  $("managed").hidden = !s.managedOrigins.length;
  $("managed").textContent = `Sites set by your organization: ${s.managedOrigins.join(", ")}`;
  const about = [
    ["Extension Version", s.version],
    ["Port", s.status === "connected" ? `${s.port}${s.portSetting.managed ? " (set by your organization)" : ""}` : s.portSetting.managed ? "Set by your organization" : "Found by itself"],
    ["Helper", s.helper.ok ? (s.helper.keychain ? `Installed, passwords in ${KEYCHAIN_NAME[s.helper.keychain] || "your keychain"}` : "Installed, no keychain found") : "Not installed"],
  ];
  $("about").replaceChildren(...about.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

$("pause").addEventListener("click", async () => {
  await send({ cmd: state && state.paused ? "resume" : "pause" });
  refresh();
});
$("settings-toggle").addEventListener("click", () => {
  const open = $("settings").hidden;
  $("settings").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("settings").scrollIntoView({ block: "nearest" });
});
addEventListener("scroll", () => closeMenu(), { passive: true });
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
    showListError(err.message);
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
    $("strip").className = "strip error";
    $("strip").hidden = false;
    setIcon($("strip-icon"), "error");
    $("strip-title").textContent = "The extension stopped answering.";
    $("strip-detail").textContent = `Close and reopen this popup. If it keeps happening, click the reload arrow on the extension's card in chrome://extensions. (${e.message})`;
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
