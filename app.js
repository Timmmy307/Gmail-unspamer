
/*
  Gmail AI Triage (iPad Web App)
  - Auth: Google Identity Services "token model"
  - Gmail API: list + get metadata + trash
  - Groq: chat completions with JSON response_format

  Notes:
  - This app sends ONLY headers + snippet to Groq (not full bodies).
  - Access token stays in-memory (not saved), settings are saved to localStorage.

  Docs:
  - GIS token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model
  - Gmail users.messages.trash: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash
*/

const $ = (sel) => document.querySelector(sel);

const LS_KEY = "gmail_ai_triage_settings_v1";
const LS_LAST = "gmail_ai_triage_lastscan_v1";

let tokenClient = null;
let accessToken = null;

const DEFAULTS = {
  googleClientId: "",
  groqKey: "",
  groqModel: "llama-3.1-8b-instant",
  batchSize: 10,
  maxMessages: 50,
  query: "from:notifications@github.com OR category:promotions OR category:social"
};

function setStatus(text) {
  $("#status").textContent = text || "";
}

function setAuthState(text) {
  $("#authState").textContent = text || "";
}

function esc(s) {
  return (s || "").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function normalizeSender(fromHeader) {
  const m = (fromHeader || "").match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return (fromHeader || "").trim().toLowerCase() || "(unknown)";
}

function loadSettings() {
  const raw = localStorage.getItem(LS_KEY);
  const s = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  $("#googleClientId").value = s.googleClientId || "";
  $("#groqKey").value = s.groqKey || "";
  $("#groqModel").value = s.groqModel || DEFAULTS.groqModel;
  $("#batchSize").value = s.batchSize ?? DEFAULTS.batchSize;
  $("#maxMessages").value = s.maxMessages ?? DEFAULTS.maxMessages;
  $("#query").value = s.query ?? DEFAULTS.query;
}

function saveSettings() {
  const s = {
    googleClientId: $("#googleClientId").value.trim(),
    groqKey: $("#groqKey").value.trim(),
    groqModel: $("#groqModel").value,
    batchSize: Number($("#batchSize").value || 10),
    maxMessages: Number($("#maxMessages").value || 50),
    query: $("#query").value.trim()
  };
  localStorage.setItem(LS_KEY, JSON.stringify(s));
  setStatus("Saved ✅");
  return s;
}

function getSettings() {
  const raw = localStorage.getItem(LS_KEY);
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
}

function ensureTokenClient() {
  const s = getSettings();
  if (!s.googleClientId) {
    throw new Error("Missing Google Client ID. Paste it first, then Save.");
  }
  if (!window.google?.accounts?.oauth2) {
    throw new Error("Google Identity library not loaded yet. Try again in 2 seconds.");
  }
  if (!tokenClient || tokenClient._cid !== s.googleClientId) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: s.googleClientId,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      callback: (resp) => {
        if (resp?.access_token) {
          accessToken = resp.access_token;
          setAuthState("Connected ✅");
          setStatus("Gmail connected. You can scan now.");
        } else {
          setAuthState("Not connected");
          setStatus("No access token returned.");
        }
      }
    });
    tokenClient._cid = s.googleClientId;
  }
  return tokenClient;
}

async function gmailFetch(path, options = {}) {
  if (!accessToken) throw new Error("Not connected to Gmail yet. Tap Connect Gmail first.");
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${txt}`);
  }
  return await res.json();
}

async function listMessageIds(query, maxResults) {
  const params = new URLSearchParams();
  params.set("maxResults", String(maxResults));
  if (query && query.trim()) params.set("q", query.trim());
  const data = await gmailFetch(`messages?${params.toString()}`, { method: "GET" });
  return (data.messages || []).map(m => m.id);
}

function headerValue(msg, name) {
  const headers = msg?.payload?.headers || [];
  const h = headers.find(x => (x.name || "").toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

async function getMessageMeta(id) {
  const params = new URLSearchParams();
  params.set("format", "metadata");
  ["From", "To", "Subject", "Date"].forEach(h => params.append("metadataHeaders", h));
  const msg = await gmailFetch(`messages/${id}?${params.toString()}`, { method: "GET" });
  const from = headerValue(msg, "From");
  return {
    id,
    from,
    to: headerValue(msg, "To"),
    subject: headerValue(msg, "Subject"),
    date: headerValue(msg, "Date"),
    snippet: msg.snippet || "",
    sender: normalizeSender(from)
  };
}

async function groqClassifyBatch(settings, emails) {
  if (!settings.groqKey) throw new Error("Missing Groq API key.");
  const system = [
    "You are an email triage assistant.",
    "You will be given a JSON array of email metadata objects.",
    "For each email decide an action: keep, trash, or review.",
    "Rules:",
    "- Prefer KEEP for receipts, invoices, banking, account/security alerts, 2FA, school/work, shipping updates, and anything that looks important.",
    "- Prefer TRASH for obvious promos, spam, random repo noise, low-value newsletters, and stuff the user can safely ignore.",
    "- Use REVIEW if uncertain.",
    "Return ONLY valid JSON with this shape:",
    "{ \"decisions\": [ {\"id\": \"...\", \"action\": \"keep|trash|review\", \"category\": \"receipt|security|work|school|github|newsletter|promo|spam|other\", \"summary\": \"short\", \"reason\": \"short\" } ] }"
  ].join("\n");

  const body = {
    model: settings.groqModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ emails: emails.map(e => ({
          id: e.id, from: e.from, to: e.to, subject: e.subject, date: e.date, snippet: e.snippet
        })) })}
    ]
  };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.groqKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq API error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const byId = new Map(decisions.map(d => [d.id, d]));

  return emails.map(e => ({ ...e, decision: byId.get(e.id) || { id: e.id, action: "review", category: "other", summary: "", reason: "No decision." } }));
}

async function scan() {
  const settings = saveSettings();
  setStatus("Scanning…\n(1) listing messages\n(2) reading headers/snippets\n(3) calling Groq…");
  $("#results").innerHTML = "";
  $("#summary").textContent = "";

  const ids = await listMessageIds(settings.query, settings.maxMessages);
  const metas = [];
  for (const id of ids) metas.push(await getMessageMeta(id));

  const batchSize = Math.max(1, settings.batchSize || 10);
  const labeled = [];
  for (let i = 0; i < metas.length; i += batchSize) {
    const out = await groqClassifyBatch(settings, metas.slice(i, i + batchSize));
    labeled.push(...out);
    setStatus(`Scanning…\nProcessed ${Math.min(i + batchSize, metas.length)} / ${metas.length}`);
  }

  const grouped = {};
  for (const e of labeled) {
    const key = e.sender || "(unknown)";
    if (!grouped[key]) grouped[key] = { sender: key, fromHeaderSample: e.from || "", emails: [] };
    grouped[key].emails.push(e);
  }

  const state = {
    generatedAt: new Date().toISOString(),
    query: settings.query,
    total: labeled.length,
    grouped
  };

  localStorage.setItem(LS_LAST, JSON.stringify(state));
  render(state);
  setStatus(`Done ✅\nScanned: ${state.total}\nQuery: ${state.query}\nTime: ${state.generatedAt}`);
}

async function trashMessage(id) {
  await gmailFetch(`messages/${id}/trash`, { method: "POST" });
}

function pillClass(action) {
  const a = (action || "review").toLowerCase();
  return a === "keep" ? "keep" : a === "trash" ? "trash" : "review";
}

function render(state) {
  const grouped = state.grouped || {};
  const senders = Object.keys(grouped).sort((a,b) => (grouped[b].emails?.length||0) - (grouped[a].emails?.length||0));

  const root = document.createElement("div");
  let totalKeep = 0, totalTrash = 0, totalReview = 0;

  for (const sender of senders) {
    const group = grouped[sender];
    const emails = group.emails || [];

    const keepCount = emails.filter(e => (e.decision?.action||"").toLowerCase() === "keep").length;
    const trashCount = emails.filter(e => (e.decision?.action||"").toLowerCase() === "trash").length;
    const reviewCount = emails.length - keepCount - trashCount;

    totalKeep += keepCount; totalTrash += trashCount; totalReview += reviewCount;

    const sec = document.createElement("div");
    sec.className = "sender";

    sec.innerHTML = `
      <div class="senderHead">
        <div>
          <div class="senderTitle">${esc(sender)}</div>
          <div class="senderMeta">${esc(group.fromHeaderSample || "")}</div>
          <div class="senderMeta">Total: ${emails.length} • Keep: ${keepCount} • Trash: ${trashCount} • Review: ${reviewCount}</div>
        </div>
        <div class="actions">
          <button class="ghost" data-action="toggle">Toggle</button>
          <button class="danger" data-action="trashSuggested">Trash suggested</button>
        </div>
      </div>
      <div class="emailList"></div>
    `;

    const list = sec.querySelector(".emailList");
    let collapsed = emails.length > 12;
    list.style.display = collapsed ? "none" : "block";

    sec.querySelector('[data-action="toggle"]').addEventListener("click", () => {
      collapsed = !collapsed;
      list.style.display = collapsed ? "none" : "block";
    });

    sec.querySelector('[data-action="trashSuggested"]').addEventListener("click", async () => {
      const ids = emails.filter(e => (e.decision?.action || "").toLowerCase() === "trash" && !e._trashed).map(e => e.id);
      if (!ids.length) return alert("No TRASH suggestions here.");
      if (!confirm(`Trash ${ids.length} emails from ${sender}? (Moves to Trash)`)) return;

      setStatus(`Trashing ${ids.length} emails…`);
      let ok = 0;
      for (const id of ids) {
        try { await trashMessage(id); ok++; } catch (e) { console.error(e); }
      }
      for (const e of emails) if (ids.includes(e.id)) e._trashed = true;
      localStorage.setItem(LS_LAST, JSON.stringify(state));
      render(state);
      setStatus(`Trashed ${ok}/${ids.length} emails.`);
    });

    for (const e of emails) {
      const action = (e.decision?.action || "review").toLowerCase();
      const cat = e.decision?.category || "other";
      const summary = e.decision?.summary || "";
      const reason = e.decision?.reason || "";

      const row = document.createElement("div");
      row.className = "email";
      row.innerHTML = `
        <div class="subject">${esc(e.subject || "(no subject)")}</div>
        <div class="snip">${esc(summary || e.snippet || "")}</div>
        <div class="tags">
          <span class="pill ${pillClass(action)}">${esc(action.toUpperCase())}</span>
          <span class="pill">${esc(cat)}</span>
          ${e.date ? `<span class="pill">${esc(e.date)}</span>` : ""}
          ${reason ? `<span class="pill">why: ${esc(reason)}</span>` : ""}
          ${e._trashed ? `<span class="pill trash">TRASHED</span>` : ""}
        </div>
        <div class="actions">
          <button class="ok" data-act="keep">✔ Keep</button>
          <button class="danger" data-act="trash">🗑 Trash</button>
        </div>
      `;

      row.querySelector('[data-act="keep"]').addEventListener("click", () => {
        e.decision = { ...(e.decision||{}), action: "keep", reason: "Manually kept." };
        localStorage.setItem(LS_LAST, JSON.stringify(state));
        render(state);
      });

      row.querySelector('[data-act="trash"]').addEventListener("click", async () => {
        if (!confirm("Move this email to Trash?")) return;
        setStatus("Trashing 1 email…");
        await trashMessage(e.id);
        e._trashed = true;
        localStorage.setItem(LS_LAST, JSON.stringify(state));
        render(state);
        setStatus("Trashed ✅");
      });

      list.appendChild(row);
    }

    root.appendChild(sec);
  }

  $("#results").innerHTML = "";
  $("#results").appendChild(root);
  $("#summary").textContent = `Scanned ${state.total}. Keep: ${totalKeep} • Trash: ${totalTrash} • Review: ${totalReview}`;
}

function loadLast() {
  const raw = localStorage.getItem(LS_LAST);
  if (!raw) {
    setStatus("No last scan saved yet.");
    return;
  }
  const state = JSON.parse(raw);
  render(state);
  setStatus(`Loaded last scan ✅\nScanned: ${state.total}\nQuery: ${state.query}\nTime: ${state.generatedAt}`);
}

function disconnect() {
  accessToken = null;
  setAuthState("Not connected");
  setStatus("Disconnected.");
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  $("#btnSave").addEventListener("click", saveSettings);

  $("#btnConnect").addEventListener("click", () => {
    try {
      saveSettings();
      ensureTokenClient().requestAccessToken({ prompt: "consent" });
      setStatus("Opening Google consent…");
    } catch (e) {
      setStatus(String(e.message || e));
    }
  });

  $("#btnDisconnect").addEventListener("click", disconnect);

  $("#btnScan").addEventListener("click", async () => {
    try {
      await scan();
    } catch (e) {
      setStatus(String(e.message || e));
    }
  });

  $("#btnLoadLast").addEventListener("click", loadLast);

  document.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => $("#query").value = btn.dataset.q || "");
  });

  setAuthState(accessToken ? "Connected ✅" : "Not connected");
});
