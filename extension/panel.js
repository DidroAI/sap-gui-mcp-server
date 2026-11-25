import { normalizeCode, CODE_LENGTH } from "./code.js";
import { ICONS } from "./icons.js";

const $ = (id) => document.getElementById(id);
// The one add/edit form: moved under the row it edits, or under the list for a new system.
const form = document.getElementById("edit-template").content.firstElementChild.cloneNode(true);
form.hidden = true;
document.getElementById("systems-body").append(form);
let activeTabId = null;
let state = null;
let editing = null; // the system being edited ({} for a new one), or null
let settingsOpen = false;
let formClosed = false; // the user closed the first-system form: the add box stands in for it
let formTouched = false; // the user typed in the form: a new tab's address no longer refills it
const collapsed = { systems: false, activity: false };
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
for (const node of document.querySelectorAll("[data-icon]")) setIcon(node, node.dataset.icon);

const KIND = { webgui: "Web GUI", fiori: "Fiori", other: "SAP" };
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
// The helper's keychain, as people call it: macOS, Windows (DPAPI, this Windows user only), Linux (Secret Service).
const KEYCHAIN_NAME = { "macOS Keychain": "your macOS keychain", "Windows (DPAPI)": "Windows' protected storage", "Secret Service (secret-tool)": "your system keyring" };
function keychainName(s) {
  const h = s && s.helper;
  return (h && h.keychain && KEYCHAIN_NAME[h.keychain]) || "your keychain";
}
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

// ---------------------------------------------------------------- views

function view(s) {
  if (settingsOpen) return "settings";
  if (needsPairing(s)) return "pair";
  return "main";
}
const needsPairing = (s) => !!s && !s.code.managed && (s.status === "no_code" || s.status === "wrong_code");

function showView(name) {
  for (const v of ["main", "pair", "settings"]) $(`${v}-view`).hidden = v !== name;
  $("settings-open").hidden = name === "settings";
}

// Sections fold; the choice is kept for this panel's life.
const SECTION = { systems: "systems-section", activity: "activity" };
let activityAll = false;
for (const k of Object.keys(SECTION)) {
  $(`${k}-toggle`).addEventListener("click", () => {
    collapsed[k] = !collapsed[k];
    $(`${k}-toggle`).setAttribute("aria-expanded", String(!collapsed[k]));
    $(SECTION[k]).classList.toggle("folded", collapsed[k]);
  });
}

$("settings-open").addEventListener("click", () => {
  closeMenu();
  settingsOpen = true;
  if (state) render(state);
  $("back").focus();
});
$("back").addEventListener("click", () => {
  settingsOpen = false;
  if (state) render(state);
  $("settings-open").focus();
});

// ---------------------------------------------------------------- status

const RECENT_MS = 60 * 1000;
const WAIT_MS = 6 * 60 * 1000;

function agentOf(s) {
  return (s.agentInfo && s.agentInfo.agent) || "Your agent";
}
/** Where the agent works, as the user named it: the extension's system for its tab, else SAP's system id. */
function placeOf(s, e) {
  return (s.agent && s.agent.system) || (e && e.system) || "SAP";
}
const WRITE_LINE = {
  confirm: (a) => `Saves wait for your yes in ${a}.`,
  off: () => "Saves are off: the agent only reads and fills in.",
  on: () => "Saves run without asking.",
};

function setStatus({ dot = "", title, detail = "", step = null, tone = "", shimmer = false, help = false, actions = [] }) {
  $("status").className = `status ${tone}`;
  const d = $("status-dot");
  d.className = `dot ${dot}`;
  d.replaceChildren();
  if (dot === "spin") setIcon(d, "spinner");
  $("status-title").textContent = title;
  $("status-title").classList.toggle("shimmer", shimmer);
  $("status-detail").textContent = detail;
  $("status-detail").hidden = !detail;
  const st = $("status-step");
  st.hidden = !step;
  st.replaceChildren(...(step || []));
  $("help").hidden = !help;
  $("status-actions").replaceChildren(...actions);
}

function renderStatus(s) {
  if (!s.systems.length && !s.paused && !["busy", "untrusted", "tampered", "bad_managed_code"].includes(s.status)) {
    const sug = currentSuggestion(s);
    return setStatus({
      dot: "none",
      title: "Add your first SAP system",
      detail: sug ? "This tab is an SAP system: its address is filled in below." : "Open it in a Chrome tab to fill in its address, or type it below.",
    });
  }
  const loggingOn = s.systems.find((x) => x.loggingOn);
  const last = s.activity && s.activity[s.activity.length - 1];
  const agent = agentOf(s);
  const write = s.agentInfo && s.agentInfo.policy && WRITE_LINE[s.agentInfo.policy.write];
  const connected = s.status === "connected";
  if (s.paused) {
    return setStatus({
      dot: "danger",
      tone: "danger",
      title: "Sharing stopped",
      detail: "You clicked Cancel on Chrome's debugging bar, so your agent sees no SAP tab.",
      actions: [el("button", { class: "btn primary", type: "button", onclick: () => send({ cmd: "resume" }).then(refresh) }, "Share again")],
    });
  }
  if (s.status === "busy") {
    return setStatus({
      dot: "accent",
      tone: "accent",
      title: "Another agent app is connected",
      detail: "Your agent talks to one Chrome at a time. Close the other app or Chrome profile, then reconnect.",
      actions: [el("button", { class: "btn", type: "button", onclick: () => send({ cmd: "reconnect" }).then(() => setTimeout(refresh, 300)) }, "Reconnect")],
    });
  }
  if (s.status === "untrusted" || s.status === "tampered") {
    return setStatus({
      dot: "danger",
      tone: "danger",
      title: "Connection refused",
      detail: s.status === "untrusted" ? `The program on port ${s.port} did not prove it is your agent. Nothing was shared.` : `A message on port ${s.port} did not come from your agent. The connection was closed.`,
    });
  }
  if (s.status === "bad_managed_code") {
    return setStatus({ dot: "danger", tone: "danger", title: "Pairing set by your organization is invalid", detail: "Ask your IT department." });
  }
  if (loggingOn) {
    return setStatus({ dot: "spin", title: `Logging on to ${loggingOn.name}`, detail: "The extension fills in SAP's logon page. Your agent sees the tab once you're logged on." });
  }
  if (connected && last && last.state === "waiting" && Date.now() - last.at < WAIT_MS) {
    const what = last.do === "key" ? objectText(last) : [verbOf({ ...last, state: "ran" }), objectText(last)].filter(Boolean).join(" ");
    return setStatus({
      dot: "accent pulse",
      tone: "accent",
      title: `${agent} wants to save in ${placeOf(s, last)}`,
      detail: `Answer in ${agent}. Nothing is saved until you say yes.`,
      step: [last.transaction ? el("code", {}, last.transaction) : null, last.transaction ? "  " : null, what].filter(Boolean),
    });
  }
  if (connected && last && Date.now() - last.at < RECENT_MS) {
    return setStatus({ dot: "accent", title: `${agent} is working in ${placeOf(s, last)}`, shimmer: true, detail: write ? write(agent) : "" });
  }
  if (connected) {
    return setStatus({ dot: "green", title: s.agentInfo && s.agentInfo.agent ? `${agent} is connected` : "Your agent is connected", detail: write ? write(agent) : s.systems.length ? "It opens your systems when it needs them." : "Add an SAP system below so it can work in it." });
  }
  return setStatus({
    title: "Ready. No agent connected.",
    detail: "Ask your agent to do something in SAP. It connects by itself.",
    help: true,
  });
}

// ---------------------------------------------------------------- activity

const KEY_NAME = { 0: "Enter", 2: "F2", 3: "Back", 4: "Value help", 8: "Execute", 11: "Save", 12: "Cancel", 15: "Exit" };
function verbOf(e) {
  if (e.state === "waiting") return "Save";
  switch (e.do) {
    case "set":
      return "Entered";
    case "press":
    case "click":
      return "Pressed";
    case "key":
      return "Key";
    case "okcode":
      return /^\/[no]/i.test(e.value) ? "Opened" : "Command";
    case "open":
      return "Opened";
    case "select":
      return "Selected";
    case "check":
      return "Checked";
    case "combo":
      return "Chose";
    case "f4":
      return "Help on";
    case "scroll":
      return "Scrolled";
    default:
      return e.do ? e.do[0].toUpperCase() + e.do.slice(1) : "Step";
  }
}
function objectText(e) {
  if (e.do === "key") return KEY_NAME[e.value] || `F${e.value}`;
  if (e.do === "okcode") return e.value.replace(/^\/[no]/i, "");
  return [e.label, e.value].filter(Boolean).join(" ");
}
function objectNode(e) {
  if (e.do === "okcode") return el("b", {}, objectText(e));
  if (e.do === "key") return el("span", {}, objectText(e));
  return el("span", {}, e.label || "", e.label && e.value ? " " : "", e.value ? el("b", {}, e.value) : null);
}

/** One step on one line; a click shows where and when. */
function stepRow(e, agent, open) {
  const text =
    e.state === "waiting"
      ? [el("b", {}, "Save"), ` waits for your answer in ${agent}`]
      : e.state === "refused"
        ? [el("b", {}, "Blocked: "), `${verbOf(e)} ${objectText(e)}`]
        : e.state === "declined"
          ? [`Not saved: ${verbOf({ ...e, state: "ran" })} ${objectText(e)}`]
          : [`${verbOf(e)} `, el("b", {}, objectText(e))];
  const id = `${e.at}-${e.do}`;
  const row = el(
    "li",
    { class: `act-row ${e.state}` },
    el(
      "button",
      { class: "act-line", type: "button", "aria-expanded": open ? "true" : "false", onclick: () => toggleStep(id) },
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { class: "act-text" }, e.transaction ? el("span", { class: "tx" }, e.transaction) : null, ...text),
      el("span", { class: "act-time" }, ago(e.at)),
    ),
  );
  if (open) {
    const line = (k, v) => (v ? el("div", {}, el("span", { class: "k" }, k), v) : null);
    row.append(
      el(
        "div",
        { class: "act-more" },
        line("Screen", [e.transaction, e.title].filter(Boolean).join("  ")),
        line("System", [e.system, e.client && `client ${e.client}`].filter(Boolean).join(", ")),
        line("Field", e.label),
        line("Value", e.do === "key" ? objectText(e) : e.value),
        line("Time", new Date(e.at).toLocaleTimeString()),
      ),
    );
  }
  return row;
}

const openSteps = new Set();
function toggleStep(id) {
  if (openSteps.has(id)) openSteps.delete(id);
  else openSteps.add(id);
  activityDrawn = "";
  if (state) renderActivity(state);
}

let activityDrawn = "";
function renderActivity(s) {
  const list = s.activity || [];
  const agent = agentOf(s);
  const key = JSON.stringify([activityAll, list.length, list.length && list[list.length - 1].at, list.length && list[list.length - 1].state, agent, Math.floor(Date.now() / 30000)]);
  if (key === activityDrawn) return;
  activityDrawn = key;
  $("activity").hidden = list.length === 0;
  // The newest first; a few unless the user asked for all.
  const LIMIT = 6;
  const shown = list.slice().reverse().slice(0, activityAll ? list.length : LIMIT);
  $("activity-list").replaceChildren(...shown.map((e) => stepRow(e, agent, openSteps.has(`${e.at}-${e.do}`))));
  const more = $("activity-more");
  more.hidden = list.length <= LIMIT;
  more.textContent = activityAll ? "Show fewer" : `Show all ${list.length} steps`;
}
$("clear-activity").addEventListener("click", () => send({ cmd: "clearActivity" }).then(refresh));
$("activity-more").addEventListener("click", () => {
  activityAll = !activityAll;
  activityDrawn = "";
  if (state) renderActivity(state);
});

// ---------------------------------------------------------------- pairing

function renderPairing(s) {
  const wrong = s.status === "wrong_code";
  $("pair-title").textContent = wrong ? "Pair again" : "Set up in a minute";
  $("pair-intro").textContent = wrong ? "This extension and your agent don't match. Pair them again." : "Your agent works in SAP in this Chrome, in the systems you add.";
  const helper = s.helper.ok;
  $("step-helper").className = `step ${helper ? "done" : "current"}`;
  const num = $("step-helper").querySelector(".num");
  if (helper) setIcon(num, "check");
  else num.replaceChildren();
  $("step-helper").querySelector(".step-title").textContent = helper ? "Helper installed" : "Install the helper";
  $("step-pair").className = `step ${helper ? "current" : "later"}`;
  // Without the helper, pairing with a code is the way: the step opens for it.
  if (!helper) $("step-pair").className = "step current";
  $("pair").hidden = !helper;
}

async function pairNow() {
  const hint = $("pair-hint");
  hint.className = "msg";
  hint.textContent = "Pairing";
  const r = await send({ cmd: "pair" }).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) hint.textContent = "Paired.";
  else {
    hint.className = "msg error";
    hint.textContent =
      r.error === "helper_missing" ? "The helper is not installed, or Chrome needs a restart after installing it. Install it, or pair with a code." : r.error;
    if (r.error === "helper_missing") $("pair-manual").open = true;
  }
  refresh();
}
$("pair").addEventListener("click", pairNow);
$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = normalizeCode($("code").value);
  const hint = $("pair-hint");
  if (n.length !== CODE_LENGTH) {
    hint.className = "msg error";
    hint.textContent = `A pairing code has ${CODE_LENGTH} letters and digits; this one has ${n.length}.`;
    return;
  }
  try {
    await send({ cmd: "setCode", code: n });
    $("code").value = "";
    hint.className = "msg";
    hint.textContent = "Saved.";
  } catch (err) {
    hint.className = "msg error";
    hint.textContent = err.message;
  }
  refresh();
});

// ---------------------------------------------------------------- systems

// What SAP answered last, as the row says it, and the one action that helps.
const ISSUE = {
  wrong_password: { type: "error", text: "SAP rejected the saved password.", action: "password" },
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
  const sap = x.logonIssue.message && ["user_locked", "refused", "sap_error"].includes(x.logonIssue.reason) ? ` SAP says: "${x.logonIssue.message}"` : "";
  return { ...i, text: i.text + sap };
}

/** The row's one button: Go to tab when open, Log on with a saved password, else Open. After SAP rejected
 *  the saved password, Update password (the extension does not try it again). */
function primaryOf(x) {
  const issue = issueOf(x);
  const logsOn = x.passwordIn && !x.sso;
  if (x.open && !x.loggingOn && !opening.has(x.id)) return { label: "Go to tab", run: () => openSystem(x) };
  if (issue && issue.action === "password") return { label: "Update password", run: () => startEdit(x, null, "password") };
  return { label: logsOn ? "Log on" : "Open", run: () => openSystem(x) };
}

/** "Client 800; User IDADMIN": the second line of a row. */
function factsOf(x) {
  return [x.client && `Client ${x.client}`, x.sso ? "Single sign-on" : x.user && `User ${x.user}`].filter(Boolean).join("; ");
}

function systemRow(x, s) {
  if (confirming === x.id) {
    const forget = confirmAction === "forget";
    return el(
      "li",
      { class: "card item confirming", "data-id": x.id },
      el(
        "div",
        { class: "card-head" },
        el(
          "div",
          { class: "card-body" },
          el("div", { class: "card-title item-title" }, el("span", { class: "card-name" }, forget ? `Forget the password of ${x.name}?` : `Remove ${x.name}?`)),
          el("div", { class: "card-line item-line" }, forget ? "You type it at the next logon." : x.passwordIn ? "Its saved password is deleted too." : "You can add it again later."),
          el(
            "div",
            { class: "row-actions" },
            el("button", { class: "btn ghost", type: "button", onclick: () => cancelRemove(x) }, "Cancel"),
            el("button", { class: "btn danger", type: "button", "data-autofocus": true, onclick: () => (forget ? ((confirming = null), forgetPassword(x)) : removeSystem(x)) }, forget ? "Forget" : "Remove"),
          ),
        ),
      ),
    );
  }
  const busy = opening.has(x.id) || x.loggingOn;
  const note = notes.get(x.id);
  const issue = busy ? null : issueOf(x);
  const primary = primaryOf(x);
  const here = s.agent && s.agent.system === x.name && s.status === "connected";
  const shown = busy ? { text: x.passwordIn && !x.sso ? "Logging on" : "Opening", type: "busy" } : note || issue;
  return el(
    "li",
    { class: `card item${here ? " here" : ""}`, "data-id": x.id },
    el(
      "div",
      { class: "card-head" },
      el(
        "div",
        { class: "card-body" },
        el("div", { class: "card-title item-title", title: x.url }, el("span", { class: "card-name" }, x.name), el("span", { class: "tag" }, KIND[x.kind] || "SAP")),
        shown
          ? el("div", { class: `card-note item-note ${shown.type}` }, shown.type === "busy" ? el("span", { class: "spin-icon", icon: "spinner" }) : null, el("span", {}, shown.text))
          : el("div", { class: "card-line" }, here ? el("span", { class: "here-label" }, "Agent here") : null, el("span", { class: "item-line" }, factsOf(x) || hostOf(x.url))),
      ),
      el(
        "div",
        { class: "card-actions" },
        // Busy: aria-disabled, not disabled, so that the focus stays on the button.
        el("button", { class: "btn go", type: "button", "aria-disabled": busy ? "true" : null, title: x.url, onclick: () => !busy && primary.run() }, primary.label),
        el("button", {
          class: "icon-btn more",
          type: "button",
          icon: "more",
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
  // While the form is open the rows stay as they are: it sits among them.
  if (editing) return;
  // The rows are drawn again only when what they show changed: a click never lands on a row being replaced.
  const drawn = JSON.stringify([s.systems, [...notes], [...opening], confirming, s.agent && s.agent.system, s.status]);
  if (drawn !== rowsDrawn) {
    rowsDrawn = drawn;
    const focused = document.activeElement && document.activeElement.closest(".item");
    const focusKey = focused ? [focused.dataset.id, [...focused.querySelectorAll("button")].indexOf(document.activeElement)] : null;
    $("systems").replaceChildren(...s.systems.map((x) => systemRow(x, s)));
    if (focusKey) $("systems").querySelector(`.item[data-id="${focusKey[0]}"]`)?.querySelectorAll("button")[focusKey[1]]?.focus();
  }
  if (focusConfirm) $("systems").querySelector("[data-autofocus]")?.focus();
  focusConfirm = false;

  const has = s.systems.length > 0;
  const sug = currentSuggestion(s);
  // No system yet: the section is only the form; its head would repeat the status.
  $("systems-toggle").hidden = !has;
  $("add-current").hidden = !sug;
  $("add").hidden = !!sug && !has;
  if (sug) $("add-current-detail").textContent = suggestionLine(sug);
  if (!has && !formClosed) startEdit(null, sug ? { name: sug.name, url: sug.url, client: sug.client, language: sug.language } : null, "none", true);
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
    flash(x.id, { text, type: r.state === "needs_user" ? "" : "success" }, 4000);
  } else if (!r.reason || !ISSUE[r.reason]) flash(x.id, { text: r.error, type: "error" }, 15000);
  refresh();
}

async function removeSystem(x) {
  confirming = null;
  const ids = state.systems.map((y) => y.id);
  const next = ids[ids.indexOf(x.id) + 1] || ids[ids.indexOf(x.id) - 1];
  await send({ cmd: "deleteSystem", id: x.id }).catch((e) => showListError(e.message));
  await refresh();
  ($("systems").querySelector(`.item[data-id="${next}"] .more`) || [$("add-current"), $("add"), $("f-name")].find((b) => b.offsetParent))?.focus();
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
  $("list-error").textContent = text;
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
    el("button", { class: `menu-item ${cls}`, type: "button", role: "menuitem", tabindex: "-1", onclick: () => (closeMenu(!/^(Edit|Remove|Forget password)$/.test(label)), onpick()) }, icon(iconName), label);
  const items = [item("Edit", "edit", () => startEdit(x))];
  if (x.passwordIn && !x.sso) items.push(item("Open without logging on", "open", () => chrome.tabs.create({ url: x.url })));
  if (x.passwordIn) items.push(item("Forget password", "key", () => ((confirming = x.id), (confirmAction = "forget"), (focusConfirm = true), render(state))));
  items.push(el("div", { class: "menu-sep", role: "separator" }));
  items.push(item("Remove", "delete", () => ((confirming = x.id), (confirmAction = "remove"), (focusConfirm = true), render(state)), "danger"));
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
  else if (e.key === "Tab") return closeMenu(true);
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
  } else if (e.key === "Escape" && settingsOpen && !editing) {
    settingsOpen = false;
    render(state);
  }
});
document.addEventListener("scroll", () => closeMenu(), { passive: true, capture: true });

// ---------------------------------------------------------------- edit

/** Opens the form under the row of `x`, or under the list for a new system. `first`: the first system's form, open by itself. */
function startEdit(x, prefill, focus, first = false) {
  closeMenu();
  editing = x ? { ...x } : {};
  editing.first = first;
  formTouched = false;
  const v = { name: "", url: "", client: "", language: "", user: "", sso: false, ...(prefill || {}), ...(x || {}) };
  $("f-name").value = v.name;
  $("f-url").value = v.url;
  $("f-client").value = v.client;
  $("f-language").value = v.language;
  $("f-user").value = (v.user || "").toUpperCase();
  $("f-sso").checked = !!v.sso;
  const pw = $("f-password");
  pw.value = "";
  pw.type = "password";
  pw.placeholder = x && x.passwordIn ? "Saved" : "";
  setIcon($("f-show"), "show");
  $("f-show").setAttribute("aria-label", "Show password");
  $("f-show").setAttribute("aria-pressed", "false");
  $("edit-error").hidden = true;
  for (const f of ["f-name", "f-url"]) {
    $(f).removeAttribute("aria-invalid");
    $(`${f}-error`).hidden = true;
  }
  $("save").textContent = x ? "Save" : "Add";
  updateCredFields();
  // Inside its card when editing; in a new card at the end when adding. The add boxes give way to it.
  for (const r of $("systems").querySelectorAll(".editing")) r.classList.remove("editing");
  for (const c of $("systems").querySelectorAll(".new-card")) c.remove();
  const row = x && $("systems").querySelector(`.item[data-id="${x.id}"]`);
  const card = row || el("li", { class: "card new-card" }, first ? null : el("div", { class: "new-title" }, "New system"));
  if (!row) $("systems").append(card);
  card.append(form);
  card.classList.add("editing");
  form.hidden = false;
  $("add").hidden = true;
  $("add-current").hidden = true;
  if (collapsed.systems) $("systems-toggle").click();
  if (focus === "none") return;
  (focus === "password" ? pw : v.name ? (v.sso ? $("save") : $("f-user")) : $("f-name")).focus();
}

function stopEdit(savedId) {
  const id = (editing && editing.id) || savedId;
  const isNew = !(editing && editing.id) && !!savedId;
  if (editing && editing.first && !savedId) formClosed = true;
  editing = null;
  rowsDrawn = "";
  $("f-password").value = "";
  form.hidden = true;
  $("systems-body").append(form);
  for (const c of $("systems").querySelectorAll(".new-card")) c.remove();
  for (const r of $("systems").querySelectorAll(".editing")) r.classList.remove("editing");
  if (state) render(state);
  // Back on the row: its More button after an edit, its main button for a new system.
  const row = id && $("systems").querySelector(`.item[data-id="${id}"] ${isNew ? ".go" : ".more"}`);
  if (row) row.focus();
  else [$("add-current"), $("add")].find((b) => b.offsetParent)?.focus();
}

function updateCredFields() {
  $("cred-fields").hidden = $("f-sso").checked;
  const h = state && state.helper;
  // Passwords go only to the keychain: without it the field is off, and says why.
  const can = !!(h && h.ok && h.keychain);
  $("f-password").disabled = !can;
  $("f-show").disabled = !can;
  $("pw-where").textContent = can
    ? `Saved in ${keychainName(state)}, never in Chrome.`
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
  $("f-url").classList.toggle("warning", warn);
}

$("f-sso").addEventListener("change", updateCredFields);
form.addEventListener("input", () => (formTouched = true));
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
  $("f-show").setAttribute("aria-label", show ? "Hide password" : "Show password");
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

$("edit-view").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("edit-error");
  // A field's own error under it; anything else above the buttons.
  const fail = (text, field) => {
    if (field) {
      field.setAttribute("aria-invalid", "true");
      $(`${field.id}-error`).textContent = text;
      $(`${field.id}-error`).hidden = false;
      field.focus();
    } else {
      err.textContent = text;
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

// ---------------------------------------------------------------- settings

const WRITE_SETTING = { confirm: "ask you first", off: "are off: the agent only reads", on: "run without asking" };
const fact = (...parts) => el("li", {}, ...parts);
const tags = (list) => list.map((t) => el("span", { class: "tag mono" }, t));

function renderSettings(s) {
  const info = s.agentInfo;
  const p = info && info.policy;
  const connected = s.status === "connected";
  $("agent-line").replaceChildren(
    ...(connected ? [el("span", { class: "dot green", "aria-hidden": "true" }), " ", `${(info && info.agent) || "Your agent"} is connected now.`] : ["No agent is connected right now."]),
  );
  // What the agent may do: only once the server said it.
  $("can-block").hidden = !(p && p.write);
  if (p && p.write) {
    $("can").replaceChildren(
      fact("Saves: ", el("b", {}, WRITE_SETTING[p.write])),
      fact("Systems: ", el("b", {}, p.systems.length ? p.systems.join(", ") : "any you open")),
      ...(p.transactions.length ? [fact("Only these transactions: ", ...tags(p.transactions))] : []),
      ...(p.blocked.length ? [fact("Blocked: ", ...tags(p.blocked))] : []),
    );
    $("can-hint").textContent = `Set in ${info.agent || "your agent"}'s settings for this tool.`;
  }
  const kc = s.helper.ok && s.helper.keychain ? KEYCHAIN_NAME[s.helper.keychain] || s.helper.keychain : null;
  $("about").replaceChildren(
    fact(s.code.managed ? "Paired by your organization" : s.code.set ? "Paired with the helper on this computer" : "Not paired"),
    fact(kc ? `Passwords are kept in ${kc}` : s.helper.ok ? "No keychain found: passwords are not saved, you log on in the tab" : "Helper not installed: passwords are not saved"),
    ...(connected ? [fact("Port ", el("b", { class: "mono" }, String(s.port)))] : []),
  );
  const portInput = $("port");
  if (document.activeElement !== portInput) portInput.value = s.portSetting.value ?? "";
  portInput.disabled = s.portSetting.managed;
  $("managed").hidden = !s.managedOrigins.length;
  $("managed").textContent = `Sites set by your organization: ${s.managedOrigins.join(", ")}`;
  $("unpair-row").hidden = s.code.managed || !s.code.set;
  $("version").textContent = `Version ${s.version}. Not affiliated with SAP SE.`;
}

// Copy buttons: the command goes to the clipboard; the button says so for a moment.
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-copy]");
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(
    () => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    },
    () => (b.textContent = "Select and copy"),
  );
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
let unpairArmed = false;
$("unpair").addEventListener("click", async () => {
  // Two clicks: the first asks, the second unpairs.
  if (!unpairArmed) {
    unpairArmed = true;
    $("unpair").textContent = "Click again to unpair";
    setTimeout(() => {
      unpairArmed = false;
      $("unpair").textContent = "Unpair";
    }, 4000);
    return;
  }
  unpairArmed = false;
  $("unpair").textContent = "Unpair";
  await send({ cmd: "unpair" });
  settingsOpen = false;
  refresh();
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
  const v = view(s);
  showView(v);
  if (v === "main") {
    renderStatus(s);
    renderActivity(s);
    // While the menu is open the rows stay as they are, so it keeps its anchor.
    if ($("menu").hidden) renderSystems(s);
    // The first system's form follows the tab in front until the user types in it.
    if (editing && editing.first && !formTouched) {
      const sug = currentSuggestion(s);
      if (sug && $("f-url").value !== sug.url) startEdit(null, { name: sug.name, url: sug.url, client: sug.client, language: sug.language }, "none", true);
    }
  } else if (v === "pair") renderPairing(s);
  else if (v === "settings") renderSettings(s);
}

async function refresh() {
  try {
    render(await send({ cmd: "state", tabId: activeTabId }));
  } catch (e) {
    showView("main");
    setStatus({ dot: "danger", tone: "danger", title: "The extension stopped answering", detail: `Close and reopen this panel. If it keeps happening, click the reload arrow on the extension's card in chrome://extensions. (${e.message})` });
  }
}

// The panel stays open while the user moves between tabs: "Add this SAP page" follows the tab in front.
async function followTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  activeTabId = tab ? tab.id : null;
}
chrome.tabs.onActivated.addListener(() => followTab().then(refresh));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === activeTabId && (change.url || change.status === "complete")) refresh();
});

if (navigator.webdriver) {
  const stored = await chrome.storage.local.get(NOTICE_KEY).catch(() => ({}));
  $("automation").hidden = !!stored[NOTICE_KEY];
}
await followTab();
send({ cmd: "wake" }).catch(() => {});
await refresh();
setInterval(refresh, 1000);
