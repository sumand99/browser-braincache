/**
 * BrainCache — Background Service Worker
 * ==========================================
 * Continuously monitors and backs up all open Chrome tabs.
 * Runs auto-backup every N minutes + saves on significant tab events.
 */

// ─── Default Settings ───────────────────────────────────────────────────
const MIN_BACKUP_INTERVAL_MIN = 60;
const MAX_BACKUP_INTERVAL_MIN = 1440; // 24 hours

const MIN_MAX_SNAPSHOTS = 5;
const MAX_MAX_SNAPSHOTS = 50;

const DEFAULT_SETTINGS = {
  autoBackupInterval: MAX_BACKUP_INTERVAL_MIN, // minutes (default: 24h)
  maxSnapshots: MAX_MAX_SNAPSHOTS, // keep last N snapshots (clamped 5–50)
  backupOnTabChange: true, // save when tabs open/close
  debounceMs: 10000, // debounce tab-change saves (10s)
  enabled: true,
  dedupeOnOpen: true, // new tabs: switch to existing same-URL tab and close the new one
};

/** Legacy single workspace id (migrated → Personal). */
const LEGACY_DEFAULT_PROFILE_ID = "profile_default";
/** Built-in workspaces — always present; cannot delete or rename. */
const PROFILE_PERSONAL_ID = "profile_personal";
const PROFILE_WORK_ID = "profile_work";

let debounceTimer = null;
let settings = { ...DEFAULT_SETTINGS };

/** Debounce context menu rebuilds — removeAll/create is expensive; avoids doing it on every auto-save burst. */
let menuRebuildTimer = null;
const MENU_REBUILD_DEBOUNCE_MS = 2500;
/** Skip redundant menu rebuilds when dedupe flag + last 3 snapshot ids are unchanged. */
let lastContextMenuSig = "";

let settingsCacheTime = 0;
const SETTINGS_CACHE_MS = 5000;

/** Tab ids created via onCreated — only these are candidates for dedupe (avoids closing on refresh). */
const recentlyCreatedTabIds = new Set();
const RECENT_TAB_TTL_MS = 120000;
const recentTabTimeouts = new Map();

// ─── Workspace profiles (local snapshot stacks) ────────────────────────

function sortWorkspaceProfiles(profiles) {
  const rank = (p) => {
    if (p.id === PROFILE_WORK_ID) return 0;
    if (p.id === PROFILE_PERSONAL_ID) return 1;
    return 2;
  };
  return [...profiles].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (a.name || "").localeCompare(b.name || "");
  });
}

async function ensureProfilesMigrated() {
  const data = await chrome.storage.local.get([
    "snapshots",
    "profiles",
    "activeProfileId",
    "snapshotsByProfile",
  ]);

  const iso = () => new Date().toISOString();
  let profiles = Array.isArray(data.profiles) ? [...data.profiles] : [];
  let snapshotsByProfile = { ...(data.snapshotsByProfile || {}) };
  let activeProfileId = data.activeProfileId;
  let dirty = false;

  const flatSnaps = Array.isArray(data.snapshots) ? data.snapshots : null;

  if (flatSnaps) {
    await chrome.storage.local.remove(["snapshots"]);
    dirty = true;
    if (profiles.length === 0) {
      profiles = [
        { id: PROFILE_PERSONAL_ID, name: "Personal", createdAt: iso() },
        { id: PROFILE_WORK_ID, name: "Work", createdAt: iso() },
      ];
      snapshotsByProfile[PROFILE_PERSONAL_ID] = [];
      snapshotsByProfile[PROFILE_WORK_ID] = flatSnaps;
      activeProfileId = PROFILE_WORK_ID;
    } else {
      const firstId = profiles[0]?.id;
      if (firstId && !snapshotsByProfile[firstId]) snapshotsByProfile[firstId] = [];
      if (firstId) {
        snapshotsByProfile[firstId] = [...(snapshotsByProfile[firstId] || []), ...flatSnaps];
      }
    }
  }

  if (profiles.length === 0) {
    profiles = [
      { id: PROFILE_PERSONAL_ID, name: "Personal", createdAt: iso() },
      { id: PROFILE_WORK_ID, name: "Work", createdAt: iso() },
    ];
    snapshotsByProfile[PROFILE_PERSONAL_ID] = snapshotsByProfile[PROFILE_PERSONAL_ID] || [];
    snapshotsByProfile[PROFILE_WORK_ID] = snapshotsByProfile[PROFILE_WORK_ID] || [];
    activeProfileId = PROFILE_WORK_ID;
    dirty = true;
  } else if (profiles.length === 1 && profiles[0].id === LEGACY_DEFAULT_PROFILE_ID) {
    const legacySnaps = snapshotsByProfile[LEGACY_DEFAULT_PROFILE_ID] || [];
    delete snapshotsByProfile[LEGACY_DEFAULT_PROFILE_ID];
    snapshotsByProfile[PROFILE_PERSONAL_ID] = [];
    snapshotsByProfile[PROFILE_WORK_ID] = legacySnaps;
    profiles = [
      { id: PROFILE_PERSONAL_ID, name: "Personal", createdAt: profiles[0].createdAt || iso() },
      { id: PROFILE_WORK_ID, name: "Work", createdAt: iso() },
    ];
    if (activeProfileId === LEGACY_DEFAULT_PROFILE_ID) activeProfileId = PROFILE_WORK_ID;
    dirty = true;
  } else {
    const hasPersonal = profiles.some((p) => p.id === PROFILE_PERSONAL_ID);
    const hasWork = profiles.some((p) => p.id === PROFILE_WORK_ID);
    if (!hasPersonal) {
      profiles.unshift({ id: PROFILE_PERSONAL_ID, name: "Personal", createdAt: iso() });
      snapshotsByProfile[PROFILE_PERSONAL_ID] = snapshotsByProfile[PROFILE_PERSONAL_ID] || [];
      dirty = true;
    }
    if (!hasWork) {
      const pi = profiles.findIndex((p) => p.id === PROFILE_PERSONAL_ID);
      const insertAt = pi >= 0 ? pi + 1 : 0;
      profiles.splice(insertAt, 0, { id: PROFILE_WORK_ID, name: "Work", createdAt: iso() });
      snapshotsByProfile[PROFILE_WORK_ID] = snapshotsByProfile[PROFILE_WORK_ID] || [];
      dirty = true;
    }
    if (snapshotsByProfile[LEGACY_DEFAULT_PROFILE_ID] && !profiles.some((p) => p.id === LEGACY_DEFAULT_PROFILE_ID)) {
      const into = snapshotsByProfile[PROFILE_WORK_ID] || [];
      snapshotsByProfile[PROFILE_WORK_ID] = [...into, ...(snapshotsByProfile[LEGACY_DEFAULT_PROFILE_ID] || [])];
      delete snapshotsByProfile[LEGACY_DEFAULT_PROFILE_ID];
      dirty = true;
    }
  }

  let fixedBuiltinNames = false;
  profiles = profiles.map((p) => {
    if (p.id === PROFILE_PERSONAL_ID && p.name !== "Personal") {
      fixedBuiltinNames = true;
      return { ...p, name: "Personal" };
    }
    if (p.id === PROFILE_WORK_ID && p.name !== "Work") {
      fixedBuiltinNames = true;
      return { ...p, name: "Work" };
    }
    return p;
  });
  if (fixedBuiltinNames) dirty = true;

  profiles = sortWorkspaceProfiles(profiles);

  if (!activeProfileId || !profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = PROFILE_WORK_ID;
    dirty = true;
  }

  for (const p of profiles) {
    if (!snapshotsByProfile[p.id]) {
      snapshotsByProfile[p.id] = [];
      dirty = true;
    }
  }

  if (dirty) {
    await chrome.storage.local.set({
      profiles,
      activeProfileId,
      snapshotsByProfile,
    });
  } else if (!snapshotsByProfile[activeProfileId]) {
    snapshotsByProfile[activeProfileId] = [];
    await chrome.storage.local.set({ snapshotsByProfile });
  }
}

async function getProfilesState() {
  await ensureProfilesMigrated();
  const data = await chrome.storage.local.get(["profiles", "activeProfileId", "snapshotsByProfile"]);
  return {
    profiles: sortWorkspaceProfiles(data.profiles || []),
    activeProfileId: data.activeProfileId || PROFILE_WORK_ID,
    snapshotsByProfile: data.snapshotsByProfile || {},
  };
}

async function getActiveProfileId() {
  const { activeProfileId } = await getProfilesState();
  return activeProfileId;
}

// ─── Initialize ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[BrainCache] onInstalled:", details.reason);
  await loadSettings();
  await ensureProfilesMigrated();
  await setupAlarm();
  if (details.reason === "install") {
    await takeSnapshot("initial");
  } else {
    await updateBadge();
  }
  rebuildContextMenusImmediate();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[BrainCache] Chrome started — taking startup snapshot.");
  await loadSettings();
  await ensureProfilesMigrated();
  await setupAlarm();
  await takeSnapshot("startup");
  rebuildContextMenusImmediate();
});

// ─── Alarm-based auto-backup ────────────────────────────────────────────

async function setupAlarm() {
  await chrome.alarms.clearAll();
  if (settings.enabled) {
    chrome.alarms.create("autoBackup", {
      periodInMinutes: settings.autoBackupInterval,
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "autoBackup") {
    await loadSettings();
    await ensureProfilesMigrated();
    await takeSnapshot("auto");
    scheduleMenuRebuild();
  }
});

// ─── Tab event listeners (debounced) ────────────────────────────────────

function debouncedSnapshot(reason) {
  if (!settings.backupOnTabChange || !settings.enabled) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    await takeSnapshot(reason);
    scheduleMenuRebuild();
  }, settings.debounceMs);
}

function markTabRecentlyCreated(tabId) {
  recentlyCreatedTabIds.add(tabId);
  if (recentTabTimeouts.has(tabId)) clearTimeout(recentTabTimeouts.get(tabId));
  const t = setTimeout(() => {
    recentlyCreatedTabIds.delete(tabId);
    recentTabTimeouts.delete(tabId);
  }, RECENT_TAB_TTL_MS);
  recentTabTimeouts.set(tabId, t);
}

function unmarkRecentlyCreated(tabId) {
  recentlyCreatedTabIds.delete(tabId);
  if (recentTabTimeouts.has(tabId)) {
    clearTimeout(recentTabTimeouts.get(tabId));
    recentTabTimeouts.delete(tabId);
  }
}

function isDedupableUrl(url) {
  if (!url) return false;
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://")
  ) {
    return false;
  }
  return true;
}

function urlsMatch(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/**
 * If this tab was just created and another tab already has the same URL,
 * focus the existing tab and close this one.
 */
async function dedupeNewTabIfDuplicate(tabId, tab) {
  if (!recentlyCreatedTabIds.has(tabId)) return;
  const url = tab.url;
  if (!url || !isDedupableUrl(url)) return;

  try {
    // Prefer same-window query (smaller); only scan all tabs if no duplicate in this window.
    let others = [];
    if (tab.windowId != null) {
      const inWin = await chrome.tabs.query({ windowId: tab.windowId });
      others = inWin.filter(
        (t) => t.id != null && t.id !== tabId && t.url && urlsMatch(t.url, url)
      );
    }
    if (others.length === 0) {
      const all = await chrome.tabs.query({});
      others = all.filter(
        (t) => t.id != null && t.id !== tabId && t.url && urlsMatch(t.url, url)
      );
    }
    if (others.length === 0) return;

    others.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const keep = others[0];

    if (keep.windowId != null) {
      await chrome.windows.update(keep.windowId, { focused: true });
    }
    if (keep.id != null) {
      await chrome.tabs.update(keep.id, { active: true });
    }
    await chrome.tabs.remove(tabId);
    unmarkRecentlyCreated(tabId);
  } catch (err) {
    console.warn("[BrainCache] Dedupe skipped:", err);
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id != null) markTabRecentlyCreated(tab.id);
  debouncedSnapshot("tab-created");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  unmarkRecentlyCreated(tabId);
  debouncedSnapshot("tab-closed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    debouncedSnapshot("tab-loaded");
  }
  const shouldTryDedupe =
    settings.dedupeOnOpen &&
    (changeInfo.url != null || changeInfo.status === "complete") &&
    tab.url &&
    isDedupableUrl(tab.url);
  if (shouldTryDedupe) {
    void dedupeNewTabIfDuplicate(tabId, tab);
  }
});
chrome.windows.onCreated.addListener(() => debouncedSnapshot("window-opened"));
chrome.windows.onRemoved.addListener(() => debouncedSnapshot("window-closed"));

// ─── Core: Take Snapshot ────────────────────────────────────────────────

async function takeSnapshot(trigger = "manual") {
  try {
    const windows = await chrome.windows.getAll({ populate: true });

    const snapshot = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      trigger: trigger,
      windowCount: 0,
      tabCount: 0,
      windows: [],
    };

    for (const win of windows) {
      if (win.type !== "normal") continue;

      const windowData = {
        id: win.id,
        focused: win.focused,
        state: win.state,
        tabs: [],
      };

      for (const tab of win.tabs) {
        if (
          !tab.url ||
          tab.url.startsWith("chrome://") ||
          tab.url.startsWith("chrome-extension://") ||
          tab.url.startsWith("about:") ||
          tab.url.startsWith("edge://")
        ) {
          continue;
        }

        windowData.tabs.push({
          url: tab.url,
          title: tab.title || "(Untitled)",
          favIconUrl: tab.favIconUrl || "",
          pinned: tab.pinned,
          index: tab.index,
        });
      }

      if (windowData.tabs.length > 0) {
        snapshot.windows.push(windowData);
        snapshot.tabCount += windowData.tabs.length;
      }
    }

    snapshot.windowCount = snapshot.windows.length;

    // One pass already enumerated tabs — avoid a second chrome.tabs.query for the badge.
    setBadgeTabCount(snapshot.tabCount);

    if (snapshot.tabCount === 0) return;

    await saveSnapshot(snapshot);

    console.log(
      `[BrainCache] Snapshot saved: ${snapshot.tabCount} tabs in ${snapshot.windowCount} windows (${trigger})`
    );
    return snapshot;
  } catch (err) {
    console.error("[BrainCache] Snapshot failed:", err);
    await updateBadge();
  }
}

// ─── Storage Management ─────────────────────────────────────────────────

async function saveSnapshot(snapshot) {
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = { ...(data.snapshotsByProfile || {}) };
  let snapshots = by[profileId] || [];

  const skipDedupe = snapshot.trigger === "manual";
  if (!skipDedupe && snapshots.length > 0) {
    const last = snapshots[snapshots.length - 1];
    if (isSameSnapshot(last, snapshot)) {
      return;
    }
  }

  snapshots.push(snapshot);

  if (snapshots.length > settings.maxSnapshots) {
    snapshots = snapshots.slice(snapshots.length - settings.maxSnapshots);
  }

  by[profileId] = snapshots;
  await chrome.storage.local.set({ snapshotsByProfile: by });
}

function isSameSnapshot(a, b) {
  if (a.tabCount !== b.tabCount || a.windowCount !== b.windowCount) return false;

  const urlsA = new Set();
  const urlsB = new Set();
  for (const w of a.windows) for (const t of w.tabs) urlsA.add(t.url);
  for (const w of b.windows) for (const t of w.tabs) urlsB.add(t.url);

  if (urlsA.size !== urlsB.size) return false;
  for (const url of urlsA) {
    if (!urlsB.has(url)) return false;
  }
  return true;
}

async function getSnapshots() {
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = data.snapshotsByProfile || {};
  return by[profileId] || [];
}

async function deleteSnapshot(snapshotId) {
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = { ...(data.snapshotsByProfile || {}) };
  by[profileId] = (by[profileId] || []).filter((s) => s.id !== snapshotId);
  await chrome.storage.local.set({ snapshotsByProfile: by });
}

async function clearAllSnapshots() {
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = { ...(data.snapshotsByProfile || {}) };
  by[profileId] = [];
  await chrome.storage.local.set({ snapshotsByProfile: by });
}

async function trimSnapshotsToHalf() {
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = { ...(data.snapshotsByProfile || {}) };
  let list = by[profileId] || [];
  if (list.length <= 1) return { removed: 0, remaining: list.length };

  const keep = Math.max(1, Math.ceil(list.length / 2));
  const removed = list.length - keep;
  list = list.slice(-keep);
  by[profileId] = list;
  await chrome.storage.local.set({ snapshotsByProfile: by });
  rebuildContextMenusImmediate();
  return { removed, remaining: list.length };
}

async function getStorageHealth() {
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const { profiles } = await getProfilesState();
  const snaps = await getSnapshots();

  let bytesInUse = 0;
  try {
    bytesInUse = await chrome.storage.local.getBytesInUse(null);
  } catch {
    bytesInUse = 0;
  }

  let oldestIso = null;
  if (snaps.length > 0) {
    const oldest = snaps.reduce((a, b) =>
      new Date(a.timestamp) < new Date(b.timestamp) ? a : b
    );
    oldestIso = oldest.timestamp;
  }

  const prof = profiles.find((p) => p.id === profileId);
  return {
    bytesInUse,
    snapshotCount: snaps.length,
    oldestSnapshotIso: oldestIso,
    activeProfileId: profileId,
    activeProfileName: prof?.name || "Work",
  };
}

// ─── Profiles API ───────────────────────────────────────────────────────

async function listProfiles() {
  const { profiles } = await getProfilesState();
  return profiles;
}

async function createProfile(name) {
  await ensureProfilesMigrated();
  const state = await getProfilesState();
  const id = `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const trimmed = (name || "Workspace").trim().slice(0, 64) || "Workspace";
  const profiles = sortWorkspaceProfiles([
    ...state.profiles,
    { id, name: trimmed, createdAt: new Date().toISOString() },
  ]);
  const snapshotsByProfile = { ...state.snapshotsByProfile, [id]: [] };
  await chrome.storage.local.set({ profiles, snapshotsByProfile, activeProfileId: id });
  rebuildContextMenusImmediate();
  return { id, name: trimmed };
}

async function renameProfile(profileId, name) {
  if (profileId === PROFILE_PERSONAL_ID || profileId === PROFILE_WORK_ID) {
    throw new Error("Personal and Work cannot be renamed");
  }
  const state = await getProfilesState();
  const trimmed = (name || "").trim().slice(0, 64);
  if (!trimmed) throw new Error("Name required");
  const profiles = sortWorkspaceProfiles(
    state.profiles.map((p) => (p.id === profileId ? { ...p, name: trimmed } : p))
  );
  await chrome.storage.local.set({ profiles });
  rebuildContextMenusImmediate();
}

async function setActiveProfile(profileId) {
  const state = await getProfilesState();
  if (!state.profiles.some((p) => p.id === profileId)) throw new Error("Profile not found");
  const snapshotsByProfile = { ...state.snapshotsByProfile };
  if (!snapshotsByProfile[profileId]) snapshotsByProfile[profileId] = [];
  await chrome.storage.local.set({ activeProfileId: profileId, snapshotsByProfile });
  rebuildContextMenusImmediate();
}

async function deleteProfile(profileId) {
  if (profileId === PROFILE_PERSONAL_ID || profileId === PROFILE_WORK_ID) {
    throw new Error("Personal and Work cannot be deleted");
  }
  const state = await getProfilesState();
  if (state.profiles.length <= 2) throw new Error("Personal and Work must stay; remove extra workspaces first");
  if (!state.profiles.some((p) => p.id === profileId)) throw new Error("Profile not found");

  const profiles = sortWorkspaceProfiles(state.profiles.filter((p) => p.id !== profileId));
  const snapshotsByProfile = { ...state.snapshotsByProfile };
  delete snapshotsByProfile[profileId];

  let activeProfileId = state.activeProfileId;
  if (activeProfileId === profileId) {
    activeProfileId =
      profiles.find((p) => p.id === PROFILE_WORK_ID)?.id ||
      profiles.find((p) => p.id === PROFILE_PERSONAL_ID)?.id ||
      profiles[0].id;
  }

  await chrome.storage.local.set({ profiles, snapshotsByProfile, activeProfileId });
  rebuildContextMenusImmediate();
  return { activeProfileId };
}

// ─── Restore ────────────────────────────────────────────────────────────

/** Block dangerous URL schemes when reopening tabs from a snapshot (imported JSON can be hostile). */
function isAllowedRestoreUrl(url) {
  if (!url || typeof url !== "string") return false;
  const s = url.trim();
  if (!s) return false;
  const lower = s.slice(0, 16).toLowerCase();
  if (lower.startsWith("javascript:")) return false;
  if (lower.startsWith("vbscript:")) return false;
  if (lower.startsWith("data:text/html")) return false;
  return true;
}

async function restoreSnapshot(snapshotId) {
  return restoreSnapshotForProfile(await getActiveProfileId(), snapshotId);
}

async function restoreSnapshotForProfile(profileId, snapshotId) {
  await ensureProfilesMigrated();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = data.snapshotsByProfile || {};
  const snapshots = by[profileId] || [];
  const snapshot = snapshots.find((s) => s.id === snapshotId);
  if (!snapshot) throw new Error("Snapshot not found");

  for (const win of snapshot.windows) {
    const tabsToOpen = (win.tabs || [])
      .filter((t) => t && isAllowedRestoreUrl(t.url))
      .map((t) => ({ url: t.url, pinned: !!t.pinned }));
    if (tabsToOpen.length === 0) continue;

    const newWin = await chrome.windows.create({ url: tabsToOpen[0].url });

    for (let i = 1; i < tabsToOpen.length; i++) {
      await chrome.tabs.create({
        windowId: newWin.id,
        url: tabsToOpen[i].url,
        active: false,
      });
    }

    const createdTabs = await chrome.tabs.query({ windowId: newWin.id });
    for (let i = 0; i < Math.min(createdTabs.length, tabsToOpen.length); i++) {
      if (tabsToOpen[i].pinned && createdTabs[i]?.id != null) {
        await chrome.tabs.update(createdTabs[i].id, { pinned: true });
      }
    }
  }

  return snapshot;
}

// ─── Settings ───────────────────────────────────────────────────────────

function clampBackupIntervalMinutes(n) {
  const v = parseInt(String(n), 10);
  if (Number.isNaN(v)) return DEFAULT_SETTINGS.autoBackupInterval;
  return Math.min(MAX_BACKUP_INTERVAL_MIN, Math.max(MIN_BACKUP_INTERVAL_MIN, v));
}

function clampMaxSnapshots(n) {
  const v = parseInt(String(n), 10);
  if (Number.isNaN(v)) return DEFAULT_SETTINGS.maxSnapshots;
  return Math.min(MAX_MAX_SNAPSHOTS, Math.max(MIN_MAX_SNAPSHOTS, v));
}

/** Trim stored snapshot lists if they exceed the new limit (e.g. after lowering max). */
async function capSnapshotsStorageToLimit(limit) {
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = { ...(data.snapshotsByProfile || {}) };
  let changed = false;
  for (const k of Object.keys(by)) {
    const arr = by[k] || [];
    if (arr.length > limit) {
      by[k] = arr.slice(-limit);
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ snapshotsByProfile: by });
  }
}

async function loadSettings() {
  const now = Date.now();
  if (now - settingsCacheTime < SETTINGS_CACHE_MS) {
    return;
  }
  settingsCacheTime = now;
  const data = await chrome.storage.local.get(["settings"]);
  const merged = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  let dirty = false;
  if (typeof merged.enabled !== "boolean") {
    merged.enabled = true;
    dirty = true;
  }
  const beforeInterval = merged.autoBackupInterval;
  merged.autoBackupInterval = clampBackupIntervalMinutes(beforeInterval);
  if (merged.autoBackupInterval !== beforeInterval) {
    dirty = true;
  }
  const beforeMaxSnaps = merged.maxSnapshots;
  merged.maxSnapshots = clampMaxSnapshots(beforeMaxSnaps);
  if (merged.maxSnapshots !== beforeMaxSnaps) {
    dirty = true;
  }
  settings = merged;
  if (dirty) {
    await chrome.storage.local.set({ settings: merged });
    await setupAlarm();
  }
  if (merged.maxSnapshots !== beforeMaxSnaps) {
    await capSnapshotsStorageToLimit(merged.maxSnapshots);
  }
}

function invalidateSettingsCache() {
  settingsCacheTime = 0;
}

const ALLOWED_SETTING_KEYS = new Set([
  "enabled",
  "autoBackupInterval",
  "backupOnTabChange",
  "debounceMs",
  "dedupeOnOpen",
  "maxSnapshots",
]);

async function updateSettings(newSettings) {
  if (!newSettings || typeof newSettings !== "object") return;

  const patch = {};
  for (const k of Object.keys(newSettings)) {
    if (ALLOWED_SETTING_KEYS.has(k)) patch[k] = newSettings[k];
  }

  const prevMaxSnapshots = settings.maxSnapshots;
  settings = { ...settings, ...patch };
  if (patch.autoBackupInterval != null) {
    settings.autoBackupInterval = clampBackupIntervalMinutes(patch.autoBackupInterval);
  }
  if (patch.maxSnapshots != null) {
    settings.maxSnapshots = clampMaxSnapshots(patch.maxSnapshots);
    if (settings.maxSnapshots < prevMaxSnapshots) {
      await capSnapshotsStorageToLimit(settings.maxSnapshots);
    }
  }
  invalidateSettingsCache();
  await chrome.storage.local.set({ settings });
  await setupAlarm();
}

// ─── Feature: Tab Time Tracking ────────────────────────────────────────
// Tracks time spent per domain across sessions using snapshot timestamps + active-tab events.

let activeTabStartTime = Date.now();
let activeTabDomain = null;

function domainFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "chrome:" || u.protocol === "chrome-extension:" || u.protocol === "about:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch { return null; }
}

async function flushTimeForDomain(domain, ms) {
  if (!domain || ms < 1000) return;
  const data = await chrome.storage.local.get(["tabTimeToday"]);
  const today = new Date().toISOString().slice(0, 10);
  const record = data.tabTimeToday || { date: today, domains: {} };
  if (record.date !== today) { record.date = today; record.domains = {}; }
  record.domains[domain] = (record.domains[domain] || 0) + ms;
  await chrome.storage.local.set({ tabTimeToday: record });
}

chrome.tabs.onActivated.addListener(async (info) => {
  const now = Date.now();
  await flushTimeForDomain(activeTabDomain, now - activeTabStartTime);
  activeTabStartTime = now;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    activeTabDomain = domainFromUrl(tab.url || "");
  } catch { activeTabDomain = null; }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    const now = Date.now();
    await flushTimeForDomain(activeTabDomain, now - activeTabStartTime);
    activeTabStartTime = now;
    activeTabDomain = domainFromUrl(tab.url || "");
  }
});

async function getTabTimeToday() {
  const data = await chrome.storage.local.get(["tabTimeToday"]);
  const today = new Date().toISOString().slice(0, 10);
  const record = data.tabTimeToday || { date: today, domains: {} };
  if (record.date !== today) return { date: today, domains: {} };
  return record;
}

// ─── Feature: AI Tab Summary (cluster-based, no API key required) ───────
// Groups open tabs into topic clusters by domain/keyword heuristics and
// produces a human-readable summary sentence per cluster.

const CLUSTER_RULES = [
  { label: "Coding & Dev Tools",  patterns: ["github.com","stackoverflow.com","developer.","docs.","localhost","127.0.0.1","codepen.io","jsfiddle.net","replit.com","codesandbox.io","npmjs.com","pypi.org","devdocs.io"] },
  { label: "Work & Productivity", patterns: ["notion.so","asana.com","trello.com","jira","confluence","linear.app","monday.com","airtable.com","clickup.com","basecamp.com","todoist.com","slack.com","teams.microsoft.com","meet.google.com","zoom.us","calendar.google.com","mail.google.com","outlook."] },
  { label: "Research & Reading",  patterns: ["wikipedia.org","medium.com","substack.com","arxiv.org","scholar.google","researchgate.net","jstor.org","semanticscholar.org","nature.com","sciencedirect.com","hn.algolia","news.ycombinator.com","reddit.com"] },
  { label: "Video & Entertainment",patterns: ["youtube.com","netflix.com","primevideo.com","hotstar.com","twitch.tv","vimeo.com","dailymotion.com","spotify.com","soundcloud.com","music.youtube.com"] },
  { label: "Shopping",            patterns: ["amazon.","flipkart.com","myntra.com","snapdeal.com","meesho.com","ebay.","etsy.com","shopify.","bigbasket.com","swiggy.com","zomato.com"] },
  { label: "Finance & Banking",   patterns: ["bank","finance","trading","zerodha.com","groww.in","moneycontrol.com","nseindia.com","bseindia.com","paytm.com","phonepe.com"] },
  { label: "Social Media",        patterns: ["twitter.com","x.com","facebook.com","instagram.com","linkedin.com","threads.net","mastodon","pinterest.com","snapchat.com"] },
  { label: "News",                patterns: ["bbc.com","cnn.com","ndtv.com","thehindu.com","hindustantimes.com","livemint.com","economictimes.","techcrunch.com","theverge.com","wired.com","arstechnica.com"] },
  { label: "Cloud & Storage",     patterns: ["drive.google.com","docs.google.com","sheets.google.com","slides.google.com","dropbox.com","onedrive.live.com","box.com","icloud.com"] },
  { label: "Learning & Courses",  patterns: ["udemy.com","coursera.org","edx.org","khanacademy.org","pluralsight.com","skillshare.com","brilliant.org","codecademy.com","freecodecamp.org"] },
];

function clusterTabs(tabs) {
  const clusters = {};
  const uncategorized = [];

  for (const tab of tabs) {
    const domain = domainFromUrl(tab.url) || "";
    const titleLower = (tab.title || "").toLowerCase();
    const fullStr = domain + " " + titleLower;
    let matched = false;
    for (const rule of CLUSTER_RULES) {
      if (rule.patterns.some((p) => fullStr.includes(p))) {
        if (!clusters[rule.label]) clusters[rule.label] = [];
        clusters[rule.label].push(tab);
        matched = true;
        break;
      }
    }
    if (!matched) uncategorized.push(tab);
  }

  // Group uncategorized by domain
  for (const tab of uncategorized) {
    const domain = domainFromUrl(tab.url) || "Other";
    if (!clusters[domain]) clusters[domain] = [];
    clusters[domain].push(tab);
  }

  return clusters;
}

function buildAiSummary(tabs) {
  if (!tabs || tabs.length === 0) return "No browsable tabs open right now.";
  const clusters = clusterTabs(tabs);
  const lines = [];
  for (const [label, items] of Object.entries(clusters)) {
    if (items.length === 1) {
      lines.push(`${label}: "${items[0].title || items[0].url}"`);
    } else {
      const titles = items.slice(0, 3).map((t) => `"${(t.title || t.url).slice(0, 40)}"`).join(", ");
      const more = items.length > 3 ? ` +${items.length - 3} more` : "";
      lines.push(`${label} (${items.length} tabs): ${titles}${more}`);
    }
  }
  return lines.join("\n");
}

async function getAiTabSummary() {
  const windows = await chrome.windows.getAll({ populate: true });
  const tabs = [];
  for (const win of windows) {
    if (win.type !== "normal") continue;
    for (const tab of (win.tabs || [])) {
      const url = tab.url || "";
      if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:") || url.startsWith("edge://")) continue;
      tabs.push(tab);
    }
  }
  const summary = buildAiSummary(tabs);
  const clusters = clusterTabs(tabs);
  return { summary, clusters: Object.entries(clusters).map(([label, items]) => ({ label, count: items.length, titles: items.map((t) => t.title || t.url) })), totalTabs: tabs.length };
}

// ─── Feature: Park Mode (git stash for browser) ─────────────────────────
// Save all current tabs as a named snapshot, then close them.

async function parkSession(name) {
  const trimmedName = (name || "Parked Session").trim().slice(0, 80);
  const windows = await chrome.windows.getAll({ populate: true });
  const snapshot = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    trigger: "park",
    name: trimmedName,
    parked: true,
    windowCount: 0,
    tabCount: 0,
    windows: [],
  };

  const windowsToClose = [];
  for (const win of windows) {
    if (win.type !== "normal") continue;
    const windowData = { id: win.id, focused: win.focused, state: win.state, tabs: [] };
    for (const tab of (win.tabs || [])) {
      const url = tab.url || "";
      if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:") || url.startsWith("edge://")) continue;
      windowData.tabs.push({ url: tab.url, title: tab.title || "(Untitled)", favIconUrl: tab.favIconUrl || "", pinned: tab.pinned, index: tab.index });
    }
    if (windowData.tabs.length > 0) {
      snapshot.windows.push(windowData);
      snapshot.tabCount += windowData.tabs.length;
      windowsToClose.push(win.id);
    }
  }
  snapshot.windowCount = snapshot.windows.length;
  if (snapshot.tabCount === 0) throw new Error("No tabs to park");

  // Save snapshot first
  await ensureProfilesMigrated();
  const profileId = await getActiveProfileId();
  const data = await chrome.storage.local.get(["snapshotsByProfile"]);
  const by = { ...(data.snapshotsByProfile || {}) };
  let snapshots = by[profileId] || [];
  snapshots.push(snapshot);
  if (snapshots.length > settings.maxSnapshots) snapshots = snapshots.slice(snapshots.length - settings.maxSnapshots);
  by[profileId] = snapshots;
  await chrome.storage.local.set({ snapshotsByProfile: by });

  // Open a new empty tab so Chrome doesn't quit, then close all parked windows
  await chrome.tabs.create({ url: "chrome://newtab" });
  for (const winId of windowsToClose) {
    try { await chrome.windows.remove(winId); } catch { /* already closed */ }
  }
  rebuildContextMenusImmediate();
  return { tabCount: snapshot.tabCount, windowCount: snapshot.windowCount, name: trimmedName, id: snapshot.id };
}

// ─── Feature: Monday Morning Context Restore ────────────────────────────
// On startup, check if today is Monday and last snapshot was Friday → offer restore.

function dayOfWeek(isoString) {
  try { return new Date(isoString).getDay(); } catch { return -1; }
}

async function getMondayMorningContext() {
  const now = new Date();
  const todayDay = now.getDay(); // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
  const snaps = await getSnapshots();
  if (snaps.length === 0) return null;

  const lastSnap = snaps[snaps.length - 1];
  const lastDay = dayOfWeek(lastSnap.timestamp);
  const lastDate = lastSnap.timestamp.slice(0, 10);
  const todayDate = now.toISOString().slice(0, 10);

  // Show if: today is Mon/Tue and last snapshot was Thu/Fri/Sat/Sun (weekend gap)
  const isAfterWeekend = (todayDay === 1 || todayDay === 2) && (lastDay >= 4 || lastDay === 0);
  const isDifferentDay = lastDate !== todayDate;

  if (!isAfterWeekend || !isDifferentDay) return null;

  const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const clusters = clusterTabs(
    (lastSnap.windows || []).flatMap((w) => w.tabs || []).map((t) => ({ url: t.url, title: t.title }))
  );
  const clusterSummary = Object.entries(clusters).slice(0, 3).map(([label, items]) => `${label} (${items.length})`).join(", ");
  const summary = clusterSummary
    ? `Last ${dayNames[lastDay]} you had ${lastSnap.tabCount} tabs: ${clusterSummary}.`
    : `Last ${dayNames[lastDay]} you had ${lastSnap.tabCount} tabs open.`;

  return {
    snapshotId: lastSnap.id,
    lastDay: dayNames[lastDay],
    lastDate,
    tabCount: lastSnap.tabCount,
    summary,
  };
}

// ─── Badge ──────────────────────────────────────────────────────────────

function setBadgeTabCount(count) {
  try {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#0077C5" });
  } catch {
    /* ignore */
  }
}

/** Prefer setBadgeTabCount from takeSnapshot to avoid a second full tabs query. */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(
      (t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://")
    ).length;
    setBadgeTabCount(count);
  } catch {
    /* ignore */
  }
}

/**
 * Debounced menu rebuild after background activity (auto-save, alarms).
 * User-driven actions call rebuildContextMenusImmediate() instead.
 */
function scheduleMenuRebuild() {
  if (menuRebuildTimer) clearTimeout(menuRebuildTimer);
  menuRebuildTimer = setTimeout(() => {
    menuRebuildTimer = null;
    void rebuildContextMenus();
  }, MENU_REBUILD_DEBOUNCE_MS);
}

function rebuildContextMenusImmediate() {
  if (menuRebuildTimer) {
    clearTimeout(menuRebuildTimer);
    menuRebuildTimer = null;
  }
  lastContextMenuSig = "";
  void rebuildContextMenus();
}

// ─── Toolbar (extension icon) context menu ──────────────────────────────

function formatMenuTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function rebuildContextMenus() {
  await loadSettings();
  await ensureProfilesMigrated();

  const snaps = await getSnapshots();
  const recent = snaps.slice(-3);
  const sig = `${settings.dedupeOnOpen}|${recent.map((s) => s.id).join(",")}`;
  if (sig === lastContextMenuSig) {
    return;
  }
  lastContextMenuSig = sig;

  try {
    await chrome.contextMenus.removeAll();
  } catch {
    /* ignore */
  }

  chrome.contextMenus.create({
    id: "tg-save",
    title: "Save snapshot now",
    contexts: ["action"],
  });

  const recentForMenu = recent.slice().reverse();

  if (recentForMenu.length > 0) {
    chrome.contextMenus.create({
      id: "tg-recent-sep",
      type: "separator",
      contexts: ["action"],
    });
  }

  recentForMenu.forEach((s, i) => {
    const label = `${i + 1}. ${formatMenuTime(s.timestamp)} · ${s.tabCount} tabs`;
    chrome.contextMenus.create({
      id: `tg-restore-${s.id}`,
      title: label.slice(0, 120),
      contexts: ["action"],
    });
  });

  chrome.contextMenus.create({
    id: "tg-dedupe-sep",
    type: "separator",
    contexts: ["action"],
  });

  chrome.contextMenus.create({
    id: "tg-dedupe",
    title: settings.dedupeOnOpen ? "Turn off duplicate tab avoidance" : "Turn on duplicate tab avoidance",
    contexts: ["action"],
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  await loadSettings();
  await ensureProfilesMigrated();

  if (info.menuItemId === "tg-save") {
    await takeSnapshot("manual");
    rebuildContextMenusImmediate();
    return;
  }

  if (info.menuItemId === "tg-dedupe") {
    settings.dedupeOnOpen = !settings.dedupeOnOpen;
    await updateSettings({ dedupeOnOpen: settings.dedupeOnOpen });
    rebuildContextMenusImmediate();
    return;
  }

  const rid = String(info.menuItemId);
  if (rid.startsWith("tg-restore-")) {
    const snapshotId = rid.slice("tg-restore-".length);
    try {
      await restoreSnapshot(snapshotId);
    } catch (e) {
      console.warn("[BrainCache] Restore from menu failed:", e);
    }
  }
});

// ─── Keyboard shortcuts ─────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  await loadSettings();
  await ensureProfilesMigrated();

  if (command === "save-snapshot") {
    await takeSnapshot("manual");
    rebuildContextMenusImmediate();
    return;
  }

  if (command === "toggle-dedupe") {
    settings.dedupeOnOpen = !settings.dedupeOnOpen;
    await updateSettings({ dedupeOnOpen: settings.dedupeOnOpen });
    rebuildContextMenusImmediate();
    return;
  }

  if (command === "open-popup") {
    try {
      await chrome.action.openPopup();
    } catch {
      /* may fail if popup cannot open in this context */
    }
  }
});

// ─── Message Handler (for popup communication) ──────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case "getSnapshots":
          sendResponse({ success: true, data: await getSnapshots() });
          break;

        case "takeSnapshot": {
          const snap = await takeSnapshot("manual");
          rebuildContextMenusImmediate();
          sendResponse({ success: true, data: snap });
          break;
        }

        case "restoreSnapshot":
          await restoreSnapshot(msg.snapshotId);
          sendResponse({ success: true });
          break;

        case "deleteSnapshot":
          await deleteSnapshot(msg.snapshotId);
          rebuildContextMenusImmediate();
          sendResponse({ success: true });
          break;

        case "clearAll":
          await clearAllSnapshots();
          rebuildContextMenusImmediate();
          sendResponse({ success: true });
          break;

        case "getSettings":
          await loadSettings();
          sendResponse({ success: true, data: settings });
          break;

        case "updateSettings":
          await updateSettings(msg.settings);
          rebuildContextMenusImmediate();
          sendResponse({ success: true });
          break;

        case "exportAll": {
          const allSnaps = await getSnapshots();
          sendResponse({ success: true, data: allSnaps });
          break;
        }

        case "exportAllWorkspaces": {
          await ensureProfilesMigrated();
          const raw = await chrome.storage.local.get(["profiles", "snapshotsByProfile", "activeProfileId"]);
          sendResponse({
            success: true,
            data: {
              version: 2,
              exportedAt: new Date().toISOString(),
              profiles: raw.profiles || [],
              activeProfileId: raw.activeProfileId,
              snapshotsByProfile: raw.snapshotsByProfile || {},
            },
          });
          break;
        }

        case "importSnapshots": {
          await ensureProfilesMigrated();
          const profileId = await getActiveProfileId();
          const data = await chrome.storage.local.get(["snapshotsByProfile"]);
          const by = { ...(data.snapshotsByProfile || {}) };
          let existing = by[profileId] || [];
          let incoming = msg.snapshots;

          if (incoming && typeof incoming === "object" && !Array.isArray(incoming) && incoming.snapshotsByProfile) {
            const mergeProfiles = !!msg.mergeAllWorkspaces;
            if (mergeProfiles) {
              const profMap = new Map((await getProfilesState()).profiles.map((p) => [p.id, p]));
              for (const p of incoming.profiles || []) {
                if (!profMap.has(p.id)) profMap.set(p.id, p);
              }
              for (const pid of Object.keys(incoming.snapshotsByProfile || {})) {
                if (!profMap.has(pid)) {
                  profMap.set(pid, {
                    id: pid,
                    name: "Imported",
                    createdAt: new Date().toISOString(),
                  });
                }
              }
              const profiles = Array.from(profMap.values());
              const mergedBy = { ...by };
              for (const [pid, snaps] of Object.entries(incoming.snapshotsByProfile || {})) {
                const cur = mergedBy[pid] || [];
                const seen = new Set(cur.map((s) => s.id));
                const add = (Array.isArray(snaps) ? snaps : []).filter((s) => {
                  if (seen.has(s.id)) return false;
                  seen.add(s.id);
                  return true;
                });
                mergedBy[pid] = [...cur, ...add].slice(-settings.maxSnapshots);
              }
              await chrome.storage.local.set({ profiles, snapshotsByProfile: mergedBy });
              rebuildContextMenusImmediate();
              sendResponse({ success: true, count: Object.keys(incoming.snapshotsByProfile || {}).length });
              break;
            }
            const aid = incoming.activeProfileId;
            let fromFile = [];
            if (aid && Array.isArray(incoming.snapshotsByProfile[aid])) {
              fromFile = incoming.snapshotsByProfile[aid];
            } else {
              const vals = Object.values(incoming.snapshotsByProfile || {});
              fromFile = vals.find((a) => Array.isArray(a)) || [];
            }
            incoming = fromFile;
          }

          if (!Array.isArray(incoming)) {
            sendResponse({ success: false, error: "Invalid backup file" });
            break;
          }

          const seen = new Set(existing.map((s) => s.id));
          const deduped = incoming.filter((s) => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
          });
          const merged = [...existing, ...deduped];
          const trimmed = merged.slice(-settings.maxSnapshots);
          by[profileId] = trimmed;
          await chrome.storage.local.set({ snapshotsByProfile: by });
          rebuildContextMenusImmediate();
          sendResponse({ success: true, count: incoming.length });
          break;
        }

        case "getProfiles":
          sendResponse({ success: true, data: await listProfiles() });
          break;

        case "getActiveProfileId":
          sendResponse({ success: true, data: await getActiveProfileId() });
          break;

        case "setActiveProfile":
          await setActiveProfile(msg.profileId);
          sendResponse({ success: true });
          break;

        case "createProfile":
          sendResponse({ success: true, data: await createProfile(msg.name) });
          break;

        case "renameProfile":
          await renameProfile(msg.profileId, msg.name);
          sendResponse({ success: true });
          break;

        case "deleteProfile": {
          const r = await deleteProfile(msg.profileId);
          sendResponse({ success: true, data: r });
          break;
        }

        case "getStorageHealth":
          sendResponse({ success: true, data: await getStorageHealth() });
          break;

        case "trimSnapshots":
          sendResponse({ success: true, data: await trimSnapshotsToHalf() });
          break;

        // ── New features ──────────────────────────────────────────────
        case "getAiSummary":
          sendResponse({ success: true, data: await getAiTabSummary() });
          break;

        case "getTabTimeToday":
          sendResponse({ success: true, data: await getTabTimeToday() });
          break;

        case "parkSession": {
          const parkResult = await parkSession(msg.name);
          sendResponse({ success: true, data: parkResult });
          break;
        }

        case "getMondayContext":
          sendResponse({ success: true, data: await getMondayMorningContext() });
          break;

        case "getClusterSummary": {
          const summaryData = await getAiTabSummary();
          sendResponse({ success: true, data: summaryData });
          break;
        }

        default:
          sendResponse({ success: false, error: "Unknown action" });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});
