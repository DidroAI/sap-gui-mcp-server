import { normalizeCode, CODE_LENGTH } from "./code.js";

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let state = null;
let editingCode = false;

const STATUS = {
  starting: ["Starting…", ""],
  searching: ["Looking for server…", ""],
  connected: ["Connected", "ok"],
  disconnected: ["Not connected", "warn"],
  not_found: ["Not connected", "warn"],
  no_code: ["Not paired", "warn"],
  bad_managed_code: ["Not paired", "bad"],
  wrong_code: ["Wrong code", "bad"],
  busy: ["Server busy", "bad"],
  untrusted: ["Not the server", "bad"],
  tampered: ["Connection broken", "bad"],
};

const DETAIL = {
  connected: (s) => [`Paired: connected to sap-gui-mcp-server on port ${s.port}.`, "ok"],
  disconnected: () => ["Connection lost; retrying.", "warn"],
  not_found: () => ["Not connected. Is sap-gui-mcp-server running?", "warn"],
  no_code: () => ["Run sap-gui-mcp-server extension pair and paste the code.", ""],
  bad_managed_code: () => ["The pairing code set by your organization is invalid. Ask your IT department.", "bad"],
  wrong_code: () => ["The server refused this code. Paste the code that sap-gui-mcp-server extension pair prints.", "bad"],
  busy: () => ["The server is already connected to another browser or profile.", "bad"],
  untrusted: (s) => [`The program on port ${s.port} did not prove it holds the code; nothing was shared.`, "bad"],
  tampered: (s) => [`A message on port ${s.port} did not come from the paired server; the connection was closed and nothing more was done.`, "bad"],
  searching: () => ["Looking for sap-gui-mcp-server on 127.0.0.1…", ""],
};

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (r && r.error) throw new Error(r.error);
    return r;
  });
}

function patternLabel(p) {
  if (p === "<all_urls>") return "all sites";
  const m = /^(\*|https?):\/\/([^/]+)\//.exec(p);
  if (!m) return p;
  const scheme = m[1] === "*" ? "" : m[1] + "://";
  return scheme + m[2];
}

function li(...children) {
  const el = document.createElement("li");
  el.append(...children);
  return el;
}

function span(text, cls) {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}

function render(s) {
  state = s;
  const [label, cls] = STATUS[s.status] || [s.status, ""];
  const pill = $("status");
  pill.textContent = s.paused && s.status === "connected" ? "Paused" : label;
  pill.className = "pill " + (s.paused ? "warn" : cls);

  // Pairing
  const pm = $("pair-managed");
  pm.hidden = !s.code.managed;
  pm.textContent = s.code.managedInvalid
    ? `Pairing code set by your organization but invalid (a code has ${CODE_LENGTH} letters and digits). Ask your IT department.`
    : "Pairing code set by your organization.";
  pm.className = "note" + (s.code.managedInvalid ? " bad" : "");
  $("pair-form").hidden = s.code.managed;
  const hint = $("pair-hint");
  const d = DETAIL[s.status];
  if (d) {
    const [text, c] = d(s);
    hint.textContent = text;
    hint.className = "note " + c;
  }
  if (!editingCode) $("code").placeholder = s.code.set ? "Code saved. Paste a new one to replace it" : "ABCDE-FGHJK-MNPQR-STVWX-YZ012-3";

  // This tab
  const t = s.currentTab;
  const sec = $("this-tab");
  if (t && t.web) {
    sec.hidden = false;
    $("tab-origin").textContent = t.origin;
    const st = $("tab-state");
    if (t.allowed) {
      st.textContent = "shared";
      st.className = "tag ok";
    } else if (t.matches) {
      st.textContent = "allowed, paused";
      st.className = "tag";
    } else {
      st.textContent = "not allowed";
      st.className = "tag";
    }
    $("allow").hidden = t.matches;
  } else sec.hidden = true;

  // Allowed sites
  const list = $("origins");
  list.replaceChildren();
  const managed = new Set(s.origins.managed || []);
  for (const p of s.origins.managed || []) list.append(li(span(patternLabel(p), "origin"), span("set by your organization", "tag")));
  for (const p of s.origins.granted || []) {
    if (managed.has(p)) continue;
    const x = document.createElement("button");
    x.className = "x";
    x.title = "Stop sharing this site";
    x.textContent = "×";
    x.addEventListener("click", () => send({ cmd: "removeSite", pattern: p }).then(refresh, refresh));
    list.append(li(span(patternLabel(p), "origin"), x));
  }
  $("no-origins").hidden = list.children.length > 0;
  $("wildcard-note").hidden = !s.origins.wildcard;

  // Shared tabs
  const shared = $("shared");
  shared.replaceChildren();
  for (const tab of s.shared) shared.append(li(span(tab.title || tab.url || `tab ${tab.tabId}`, "title")));
  $("no-shared").hidden = s.shared.length > 0;
  $("pause").textContent = s.paused ? "Resume sharing" : "Pause sharing";
  $("paused-note").hidden = !s.paused;

  const portInput = $("port");
  if (document.activeElement !== portInput) portInput.value = s.portSetting.value ?? "";
  portInput.disabled = s.portSetting.managed;
  $("version").textContent = `Version ${s.version}` + (s.portSetting.managed ? " · port set by your organization" : "");
}

async function refresh() {
  try {
    render(await send({ cmd: "state", tabId: activeTabId }));
  } catch (e) {
    $("status").textContent = "Error";
    $("pair-hint").textContent = e.message;
  }
}

$("code").addEventListener("focus", () => (editingCode = true));
$("code").addEventListener("blur", () => (editingCode = false));
$("code").addEventListener("input", (e) => {
  const n = normalizeCode(e.target.value);
  const hint = $("pair-hint");
  if (n.length && n.length !== CODE_LENGTH) {
    hint.textContent = `${n.length} of ${CODE_LENGTH} characters`;
    hint.className = "note";
  }
});

$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("code");
  const n = normalizeCode(input.value);
  if (n.length !== CODE_LENGTH) {
    $("pair-hint").textContent = `A pairing code has ${CODE_LENGTH} letters and digits; this one has ${n.length}.`;
    $("pair-hint").className = "note bad";
    return;
  }
  try {
    await send({ cmd: "setCode", code: n });
  } catch (err) {
    $("pair-hint").textContent = err.message;
    $("pair-hint").className = "note bad";
    return;
  }
  input.value = "";
  input.blur();
  refresh();
});

$("allow").addEventListener("click", () => {
  const t = state && state.currentTab;
  if (!t || !t.origin) return;
  const u = new URL(t.origin);
  // Host-wide (any port): SAP systems often sit on 443xx/80xx ports.
  // Called synchronously in the click so Chrome sees the user gesture.
  // If Chrome already allows every site, the request adds no pattern: the
  // worker keeps the site in its own list ("addSite"), and only listed sites count.
  const pattern = `${u.protocol}//${u.hostname}/*`;
  chrome.permissions
    .request({ origins: [pattern] })
    .then((granted) => (granted ? send({ cmd: "addSite", pattern }) : null))
    .then(refresh, refresh);
});

$("pause").addEventListener("click", async () => {
  await send({ cmd: state && state.paused ? "resume" : "pause" });
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

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
activeTabId = tab ? tab.id : null;
send({ cmd: "wake" }).catch(() => {});
await refresh();
setInterval(refresh, 1000);
