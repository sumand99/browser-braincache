/**
 * BrainCache — Popup UI Controller
 */

// ─── Elements ───────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const snapshotList = $("#snapshotList");
const saveNowBtn = $("#saveNowBtn");
const exportBtn = $("#exportBtn");
const exportAllWsBtn = $("#exportAllWsBtn");
const importBtn = $("#importBtn");
const importInput = $("#importInput");
const clearAllBtn = $("#clearAllBtn");
const detailOverlay = $("#detailOverlay");
const backBtn = $("#backBtn");
const toast = $("#toast");
const workspaceSelect = $("#workspaceSelect");

const PROFILE_PERSONAL_ID = "profile_personal";
const PROFILE_WORK_ID = "profile_work";
const WORKSPACE_ADD_NEW_VALUE = "__add_new__";

function isBuiltinWorkspace(id) {
  return id === PROFILE_PERSONAL_ID || id === PROFILE_WORK_ID;
}
const trimBtn = $("#trimBtn");
const shortcutsLinkBtn = $("#shortcutsLinkBtn");
const workspaceList = $("#workspaceList");
const importMergeWorkspaces = $("#importMergeWorkspaces");
const tabSearchInput = $("#tabSearchInput");
const tabSearchResults = $("#tabSearchResults");
const snapSearchResults = $("#snapSearchResults");

let tabSearchDebounceTimer = null;
let tabSearchHighlightIdx = -1;
/** @type {chrome.tabs.Tab[]} */
let tabSearchLastMatches = [];

// ─── Master power toggle ─────────────────────────────────────────────────
const masterEnabled = $("#masterEnabled");
const powerLabel = $("#powerLabel");
const headerSubtitle = $("#headerSubtitle");

function applyPowerState(on) {
  document.body.classList.toggle("braincache-off", !on);
  if (powerLabel) powerLabel.textContent = on ? "ON" : "OFF";
  if (headerSubtitle) headerSubtitle.textContent = on ? "Your tabs are backed up" : "Paused — not saving";
  // keep settings toggle in sync
  const settingEl = $("#settingEnabled");
  if (settingEl) settingEl.checked = on;
}

if (masterEnabled) {
  masterEnabled.addEventListener("change", async () => {
    const on = masterEnabled.checked;
    applyPowerState(on);
    // persist via existing saveSettings path (reads #settingEnabled)
    const settingEl = $("#settingEnabled");
    if (settingEl) settingEl.checked = on;
    await saveSettings({ silent: true });
    showToast(on ? "✅ BrainCache enabled" : "⏸️ BrainCache paused");
  });
}

// ─── Tab Navigation ─────────────────────────────────────────────────────
$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#panel-${btn.dataset.panel}`).classList.add("active");
    if (btn.dataset.panel === "settings") {
      loadWorkspaceList();
    }
  });
});

// ─── Initialize ─────────────────────────────────────────────────────────
async function init() {
  attachWorkspaceSelectListener();
  setupTabSearch();
  await loadWorkspaceSelect();
  await loadStats();
  await loadSnapshots();
  await loadSettings();
  await loadHealth();
  await loadWorkspaceList();
}

// ─── Workspace dropdown (Backups) ─────────────────────────────────────
async function loadWorkspaceSelect() {
  const [pr, ar] = await Promise.all([
    sendMessage({ action: "getProfiles" }),
    sendMessage({ action: "getActiveProfileId" }),
  ]);
  if (!pr.success || !pr.data || !workspaceSelect) return;

  const activeId = ar.success
    ? ar.data
    : pr.data.find((p) => p.id === PROFILE_WORK_ID)?.id || pr.data[0]?.id;

  workspaceSelect.innerHTML = "";

  const workProf = pr.data.find((p) => p.id === PROFILE_WORK_ID);
  const personalProf = pr.data.find((p) => p.id === PROFILE_PERSONAL_ID);
  const extras = pr.data.filter(
    (p) => p.id !== PROFILE_WORK_ID && p.id !== PROFILE_PERSONAL_ID
  );

  const ordered = [];
  if (workProf) ordered.push(workProf);
  if (personalProf) ordered.push(personalProf);
  extras.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  ordered.push(...extras);

  for (const p of ordered) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeId) opt.selected = true;
    workspaceSelect.appendChild(opt);
  }

  const sep = document.createElement("option");
  sep.disabled = true;
  sep.value = "";
  sep.textContent = "──────────";
  workspaceSelect.appendChild(sep);

  const addOpt = document.createElement("option");
  addOpt.value = WORKSPACE_ADD_NEW_VALUE;
  addOpt.textContent = "+ Add new workspace…";
  workspaceSelect.appendChild(addOpt);
}

async function handleWorkspaceSelectChange() {
  if (!workspaceSelect) return;
  const v = workspaceSelect.value;

  if (v === WORKSPACE_ADD_NEW_VALUE) {
    const ar = await sendMessage({ action: "getActiveProfileId" });
    const current = ar.success ? ar.data : "";
    if (current) workspaceSelect.value = current;

    const name = window.prompt("Name for the new workspace:", "Side project");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("Name required");
      return;
    }
    const resp = await sendMessage({ action: "createProfile", name: trimmed });
    if (resp.success) {
      showToast(`Workspace “${resp.data.name}” created`);
      await loadWorkspaceSelect();
      workspaceSelect.value = resp.data.id;
      await loadStats();
      await loadSnapshots();
      await loadHealth();
      await loadWorkspaceList();
    } else {
      showToast("❌ " + (resp.error || "Could not create"));
    }
    return;
  }

  const resp = await sendMessage({ action: "setActiveProfile", profileId: v });
  if (resp.success) {
    const label = workspaceSelect.options[workspaceSelect.selectedIndex]?.text || "Workspace";
    showToast(`Switched to “${label}”`);
    await loadStats();
    await loadSnapshots();
    await loadHealth();
    await loadWorkspaceList();
  } else {
    showToast("❌ " + (resp.error || "Could not switch"));
    await loadWorkspaceSelect();
  }
}

let workspaceSelectListenerAttached = false;
function attachWorkspaceSelectListener() {
  if (!workspaceSelect || workspaceSelectListenerAttached) return;
  workspaceSelect.addEventListener("change", () => void handleWorkspaceSelectChange());
  workspaceSelectListenerAttached = true;
}

async function loadWorkspaceList() {
  const [pr, ar] = await Promise.all([
    sendMessage({ action: "getProfiles" }),
    sendMessage({ action: "getActiveProfileId" }),
  ]);
  if (!pr.success || !workspaceList) return;

  const activeId = ar.success
    ? ar.data
    : pr.data.find((p) => p.id === PROFILE_WORK_ID)?.id || pr.data[0]?.id || "";

  if (pr.data.length === 0) {
    workspaceList.innerHTML = "<p class=\"settings-note\">No workspaces.</p>";
    return;
  }

  workspaceList.innerHTML = pr.data
    .map((p) => {
      const isActive = p.id === activeId;
      const builtin = isBuiltinWorkspace(p.id);
      const label =
        escapeHtml(p.name) +
        (builtin ? " (built-in)" : "") +
        (isActive ? " · active" : "");
      const renameDisabled = builtin ? "disabled" : "";
      const deleteDisabled = builtin || pr.data.length <= 2 ? "disabled" : "";
      return `
      <div class="workspace-item" data-id="${escapeHtml(p.id)}">
        <span class="workspace-name">${label}</span>
        <div class="workspace-actions">
          <button type="button" class="btn-xs" data-ws="rename" ${renameDisabled}>Rename</button>
          <button type="button" class="btn-xs danger" data-ws="delete" ${deleteDisabled}>Delete</button>
        </div>
      </div>`;
    })
    .join("");

  workspaceList.querySelectorAll("[data-ws]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const item = e.target.closest(".workspace-item");
      const id = item?.dataset.id;
      if (!id) return;

      if (btn.dataset.ws === "rename") {
        if (isBuiltinWorkspace(id)) return;
        const prof = pr.data.find((x) => x.id === id);
        const next = window.prompt("Rename workspace:", prof?.name || "");
        if (next === null) return;
        const t = next.trim();
        if (!t) return;
        const r = await sendMessage({ action: "renameProfile", profileId: id, name: t });
        if (r.success) {
          showToast("Renamed");
          await loadWorkspaceSelect();
          await loadWorkspaceList();
        } else showToast("❌ " + (r.error || ""));
      }

      if (btn.dataset.ws === "delete") {
        if (isBuiltinWorkspace(id)) return;
        if (!confirm("Delete this workspace and all of its snapshots?")) return;
        const r = await sendMessage({ action: "deleteProfile", profileId: id });
        if (r.success) {
          showToast("Workspace deleted");
          await loadWorkspaceSelect();
          await loadStats();
          await loadSnapshots();
          await loadHealth();
          await loadWorkspaceList();
        } else showToast("❌ " + (r.error || ""));
      }
    });
  });
}

// ─── Smart tab search (open tabs) ───────────────────────────────────────

function tabSearchIsBrowsable(tab) {
  const u = tab.url || "";
  if (!u) return false;
  if (
    u.startsWith("chrome://") ||
    u.startsWith("chrome-extension://") ||
    u.startsWith("edge://") ||
    u.startsWith("devtools://") ||
    u.startsWith("about:")
  ) {
    return false;
  }
  return true;
}

function tabSearchTokenize(q) {
  const s = q.trim().toLowerCase();
  if (!s) return { qLower: "", tokens: [] };
  const tokens = s.split(/\s+/).filter(Boolean);
  return { qLower: s, tokens };
}

/**
 * Higher = better match. Returns null if any token is missing from title/url/host/path.
 */
function tabSearchScore(tab, tokens, qLower) {
  const title = (tab.title || "").toLowerCase();
  const url = (tab.url || "").toLowerCase();
  let host = "";
  let path = "";
  try {
    const u = new URL(tab.url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  const blob = `${title}\n${url}\n${host}\n${path}`;
  for (const t of tokens) {
    if (!blob.includes(t)) return null;
  }

  let score = 0;
  if (qLower.length >= 1) {
    if (title === qLower) score += 500;
    else if (title.startsWith(qLower)) score += 320;
    else if (title.includes(qLower)) score += 200;
    if (host === qLower || title === host) score += 80;
    else if (host.startsWith(qLower) || qLower.includes(host)) score += 140;
    else if (host.includes(qLower)) score += 100;
    if (url.includes(qLower)) score += 45;
    if (path.includes(qLower)) score += 35;
  }
  for (const t of tokens) {
    if (title.includes(t)) score += 40;
    else if (host.includes(t)) score += 26;
    else if (path.includes(t)) score += 18;
    else score += 8;
  }
  if (tab.active) score += 15;
  if (tab.highlighted) score += 5;
  score -= Math.min((tab.title || "").length, 100) * 0.06;
  return score;
}

function tabSearchClearUI() {
  tabSearchHighlightIdx = -1;
  tabSearchLastMatches = [];
  if (tabSearchResults) {
    tabSearchResults.innerHTML = "";
    tabSearchResults.classList.remove("has-results");
  }
  if (snapSearchResults) {
    snapSearchResults.innerHTML = "";
    snapSearchResults.classList.remove("has-results");
  }
}

function tabSearchSetHighlight(nextIdx) {
  const items = tabSearchResults?.querySelectorAll(".tab-search-item");
  if (!items || !items.length) return;
  tabSearchHighlightIdx = Math.max(0, Math.min(nextIdx, items.length - 1));
  items.forEach((el, i) => {
    el.classList.toggle("is-highlighted", i === tabSearchHighlightIdx);
  });
  items[tabSearchHighlightIdx].scrollIntoView({ block: "nearest" });
}

async function tabSearchActivate(tabId, windowId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (windowId != null) await chrome.windows.update(windowId, { focused: true });
    window.close();
  } catch (e) {
    showToast("Could not switch to tab");
  }
}

function tabSearchWireResultImages() {
  tabSearchResults?.querySelectorAll("img.tab-search-item-fav").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        img.replaceWith(Object.assign(document.createElement("span"), { className: "tab-search-item-fav tab-search-item-fav--ph" }));
      },
      { once: true }
    );
  });
}

async function tabSearchRun() {
  if (!tabSearchInput || !tabSearchResults) return;
  const { qLower, tokens } = tabSearchTokenize(tabSearchInput.value);
  if (!tokens.length) {
    tabSearchClearUI();
    return;
  }

  const all = await chrome.tabs.query({});
  const candidates = all.filter(tabSearchIsBrowsable);
  const scored = [];
  for (const tab of candidates) {
    const s = tabSearchScore(tab, tokens, qLower);
    if (s != null && tab.id != null) scored.push({ tab, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  tabSearchLastMatches = scored.slice(0, 25).map((x) => x.tab);

  if (!tabSearchLastMatches.length) {
    tabSearchResults.innerHTML = `<div class="tab-search-empty">No open tabs match.</div>`;
    tabSearchResults.classList.add("has-results");
    tabSearchHighlightIdx = -1;
  } else {
    tabSearchResults.innerHTML = tabSearchLastMatches
      .map((tab) => {
        const host = safeHost(tab.url || "");
        const fav = tab.favIconUrl
          ? `<img class="tab-search-item-fav" src="${escapeHtml(tab.favIconUrl)}" alt="">`
          : `<span class="tab-search-item-fav tab-search-item-fav--ph" aria-hidden="true"></span>`;
        return `<button type="button" class="tab-search-item" role="option" data-tab-id="${tab.id}" data-window-id="${tab.windowId ?? ""}">
          ${fav}
          <div class="tab-search-item-body">
            <div class="tab-search-item-title">${escapeHtml(tab.title || "(Untitled)")}</div>
            <div class="tab-search-item-host">${escapeHtml(host)}</div>
          </div>
        </button>`;
      })
      .join("");

    tabSearchResults.classList.add("has-results");
    tabSearchHighlightIdx = 0;
    tabSearchSetHighlight(0);
    tabSearchWireResultImages();

    tabSearchResults.querySelectorAll(".tab-search-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tid = parseInt(btn.dataset.tabId, 10);
        const wid = parseInt(btn.dataset.windowId, 10);
        void tabSearchActivate(tid, Number.isNaN(wid) ? undefined : wid);
      });
    });
  }

  await snapSearchRun(tokens, qLower);
}

async function snapSearchRun(tokens, qLower) {
  if (!snapSearchResults) return;

  const resp = await sendMessage({ action: "getSnapshots" });
  if (!resp.success || !resp.data) return;

  // Collect matching tabs across all snapshots, deduplicated by snapshot id + url
  const hits = [];
  const seen = new Set();
  for (const snap of resp.data) {
    for (const win of (snap.windows || [])) {
      for (const tab of (win.tabs || [])) {
        const score = tabSearchScore(tab, tokens, qLower);
        if (score == null) continue;
        const key = `${snap.id}::${tab.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ snap, tab, score });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 10);

  if (!top.length) {
    snapSearchResults.innerHTML = "";
    snapSearchResults.classList.remove("has-results");
    return;
  }

  const rows = top.map(({ snap, tab }) => {
    const host = safeHost(tab.url || "");
    const snapTime = formatTime(snap.timestamp);
    const fav = tab.favIconUrl
      ? `<img class="snap-search-item-fav" src="${escapeHtml(tab.favIconUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'snap-search-item-fav snap-search-item-fav--ph'}))">`
      : `<span class="snap-search-item-fav snap-search-item-fav--ph" aria-hidden="true"></span>`;
    return `<div class="snap-search-item">
      ${fav}
      <div class="snap-search-item-body">
        <div class="snap-search-item-title">${escapeHtml(tab.title || "(Untitled)")}</div>
        <div class="snap-search-item-meta">${escapeHtml(host)} · ${escapeHtml(snapTime)}</div>
      </div>
      <button type="button" class="snap-search-item-restore" data-snap-id="${escapeHtml(String(snap.id))}">↩ Restore</button>
    </div>`;
  }).join("");

  snapSearchResults.innerHTML =
    `<div class="snap-search-section-title">In snapshots</div>` + rows;
  snapSearchResults.classList.add("has-results");

  snapSearchResults.querySelectorAll(".snap-search-item-restore").forEach((btn) => {
    btn.addEventListener("click", () => void restoreSnapshot(btn.dataset.snapId));
  });
}

function setupTabSearch() {
  if (!tabSearchInput || !tabSearchResults) return;

  tabSearchInput.addEventListener("input", () => {
    if (tabSearchDebounceTimer) clearTimeout(tabSearchDebounceTimer);
    tabSearchDebounceTimer = setTimeout(() => {
      tabSearchDebounceTimer = null;
      void tabSearchRun();
    }, 140);
  });

  tabSearchInput.addEventListener("keydown", (e) => {
    const open = tabSearchResults.classList.contains("has-results");
    const items = tabSearchResults.querySelectorAll(".tab-search-item");

    if (e.key === "Escape") {
      tabSearchInput.value = "";
      tabSearchClearUI();
      return;
    }

    if (!open || !items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      tabSearchSetHighlight(tabSearchHighlightIdx < 0 ? 0 : tabSearchHighlightIdx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      tabSearchSetHighlight(tabSearchHighlightIdx <= 0 ? 0 : tabSearchHighlightIdx - 1);
    } else if (e.key === "Enter") {
      const idx = tabSearchHighlightIdx >= 0 ? tabSearchHighlightIdx : 0;
      const row = items[idx];
      if (row) {
        e.preventDefault();
        const tid = parseInt(row.dataset.tabId, 10);
        const wid = parseInt(row.dataset.windowId, 10);
        void tabSearchActivate(tid, Number.isNaN(wid) ? undefined : wid);
      }
    }
  });
}

// ─── Storage health ─────────────────────────────────────────────────────
function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function formatOldestHint(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

async function loadHealth() {
  const resp = await sendMessage({ action: "getStorageHealth" });
  if (!resp.success) return;
  const h = resp.data;
  $("#healthBytes").textContent = formatBytes(h.bytesInUse);
  $("#healthOldest").textContent = h.oldestSnapshotIso ? formatOldestHint(h.oldestSnapshotIso) : "—";
}

trimBtn.addEventListener("click", async () => {
  if (!confirm("Delete the oldest half of snapshots in this workspace? Newer backups stay.")) return;
  const resp = await sendMessage({ action: "trimSnapshots" });
  if (resp.success && resp.data) {
    showToast(`Removed ${resp.data.removed} · ${resp.data.remaining} left`);
    await loadStats();
    await loadSnapshots();
    await loadHealth();
  } else {
    showToast("❌ " + (resp.error || "Delete failed"));
  }
});

shortcutsLinkBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ─── Stats ──────────────────────────────────────────────────────────────
async function loadStats() {
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const validTabs = tabs.filter(
    (t) =>
      t.url &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("chrome-extension://")
  );

  $("#statTabs").textContent = validTabs.length;
  $("#statWindows").textContent = windows.length;

  const resp = await sendMessage({ action: "getSnapshots" });
  if (resp.success) {
    $("#statSnapshots").textContent = resp.data.length;
  }
}

// ─── Snapshots ──────────────────────────────────────────────────────────
async function loadSnapshots() {
  const resp = await sendMessage({ action: "getSnapshots" });
  if (!resp.success) return;

  const snapshots = resp.data.slice().reverse();

  if (snapshots.length === 0) {
    snapshotList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <h3>No snapshots yet</h3>
        <p>Click "Save Snapshot Now" to take your first backup.</p>
      </div>
    `;
    return;
  }

  snapshotList.innerHTML = snapshots
    .map((snap) => {
      const time = formatTime(snap.timestamp);
      const triggerClass = snapshotTriggerClass(snap.trigger);
      const triggerLabel = escapeHtml(String(formatTrigger(snap.trigger)));
      const sid = escapeHtml(String(snap.id ?? ""));
      const wn = Number(snap.windowCount) || 0;
      const tn = Number(snap.tabCount) || 0;

      return `
      <div class="snapshot-card" data-id="${sid}">
        <div class="snapshot-header">
          <span class="snapshot-time">${escapeHtml(String(time))}</span>
          <span class="snapshot-trigger ${triggerClass}">${triggerLabel}</span>
        </div>
        <div class="snapshot-meta">
          <span>🗂 ${wn} window${wn !== 1 ? "s" : ""}</span>
          <span>📄 ${tn} tab${tn !== 1 ? "s" : ""}</span>
        </div>
        <div class="snapshot-actions">
          <button class="btn-sm btn-restore" data-action="restore" data-id="${sid}">↩ Restore</button>
          <button class="btn-sm btn-view" data-action="view" data-id="${sid}">👁 View</button>
          <button class="btn-sm btn-delete" data-action="delete" data-id="${sid}">✕</button>
        </div>
      </div>
    `;
    })
    .join("");

  snapshotList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "restore") restoreSnapshot(id);
      else if (action === "view") viewSnapshot(id, snapshots);
      else if (action === "delete") deleteSnapshot(id);
    });
  });
}

// ─── Actions ────────────────────────────────────────────────────────────

saveNowBtn.addEventListener("click", async () => {
  saveNowBtn.classList.add("saving");
  saveNowBtn.innerHTML = "<span>⏳</span> Saving...";

  await saveSettings({ silent: true });
  const resp = await sendMessage({ action: "takeSnapshot" });

  if (resp.success) {
    showToast("✅ Snapshot saved!");
    await loadStats();
    await loadSnapshots();
    await loadHealth();
  } else {
    showToast("❌ Failed to save snapshot");
  }

  saveNowBtn.classList.remove("saving");
  saveNowBtn.innerHTML = '<span>💾</span> Save Snapshot Now';
});

async function restoreSnapshot(id) {
  if (!confirm("This will open all tabs from this snapshot in new windows. Continue?")) return;

  const resp = await sendMessage({ action: "restoreSnapshot", snapshotId: id });
  if (resp.success) {
    showToast("✅ Tabs restored!");
  } else {
    showToast("❌ Restore failed: " + (resp.error || "Unknown error"));
  }
}

function viewSnapshot(id, snapshots) {
  const snap = snapshots.find((s) => s.id === id);
  if (!snap) return;

  const time = formatTime(snap.timestamp);
  $("#detailTitle").textContent = time;
  $("#detailMeta").textContent = `${snap.windowCount} windows · ${snap.tabCount} tabs · ${formatTrigger(snap.trigger)}`;

  const content = snap.windows
    .map((win, i) => {
      const tabsHtml = win.tabs
        .map((tab) => {
          const favicon = tab.favIconUrl
            ? `<img class="tab-favicon" src="${escapeHtml(tab.favIconUrl)}" alt="">`
            : `<span class="tab-favicon tab-favicon--placeholder"></span>`;
          const pinned = tab.pinned ? `<span class="tab-pinned">📌</span>` : "";
          const host = safeHost(tab.url);

          return `
        <div class="tab-item">
          ${favicon}
          <span class="tab-title">${escapeHtml(tab.title)}</span>
          ${pinned}
          <span class="tab-url">${escapeHtml(host)}</span>
        </div>
      `;
        })
        .join("");

      return `
      <div class="window-group">
        <div class="window-group-header">
          🪟 Window ${i + 1} ${win.focused ? "(focused)" : ""} — ${win.tabs.length} tabs
        </div>
        ${tabsHtml}
      </div>
    `;
    })
    .join("");

  const detailContent = $("#detailContent");
  detailContent.innerHTML = content;
  detailContent.querySelectorAll("img.tab-favicon").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        img.style.display = "none";
      },
      { once: true }
    );
  });
  detailOverlay.classList.add("show");
}

backBtn.addEventListener("click", () => {
  detailOverlay.classList.remove("show");
});

async function deleteSnapshot(id) {
  const resp = await sendMessage({ action: "deleteSnapshot", snapshotId: id });
  if (resp.success) {
    showToast("Snapshot deleted");
    await loadStats();
    await loadSnapshots();
    await loadHealth();
  }
}

clearAllBtn.addEventListener("click", async () => {
  if (!confirm("Delete ALL snapshots in this workspace? This cannot be undone.")) return;
  if (!confirm("Are you sure? All backup data in this workspace will be permanently lost.")) return;

  const resp = await sendMessage({ action: "clearAll" });
  if (resp.success) {
    showToast("All snapshots deleted");
    await loadStats();
    await loadSnapshots();
    await loadHealth();
  }
});

// ─── Export / Import ────────────────────────────────────────────────────

exportBtn.addEventListener("click", async () => {
  const resp = await sendMessage({ action: "exportAll" });
  if (!resp.success) return;

  const blob = new Blob([JSON.stringify(resp.data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `braincache-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`📤 Exported ${resp.data.length} snapshots`);
});

exportAllWsBtn.addEventListener("click", async () => {
  const resp = await sendMessage({ action: "exportAllWorkspaces" });
  if (!resp.success) return;

  const blob = new Blob([JSON.stringify(resp.data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `braincache-all-workspaces-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast("📤 Exported all workspaces");
});

importBtn.addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    const mergeAll = importMergeWorkspaces.checked;

    if (mergeAll && data && typeof data === "object" && data.snapshotsByProfile) {
      const resp = await sendMessage({
        action: "importSnapshots",
        snapshots: data,
        mergeAllWorkspaces: true,
      });
      if (resp.success) {
        showToast(`📥 Merged workspaces (${resp.count} keys)`);
        await loadWorkspaceSelect();
        await loadStats();
        await loadSnapshots();
        await loadHealth();
        await loadWorkspaceList();
      } else showToast("❌ " + (resp.error || "Import failed"));
      importInput.value = "";
      return;
    }

    if (Array.isArray(data)) {
      const resp = await sendMessage({ action: "importSnapshots", snapshots: data });
      if (resp.success) {
        showToast(`📥 Imported ${resp.count} snapshots`);
        await loadStats();
        await loadSnapshots();
        await loadHealth();
      }
    } else if (data && data.snapshotsByProfile) {
      const resp = await sendMessage({
        action: "importSnapshots",
        snapshots: data,
        mergeAllWorkspaces: false,
      });
      if (resp.success) {
        showToast(`📥 Imported ${resp.count} snapshots into this workspace`);
        await loadStats();
        await loadSnapshots();
        await loadHealth();
      } else showToast("❌ " + (resp.error || "Import failed"));
    } else {
      showToast("❌ Invalid backup file");
    }
  } catch (err) {
    showToast("❌ Failed to import: " + err.message);
  }

  importInput.value = "";
});

// ─── Settings ───────────────────────────────────────────────────────────

async function loadSettings() {
  const resp = await sendMessage({ action: "getSettings" });
  if (!resp.success) return;

  const s = resp.data;
  const isOn = s.enabled !== false;
  $("#settingEnabled").checked = isOn;
  if (masterEnabled) masterEnabled.checked = isOn;
  applyPowerState(isOn);
  const totalMin = Math.min(1440, Math.max(60, parseInt(s.autoBackupInterval, 10) || 1440));
  $("#settingIntervalHours").value = Math.floor(totalMin / 60);
  $("#settingIntervalMins").value = totalMin % 60;
  $("#settingTabChange").checked = s.backupOnTabChange;
  $("#settingDedupe").checked = s.dedupeOnOpen !== false;
  const maxSnaps = Math.min(50, Math.max(5, parseInt(s.maxSnapshots, 10) || 50));
  $("#settingMaxSnaps").value = maxSnaps;
}

["settingEnabled", "settingIntervalHours", "settingIntervalMins", "settingTabChange", "settingDedupe", "settingMaxSnaps"].forEach(
  (id) => {
    $(`#${id}`).addEventListener("change", () => {
      if (id === "settingEnabled") {
        const on = $("#settingEnabled").checked;
        if (masterEnabled) masterEnabled.checked = on;
        applyPowerState(on);
      }
      void saveSettings();
    });
  }
);

let intervalInputSaveTimer = null;
function scheduleIntervalSettingsSave() {
  if (intervalInputSaveTimer) clearTimeout(intervalInputSaveTimer);
  intervalInputSaveTimer = setTimeout(() => {
    intervalInputSaveTimer = null;
    void saveSettings({ silent: true });
  }, 450);
}
$("#settingIntervalHours")?.addEventListener("input", scheduleIntervalSettingsSave);
$("#settingIntervalMins")?.addEventListener("input", scheduleIntervalSettingsSave);

function readBackupIntervalMinutes() {
  const h = parseInt($("#settingIntervalHours").value, 10);
  const m = parseInt($("#settingIntervalMins").value, 10);
  const hours = Number.isNaN(h) ? 0 : Math.min(24, Math.max(0, h));
  const mins = Number.isNaN(m) ? 0 : Math.min(59, Math.max(0, m));
  let total = hours * 60 + mins;
  total = Math.min(1440, Math.max(60, total));
  return total;
}

/**
 * @param {{ silent?: boolean }} [opts]
 */
async function saveSettings(opts = {}) {
  const silent = !!opts.silent;
  const autoBackupInterval = readBackupIntervalMinutes();
  const h = Math.floor(autoBackupInterval / 60);
  const mi = autoBackupInterval % 60;
  $("#settingIntervalHours").value = h;
  $("#settingIntervalMins").value = mi;

  const rawSnaps = parseInt($("#settingMaxSnaps").value, 10);
  const maxSnapshots = Math.min(50, Math.max(5, Number.isNaN(rawSnaps) ? 50 : rawSnaps));
  $("#settingMaxSnaps").value = maxSnapshots;

  const newSettings = {
    enabled: $("#settingEnabled").checked,
    autoBackupInterval,
    backupOnTabChange: $("#settingTabChange").checked,
    dedupeOnOpen: $("#settingDedupe").checked,
    maxSnapshots,
  };

  const resp = await sendMessage({ action: "updateSettings", settings: newSettings });
  if (resp.success) {
    if (!silent) showToast("⚙️ Settings saved");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      resolve(response || { success: false, error: "No response" });
    });
  });
}

function formatTime(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const diff = now - d;

  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  let relative;
  if (mins < 1) relative = "just now";
  else if (mins < 60) relative = `${mins}m ago`;
  else if (hours < 24) relative = `${hours}h ago`;
  else if (days < 7) relative = `${days}d ago`;
  else relative = d.toLocaleDateString();

  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });

  return `${dateStr}, ${timeStr} (${relative})`;
}

function formatTrigger(trigger) {
  const map = {
    auto: "Auto",
    manual: "Manual",
    startup: "Startup",
    initial: "Install",
    "tab-created": "Tab +",
    "tab-closed": "Tab −",
    "tab-loaded": "Tab ↻",
    "window-opened": "Win +",
    "window-closed": "Win −",
  };
  return map[trigger] || trigger;
}

/** CSS class suffix from trigger — only safe tokens (imported snapshots can carry arbitrary `trigger`). */
function snapshotTriggerClass(trigger) {
  const t = String(trigger ?? "");
  if (/^[a-z0-9-]+$/i.test(t) && t.length <= 32) return `trigger-${t}`;
  return "trigger-unknown";
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Feature #1: AI Tab Summary ─────────────────────────────────────────

const CLUSTER_COLORS = [
  "#0077C5","#00B894","#E17055","#6C5CE7","#FDCB6E",
  "#00CEC9","#E84393","#55EFC4","#74B9FF","#A29BFE"
];

async function loadAiSummary() {
  const loading = $("#aiSummaryLoading");
  const content = $("#aiSummaryContent");
  const list = $("#aiClusterList");
  if (!loading || !content || !list) return;

  loading.style.display = "block";
  content.style.display = "none";

  const resp = await sendMessage({ action: "getAiSummary" });
  loading.style.display = "none";
  if (!resp.success || !resp.data) {
    list.innerHTML = '<div style="color:var(--gray);font-size:12px;padding:12px;">Could not load summary.</div>';
    content.style.display = "block";
    return;
  }

  const { clusters, totalTabs } = resp.data;
  if (!clusters || clusters.length === 0) {
    list.innerHTML = '<div style="color:var(--gray);font-size:12px;padding:12px;">No browsable tabs open right now.</div>';
    content.style.display = "block";
    return;
  }

  list.innerHTML = `<div style="font-size:11px;color:var(--gray);margin-bottom:8px;">${totalTabs} tabs grouped into ${clusters.length} topic${clusters.length !== 1 ? "s" : ""}:</div>` +
    clusters.map((c, i) => {
      const color = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
      const tabRows = (c.titles || []).slice(0, 4).map((t) =>
        `<div class="cluster-tab-row">· ${escapeHtml((t || "").slice(0, 60))}</div>`
      ).join("");
      const moreCount = (c.titles || []).length - 4;
      const more = moreCount > 0 ? `<div class="cluster-tab-row" style="color:var(--gray);">+${moreCount} more</div>` : "";
      return `<div class="cluster-card" style="border-left:3px solid ${color};">
        <div class="cluster-label">
          <span>${escapeHtml(c.label)}</span>
          <span class="cluster-count" style="background:${color}18;color:${color};">${c.count} tab${c.count !== 1 ? "s" : ""}</span>
        </div>
        <div class="cluster-tabs">${tabRows}${more}</div>
      </div>`;
    }).join("");

  content.style.display = "block";
}

$("#refreshSummaryBtn")?.addEventListener("click", () => void loadAiSummary());

// Load AI summary when Brain tab is clicked
$$(".tab-btn").forEach((btn) => {
  if (btn.dataset.panel === "brain") {
    btn.addEventListener("click", () => void loadAiSummary());
  }
  if (btn.dataset.panel === "time") {
    btn.addEventListener("click", () => void loadFocusTime());
  }
});

// ─── Feature #4: Focus Time Tracking ────────────────────────────────────

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

async function loadFocusTime() {
  const loading = $("#focusTimeLoading");
  const content = $("#focusTimeContent");
  const list = $("#focusTimeList");
  const empty = $("#focusTimeEmpty");
  if (!loading || !content || !list) return;

  loading.style.display = "block";
  content.style.display = "none";

  const resp = await sendMessage({ action: "getTabTimeToday" });
  loading.style.display = "none";
  if (!resp.success || !resp.data) {
    content.style.display = "block";
    empty.style.display = "block";
    return;
  }

  const { domains } = resp.data;
  const entries = Object.entries(domains || {})
    .filter(([, ms]) => ms >= 5000)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15);

  if (entries.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    content.style.display = "block";
    return;
  }

  empty.style.display = "none";
  const maxMs = entries[0][1];
  list.innerHTML = entries.map(([domain, ms]) => {
    const pct = Math.round((ms / maxMs) * 100);
    return `<div class="time-row">
      <span class="time-domain">${escapeHtml(domain)}</span>
      <div class="time-bar-wrap"><div class="time-bar" style="width:${pct}%;"></div></div>
      <span class="time-val">${formatMs(ms)}</span>
    </div>`;
  }).join("");
  content.style.display = "block";
}

// ─── Feature #3: Park Mode ───────────────────────────────────────────────

const parkBtn = $("#parkBtn");
parkBtn?.addEventListener("click", async () => {
  const name = prompt("Name this parked session (or leave blank):", "Parked Session");
  if (name === null) return; // user cancelled
  parkBtn.disabled = true;
  parkBtn.textContent = "Parking…";
  const resp = await sendMessage({ action: "parkSession", name: name.trim() || "Parked Session" });
  parkBtn.disabled = false;
  parkBtn.innerHTML = "<span>🅿️</span> Park Session (Stash & Close All)";
  if (resp.success) {
    showToast(`🅿️ Parked ${resp.data.tabCount} tabs as "${resp.data.name}"`);
    await loadStats();
    await loadSnapshots();
    await loadHealth();
  } else {
    showToast("❌ " + (resp.error || "Park failed"));
  }
});

// ─── Feature #5: Monday Morning Context Restore ──────────────────────────

let mondaySnapshotId = null;

async function checkMondayContext() {
  const banner = $("#mondayBanner");
  if (!banner) return;
  const resp = await sendMessage({ action: "getMondayContext" });
  if (!resp.success || !resp.data) return;

  const ctx = resp.data;
  mondaySnapshotId = ctx.snapshotId;
  $("#mondaySummary").textContent = ctx.summary;
  banner.style.display = "block";
}

$("#mondayRestoreBtn")?.addEventListener("click", async () => {
  if (!mondaySnapshotId) return;
  const resp = await sendMessage({ action: "restoreSnapshot", snapshotId: mondaySnapshotId });
  if (resp.success) {
    showToast("✅ Session restored!");
    $("#mondayBanner").style.display = "none";
  } else {
    showToast("❌ " + (resp.error || "Restore failed"));
  }
});

$("#mondayDismissBtn")?.addEventListener("click", () => {
  $("#mondayBanner").style.display = "none";
});

// ─── Also add "park" to formatTrigger ────────────────────────────────────

const _origFormatTrigger = formatTrigger;
// patch trigger map to include park
function formatTrigger(trigger) {
  if (trigger === "park") return "Parked";
  return _origFormatTrigger(trigger);
}

// ─── Extend init to load new features ───────────────────────────────────

const _origInit = init;
async function init() {
  await _origInit();
  await checkMondayContext();
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ─── Init ───────────────────────────────────────────────────────────────
init();
