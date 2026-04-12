import { useState, useMemo, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from "recharts";

// ─── GOOGLE DRIVE CONFIG ─────────────────────────────────────────────────────
// Fill these in before deploying. The redirect URI must match exactly what's
// registered in your Google Cloud OAuth 2.0 client settings.
const GDRIVE_CLIENT_ID           = 544563624941-l52hjuuh8ovmuc3an7umdhkbk3g9urlr.apps.googleusercontent.com";
const GDRIVE_CLIENT_SECRET       = "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";
const GDRIVE_REDIRECT_URI        = "https://qbkinc.github.io/EMAW/";
const GDRIVE_SHARED_REFRESH_TOKEN = "1//05GUApu0N4K8tCgYIARAAGAUSNwF-L9IriflH3t43jsMk8Dqd22RcJu99tJoPD_0_Y1s4lBSdaT7uls4BkKX8Yk__lKuvnvGbSgk";
const GDRIVE_FILE_NAME = "emaw_data_backup.json";
const GDRIVE_SCOPES    = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file";

// ─── GDRIVE: TOKEN MANAGEMENT ────────────────────────────────────────────────

// Cache an access token in sessionStorage so we don't re-fetch on every call
function _getCachedToken() {
  try {
    const t = sessionStorage.getItem("gdrive_access_token");
    const exp = sessionStorage.getItem("gdrive_token_expiry");
    if (t && exp && Date.now() < Number(exp) - 60000) return t;
  } catch {}
  return null;
}
function _setCachedToken(token, expiresInSeconds) {
  try {
    sessionStorage.setItem("gdrive_access_token", token);
    sessionStorage.setItem("gdrive_token_expiry", String(Date.now() + expiresInSeconds * 1000));
  } catch {}
}
function _clearCachedToken() {
  try {
    sessionStorage.removeItem("gdrive_access_token");
    sessionStorage.removeItem("gdrive_token_expiry");
    sessionStorage.removeItem("gdrive_user_refresh_token");
  } catch {}
}

// Refresh using ANY refresh token (shared or user-specific)
async function _refreshWithToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     GDRIVE_CLIENT_ID,
      client_secret: GDRIVE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed");
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  _setCachedToken(data.access_token, data.expires_in || 3600);
  return data.access_token;
}

// Returns a valid access token (user token preferred, shared token fallback)
async function getValidAccessToken() {
  const cached = _getCachedToken();
  if (cached) return cached;
  // Try user-specific refresh token first
  try {
    const userRT = sessionStorage.getItem("gdrive_user_refresh_token");
    if (userRT) return await _refreshWithToken(userRT);
  } catch {}
  // Fallback to shared token
  return await getSharedAccessToken();
}

// Returns a valid access token using the shared (baked-in) refresh token
async function getSharedAccessToken() {
  try {
    return await _refreshWithToken(GDRIVE_SHARED_REFRESH_TOKEN);
  } catch (e) {
    throw new Error("Shared token refresh failed: " + e.message);
  }
}

// ─── GDRIVE: OAUTH FLOW ───────────────────────────────────────────────────────

function startGoogleOAuth() {
  const params = new URLSearchParams({
    client_id:     GDRIVE_CLIENT_ID,
    redirect_uri:  GDRIVE_REDIRECT_URI,
    response_type: "code",
    scope:         GDRIVE_SCOPES,
    access_type:   "offline",
    prompt:        "consent",
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Call this on page load to detect and process the OAuth ?code= callback
async function handleGoogleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;
  // Exchange code for tokens
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     GDRIVE_CLIENT_ID,
      client_secret: GDRIVE_CLIENT_SECRET,
      redirect_uri:  GDRIVE_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  // Store refresh token for this user session
  if (data.refresh_token) {
    sessionStorage.setItem("gdrive_user_refresh_token", data.refresh_token);
  }
  _setCachedToken(data.access_token, data.expires_in || 3600);
  // Clean ?code= from URL without reloading
  const cleanUrl = window.location.href.split("?")[0];
  window.history.replaceState({}, document.title, cleanUrl);
  return data.access_token;
}

// ─── GDRIVE: FILE OPERATIONS ──────────────────────────────────────────────────

async function _findGDriveFile(accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${GDRIVE_FILE_NAME}'&fields=files(id,name,modifiedTime)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return data.files?.[0] || null;
}

// Push all local data to Google Drive (overwrites the file)
async function syncToGDrive(payload) {
  const accessToken = await getValidAccessToken();
  const existing = await _findGDriveFile(accessToken);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  let url, method;
  if (existing) {
    url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`;
    method = "PATCH";
  } else {
    // Create in appDataFolder (hidden from user's Drive UI)
    const meta = JSON.stringify({ name: GDRIVE_FILE_NAME, parents: ["appDataFolder"] });
    const form = new FormData();
    form.append("metadata", new Blob([meta], { type: "application/json" }));
    form.append("file", blob);
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    return await res.json();
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload, null, 2),
  });
  return await res.json();
}

// Pull data from Google Drive; returns parsed JSON or null
async function syncFromGDrive() {
  const accessToken = await getValidAccessToken();
  const file = await _findGDriveFile(accessToken);
  if (!file) return null;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  return await res.json();
}

// ─── DATE HELPER ─────────────────────────────────────────────────────────────
// Always returns today's date in LOCAL timezone as YYYY-MM-DD
// (avoids UTC rollover issue where toISOString() returns tomorrow after ~7pm EST)
function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── SERVER STORAGE HELPERS ───────────────────────────────────────────────────
// All data is stored in emaw_data.json on the host PC via a local Express server.
// Every device on the same WiFi shares the same data automatically.
// Falls back to localStorage if the server is unreachable.

// Use whatever host the browser loaded the app from, but port 3001 for the data server.
// This means http://192.168.1.x:3000 on a phone automatically calls 192.168.1.x:3001.
// On your PC, window.location.hostname is "localhost" so it calls localhost:3001 as before.
const API = `http://${window.location.hostname}:3001/api/data`;

// In-memory cache so we don't hit the server on every render
const _cache = {};

function load(key, fallback) {
  // Return from cache if available (populated by loadAllData)
  return key in _cache ? _cache[key] : fallback;
}

function save(key, val) {
  _cache[key] = val;
  // Fire-and-forget POST to server
  fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value: val })
  }).catch(() => {
    // Fallback to localStorage if server unreachable
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  });
  return true;
}

// Load ALL data from server in one request, populate cache, return it
async function loadAllData(seeds) {
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("Server error");
    const serverData = await res.json();

    // For each key: use server value if present, else seed
    // For locked roles: always patch to latest seed permissions
    const result = {};
    for (const [key, seed] of Object.entries(seeds)) {
      let val = (key in serverData) ? serverData[key] : null;
      if (val === null || val === undefined) {
        val = seed;
      } else if (Array.isArray(seed) && !Array.isArray(val)) {
        val = seed;
      }
      _cache[key] = val;
      result[key] = val;
    }

    // Patch locked roles to latest seed permissions
    if (result["emaw_roles_v3"]) {
      const SEED_ROLES_REF = seeds["emaw_roles_v3"];
      result["emaw_roles_v3"] = result["emaw_roles_v3"].map(r => {
        const seed = SEED_ROLES_REF.find(s => s.id === r.id);
        return (r.locked && seed) ? { ...r, permissions: seed.permissions } : r;
      });
      SEED_ROLES_REF.forEach(s => {
        if (!result["emaw_roles_v3"].find(r => r.id === s.id))
          result["emaw_roles_v3"].push(s);
      });
      _cache["emaw_roles_v3"] = result["emaw_roles_v3"];
    }

    // Seed any missing keys back to server
    const missing = {};
    for (const [key, seed] of Object.entries(seeds)) {
      if (!(key in serverData)) missing[key] = seed;
    }
    if (Object.keys(missing).length > 0) {
      fetch(`${API}/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: missing })
      }).catch(() => {});
    }

    return result;
  } catch {
    // Server unreachable — fall back to localStorage
    console.warn("EMAW: Data server unreachable, using localStorage fallback.");
    const result = {};
    for (const [key, seed] of Object.entries(seeds)) {
      try {
        const raw = localStorage.getItem(key);
        let val = raw ? JSON.parse(raw) : seed;
        if (Array.isArray(seed) && !Array.isArray(val)) val = seed;
        _cache[key] = val;
        result[key] = val;
      } catch { _cache[key] = seed; result[key] = seed; }
    }
    return result;
  }
}

// initStore kept for compatibility — just returns from cache
function initStore(key, seed) {
  return key in _cache ? _cache[key] : seed;
}

// ─── SEED DATA ────────────────────────────────────────────────────────────────
const SEED_MEMBERS = [
  { name: "Aaron Diaz", phone: "248-763-9871", email: "aaron_9812@icloud.com", group: "Delta" },
  { name: "Alex Espita", phone: "313-574-1011", email: "alexespitia09@gmail.com", group: "Bravo" },
  { name: "Anthony Freel", phone: "313-622-6632", email: null, group: "Foxtrot" },
  { name: "David King", phone: "313-506-9980", email: "arkk2600@icloud.com", group: "Alpha" },
  { name: "David Hornbeck", phone: "313-399-6957", email: null, group: "Foxtrot" },
  { name: "Derrick Parker", phone: "313-300-9629", email: "parker.j.derrick@gmail.com", group: "Charlie" },
  { name: "Duane Keene", phone: "989-332-9128", email: "duanekeene@gmail.com", group: "Foxtrot" },
  { name: "Emmanuel Huertas", phone: "313-310-9172", email: "ehuertas156@gmail.com", group: "Foxtrot" },
  { name: "Erick Castillo", phone: "313-804-6279", email: "castillo313erick@gmail.com", group: "Inactive" },
  { name: "Gene Begeman", phone: "313-573-7265", email: "genobegeman@gmail.com", group: "Alpha" },
  { name: "Greg Madden", phone: "989-329-7478", email: "maddenjgreg@gmail.com", group: "Bravo" },
  { name: "Greg Steckroat", phone: "734-558-9378", email: "kggsteck4@hotmail.com", group: "Alpha" },
  { name: "Hani Elajan", phone: "313-999-1998", email: "hani4301@yahoo.com", group: "Golf" },
  { name: "Henry Love", phone: null, email: null, group: "Inactive" },
  { name: "Homero Rodriguez", phone: "313-414-3102", email: "homero716@live.com", group: "Alpha" },
  { name: "Hugo Rodriguez", phone: null, email: null, group: "Golf" },
  { name: "Ismael Cortes", phone: "313-971-4511", email: "nyccortes@yahoo.com", group: "Golf" },
  { name: "Jared Miller", phone: "313-808-8049", email: null, group: "Foxtrot" },
  { name: "Jermaine Holloway", phone: "313-781-6147", email: "hallowayjermaine7@gmail.com", group: "Foxtrot" },
  { name: "John Mozug", phone: "734-775-1786", email: "jmozug@yahoo.com", group: "Bravo" },
  { name: "Jordan Browning", phone: "740-490-9434", email: null, group: "Foxtrot" },
  { name: "Jose Cortez", phone: "313-500-5763", email: null, group: "Delta" },
  { name: "Jose Salvador", phone: "313-200-8601", email: null, group: "Delta" },
  { name: "Joshua Floyd", phone: "313-859-1806", email: "joshfloyd1250@icloud.com", group: "Foxtrot" },
  { name: "Joshua Hudson", phone: "313-420-7328", email: null, group: "Charlie" },
  { name: "Juan Ponce", phone: "734-887-5639", email: null, group: "Foxtrot" },
  { name: "Julian Rodriguez", phone: "313-415-4870", email: null, group: "Inactive" },
  { name: "Liam Begeman", phone: null, email: null, group: "Delta" },
  { name: "Manny Begeman", phone: "313-234-3032", email: "emmanuelbegeman@gmail.com", group: "Delta" },
  { name: "Marino Rastelli", phone: "734-624-9031", email: "reason4everything@hotmail.com", group: "Bravo" },
  { name: "Mathias Ibarra", phone: "210-932-6117", email: null, group: "Echo" },
  { name: "Michael Reed", phone: "313-243-6103", email: "mikerezzy017@gmail.com", group: "Alpha" },
  { name: "Michael Vazquez", phone: "313-600-5286", email: null, group: "Echo" },
  { name: "Miguel Chapa", phone: "313-205-7862", email: null, group: "Golf" },
  { name: "Miguel Chapa III", phone: "313-518-7244", email: "miggy1396@gmail.com", group: "Delta" },
  { name: "Miguel Reyes", phone: "313-960-6494", email: "puerto_roc1975@yahoo.com", group: "Alpha" },
  { name: "Quran Karriem", phone: "313-799-2585", email: "quran@karriem.com", group: "Alpha" },
  { name: "Randy McMath", phone: "313-433-4990", email: "rohonly1@gmail.com", group: "Inactive" },
  { name: "Stefano Raimahda", phone: "734-231-5509", email: "stefanoraimahda@gmail.com", group: "Bravo" },
  { name: "Steve Szwed", phone: "313-952-4302", email: "stevenszwed@yahoo.com", group: "Charlie" },
  { name: "Thomas Karriem", phone: "734-887-9997", email: null, group: "Delta" },
  { name: "Walter Woelk", phone: "313-575-4528", email: "wbtterror@gmail.com", group: "Inactive" },
];

const SEED_GROUPS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
const SEED_FACILITATORS = {
  Alpha: "Quran Karriem", Bravo: "Miguel Reyes", Charlie: "Michael Reed",
  Delta: "Gene Begeman", Echo: "Greg Steckroat", Foxtrot: "David King", Golf: "Gene Begeman"
};
// Book/lesson progress per group: { book: 1, lesson: 1 }
const SEED_GROUP_PROGRESS = {
  Alpha: { book: 1, lesson: 4 }, Bravo: { book: 1, lesson: 4 }, Charlie: { book: 1, lesson: 4 },
  Delta: { book: 1, lesson: 3 }, Echo: { book: 1, lesson: 2 }, Foxtrot: { book: 1, lesson: 3 }, Golf: { book: 1, lesson: 2 }
};

const PALETTE = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#EC4899","#14B8A6","#F97316","#6366F1","#84CC16","#06B6D4","#A855F7"];

// ─── ROLES ────────────────────────────────────────────────────────────────────
// Permissions: dashboard, roster, sessions, manage, reports, security, takeAttendance, qtTracking, exportData, reminders
const SEED_ROLES = [
  { id: "superuser", name: "Superuser", permissions: ["dashboard","roster","sessions","historyEditor","progressGrid","manage","reports","security","takeAttendance","qtTracking","exportData","reminders","messaging"], locked: true },
  { id: "facilitator", name: "Facilitator", permissions: ["dashboard","roster","sessions","historyEditor","progressGrid","takeAttendance","qtTracking","messaging"], locked: false },
  { id: "viewer", name: "Viewer", permissions: ["dashboard","roster","sessions"], locked: false },
];
const ALL_PERMISSIONS = [
  { id: "dashboard",      label: "Dashboard" },
  { id: "roster",         label: "Roster" },
  { id: "sessions",       label: "Session History" },
  { id: "historyEditor",  label: "History Editor (edit/delete records)" },
  { id: "progressGrid",   label: "Progress Grid" },
  { id: "manage",         label: "Manage Members & Groups" },
  { id: "reports",        label: "Reports & Print" },
  { id: "security",       label: "Security & User Management" },
  { id: "takeAttendance", label: "Take Attendance" },
  { id: "qtTracking",     label: "Quiet Time / Scripture Tracking" },
  { id: "exportData",     label: "Export to Excel/CSV" },
  { id: "reminders",      label: "Attendance Reminders Tab" },
  { id: "messaging",      label: "Messaging (text/email members)" },
];

// Default superuser account
const SEED_APP_USERS = [
  { email: "admin@emaw.org", pin: "123456", roleId: "superuser", name: "Administrator", active: true }
];

const HISTORY = [
  { date: "2025-11-10", person: "Alex Espita", status: "P", group: "Bravo", book: 1, lesson: 7 },
  { date: "2025-11-10", person: "David King", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Gene Begeman", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "Greg Madden", status: "P", group: "Bravo", book: 1, lesson: 7 },
  { date: "2025-11-10", person: "Greg Steckroat", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "Homero Rodriguez", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "John Mozug", status: "P", group: "Bravo", book: 1, lesson: 7 },
  { date: "2025-11-10", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Joshua Hudson", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Julian Rodriguez", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Marino Rastelli", status: "P", group: "Bravo", book: 1, lesson: 7 },
  { date: "2025-11-10", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Miguel Reyes", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-10", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 1, lesson: 7 },
  { date: "2025-11-10", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Steven Davis", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-10", person: "Walter Woelk", status: "A", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-17", person: "Alex Espita", status: "P", group: "Bravo", book: 1, lesson: 8 },
  { date: "2025-11-17", person: "David King", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "Derrick Parker", status: "A", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-17", person: "Gene Begeman", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "Greg Madden", status: "P", group: "Bravo", book: 1, lesson: 8 },
  { date: "2025-11-17", person: "Greg Steckroat", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "Homero Rodriguez", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "John Mozug", status: "P", group: "Bravo", book: 1, lesson: 8 },
  { date: "2025-11-17", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-11-17", person: "Joshua Hudson", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-17", person: "Julian Rodriguez", status: "A", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-11-17", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-11-17", person: "Marino Rastelli", status: "P", group: "Bravo", book: 1, lesson: 8 },
  { date: "2025-11-17", person: "Michael Reed", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "Michael Vazquez", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-11-17", person: "Miguel Reyes", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "Quran Karriem", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-17", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-17", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 1, lesson: 8 },
  { date: "2025-11-17", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-17", person: "Walter Woelk", status: "A", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-11-24", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-11-24", person: "Alex Espita", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-11-24", person: "David King", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 3 },
  { date: "2025-11-24", person: "Gene Begeman", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "Greg Madden", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-11-24", person: "Greg Steckroat", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "John Mozug", status: "A", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-11-24", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-11-24", person: "Joshua Hudson", status: "P", group: "Charlie", book: 1, lesson: 3 },
  { date: "2025-11-24", person: "Julian Rodriguez", status: "A", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-11-24", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 3 },
  { date: "2025-11-24", person: "Marino Rastelli", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-11-24", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 2 },
  { date: "2025-11-24", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-11-24", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 3 },
  { date: "2025-11-24", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-11-24", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 3 },
  { date: "2025-11-24", person: "Walter Woelk", status: "A", group: "Charlie", book: 1, lesson: 3 },
  { date: "2025-12-01", person: "Aaron Diaz", status: "A", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-12-01", person: "Alex Espita", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-12-01", person: "David King", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-01", person: "Gene Begeman", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "Greg Madden", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-12-01", person: "Greg Steckroat", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "Homero Rodriguez", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "John Mozug", status: "A", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-12-01", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-12-01", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-01", person: "Julian Rodriguez", status: "A", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-12-01", person: "Manny Begeman", status: "A", group: "Delta", book: 1, lesson: 4 },
  { date: "2025-12-01", person: "Marino Rastelli", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-12-01", person: "Michael Reed", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "Michael Vazquez", status: "P", group: "Echo", book: 1, lesson: 2 },
  { date: "2025-12-01", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-01", person: "Randy McMath", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-01", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 1, lesson: 9 },
  { date: "2025-12-01", person: "Steve Szwed", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-01", person: "Walter Woelk", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-08", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Alex Espita", status: "P", group: "Bravo", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "David King", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Gene Begeman", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "Greg Madden", status: "P", group: "Bravo", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Greg Steckroat", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "Homero Rodriguez", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "John Mozug", status: "P", group: "Bravo", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Julian Rodriguez", status: "A", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Marino Rastelli", status: "P", group: "Bravo", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Michael Reed", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "Michael Vazquez", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Miguel Reyes", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "Quran Karriem", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-08", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 1 },
  { date: "2025-12-08", person: "Walter Woelk", status: "A", group: "Charlie", book: 1, lesson: 1 },
  { date: "2025-12-15", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-12-15", person: "Alex Espita", status: "A", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-15", person: "David King", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "Derrick Parker", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-15", person: "Erick Castillo", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-15", person: "Gene Begeman", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-15", person: "Greg Steckroat", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "Henry Love", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-15", person: "Homero Rodriguez", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "John Mozug", status: "A", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-15", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-12-15", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 2 },
  { date: "2025-12-15", person: "Julian Rodriguez", status: "A", group: "Delta", book: 1, lesson: 2 },
  { date: "2025-12-15", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 4 },
  { date: "2025-12-15", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-15", person: "Mathias Ibarra", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-15", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 2 },
  { date: "2025-12-15", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-15", person: "Randy McMath", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-15", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-15", person: "Steve Szwed", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-15", person: "Walter Woelk", status: "A", group: "Charlie", book: 1, lesson: 4 },
  { date: "2025-12-29", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 3 },
  { date: "2025-12-29", person: "Alex Espita", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-29", person: "David King", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 5 },
  { date: "2025-12-29", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-29", person: "Gene Begeman", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-29", person: "Greg Steckroat", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "Henry Love", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-29", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "John Mozug", status: "A", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-29", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 3 },
  { date: "2025-12-29", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 3 },
  { date: "2025-12-29", person: "Julian Rodriguez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-29", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 3 },
  { date: "2025-12-29", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-29", person: "Mathias Ibarra", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-29", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-29", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "Quran Karriem", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2025-12-29", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 5 },
  { date: "2025-12-29", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2025-12-29", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 5 },
  { date: "2025-12-29", person: "Walter Woelk", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2025-12-29", person: "Emmanuel Huertas", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 3 },
  { date: "2026-01-05", person: "Alex Espita", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-05", person: "Anthony Freel", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "David King", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 5 },
  { date: "2026-01-05", person: "Emmanuel Huertas", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Gene Begeman", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-05", person: "Greg Steckroat", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Jared Miller", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "John Mozug", status: "P", group: "Bravo", book: 1, lesson: 3 },
  { date: "2026-01-05", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 3 },
  { date: "2026-01-05", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 5 },
  { date: "2026-01-05", person: "Julian Rodriguez", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 3 },
  { date: "2026-01-05", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-05", person: "Mathias Ibarra", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Nick Houston", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-05", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-05", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 5 },
  { date: "2026-01-05", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-05", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 5 },
  { date: "2026-01-05", person: "Thomas Karriem", status: "P", group: "Delta", book: 1, lesson: 3 },
  { date: "2026-01-05", person: "Walter Woelk", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Aaron Diaz", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-12", person: "Alex Espita", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-12", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-12", person: "Duane Keene", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Emmanuel Huertas", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-12", person: "Greg Steckroat", status: "P", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Henry Love", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Homero Rodriguez", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Jared Miller", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Jermaine Holloway", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "John Mozug", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-12", person: "Jose Cortez", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-12", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-12", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-12", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Julian Rodriguez", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-12", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-12", person: "Mathias Ibarra", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-12", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-12", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-12", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-12", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-12", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-19", person: "David King", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Greg Steckroat", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-19", person: "Alex Espita", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-19", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-19", person: "John Mozug", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-19", person: "Marino Rastelli", status: "A", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-19", person: "Stefano Raimahda", status: "F", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-19", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-19", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-19", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-19", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-19", person: "Aaron Diaz", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-19", person: "Jose Cortez", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-19", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-19", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-19", person: "Thomas Karriem", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-19", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Henry Love", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Mathias Ibarra", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Duane Keene", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Emmanuel Huertas", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Jared Miller", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Jermaine Holloway", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-19", person: "Julian Rodriguez", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Greg Steckroat", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Homero Rodriguez", status: "A", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 1 },
  { date: "2026-01-26", person: "Alex Espita", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-26", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-26", person: "John Mozug", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-26", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-26", person: "Stefano Raimahda", status: "F", group: "Bravo", book: 2, lesson: 1 },
  { date: "2026-01-26", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-26", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-26", person: "Randy McMath", status: "A", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-26", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 8 },
  { date: "2026-01-26", person: "Aaron Diaz", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-26", person: "Jose Cortez", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-26", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-26", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-26", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 7 },
  { date: "2026-01-26", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Henry Love", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Mathias Ibarra", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "David Hornbeck", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Duane Keene", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Emmanuel Huertas", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Jared Miller", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Jermaine Holloway", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-01-26", person: "Julian Rodriguez", status: "A", group: "Foxtrot", book: 1, lesson: 1 },
  { date: "2026-02-02", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Greg Steckroat", status: "F", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Homero Rodriguez", status: "A", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 2 },
  { date: "2026-02-02", person: "Alex Espita", status: "F", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-02", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-02", person: "John Mozug", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-02", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-02", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-02", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-02", person: "Joshua Hudson", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-02", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-02", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-02", person: "Aaron Diaz", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-02", person: "Jose Cortez", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-02", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-02", person: "Manny Begeman", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-02", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-02", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-02", person: "Henry Love", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-02", person: "Mathias Ibarra", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-02", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-02", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "David Hornbeck", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "Duane Keene", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "Emmanuel Huertas", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "Jared Miller", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "Jermaine Holloway", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-02", person: "Julian Rodriguez", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Jordan Browning", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Greg Steckroat", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-09", person: "Alex Espita", status: "F", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-09", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-09", person: "John Mozug", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-09", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-09", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-09", person: "Derrick Parker", status: "A", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-09", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-09", person: "Randy McMath", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-09", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-09", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-09", person: "Jose Cortez", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-09", person: "Jose Salvador", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-09", person: "Manny Begeman", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-09", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-09", person: "Erick Castillo", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-09", person: "Henry Love", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-09", person: "Mathias Ibarra", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-09", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-09", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "David Hornbeck", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Duane Keene", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Emmanuel Huertas", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Jared Miller", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Jermaine Holloway", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Jordan Browning", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Joshua Floyd", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Julian Rodriguez", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-09", person: "Liam Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-02", person: "Liam Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-01-26", person: "Liam Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Gene Begeman", status: "A", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Greg Steckroat", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-16", person: "Alex Espita", status: "A", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-16", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-16", person: "John Mozug", status: "A", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-16", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-16", person: "Miguel Chapa", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-16", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-16", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-16", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-16", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-16", person: "Aaron Diaz", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "Jose Cortez", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "Liam Begeman", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "Manny Begeman", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-16", person: "Mathias Ibarra", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-16", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-16", person: "Anthony Freel", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "David Hornbeck", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Duane Keene", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Emmanuel Huertas", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Jared Miller", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Jermaine Holloway", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Jordan Browning", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Joshua Floyd", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-16", person: "Miguel Chapa III", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Greg Steckroat", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Homero Rodriguez", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-02-23", person: "Alex Espita", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-23", person: "Greg Madden", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-23", person: "John Mozug", status: "A", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-23", person: "Marino Rastelli", status: "A", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-23", person: "Miguel Chapa", status: "A", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-23", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-02-23", person: "Derrick Parker", status: "A", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-23", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-23", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-02-23", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-23", person: "Jose Cortez", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-23", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-23", person: "Liam Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-23", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-23", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-02-23", person: "Mathias Ibarra", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "Michael Vazquez", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "David Hornbeck", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Duane Keene", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Emmanuel Huertas", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Jared Miller", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Jermaine Holloway", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Jordan Browning", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Joshua Floyd", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "Miguel Chapa III", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-02-23", person: "ZZ zz", status: "A", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-03-02", person: "David King", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Gene Begeman", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Greg Steckroat", status: "A", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Homero Rodriguez", status: "A", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Michael Reed", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Miguel Reyes", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Quran Karriem", status: "F", group: "Alpha", book: 3, lesson: 3 },
  { date: "2026-03-02", person: "Alex Espita", status: "A", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-03-02", person: "Greg Madden", status: "F", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-03-02", person: "John Mozug", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-03-02", person: "Marino Rastelli", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-03-02", person: "Miguel Chapa", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-03-02", person: "Stefano Raimahda", status: "P", group: "Bravo", book: 2, lesson: 2 },
  { date: "2026-03-02", person: "Derrick Parker", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-03-02", person: "Joshua Hudson", status: "A", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-03-02", person: "Steve Szwed", status: "P", group: "Charlie", book: 1, lesson: 9 },
  { date: "2026-03-02", person: "Aaron Diaz", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-03-02", person: "Jose Cortez", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-03-02", person: "Jose Salvador", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-03-02", person: "Liam Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-03-02", person: "Manny Begeman", status: "P", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-03-02", person: "Thomas Karriem", status: "A", group: "Delta", book: 1, lesson: 8 },
  { date: "2026-03-02", person: "Mathias Ibarra", status: "P", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-03-02", person: "Michael Vazquez", status: "A", group: "Echo", book: 1, lesson: 1 },
  { date: "2026-03-02", person: "Anthony Freel", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "David Hornbeck", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Duane Keene", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Emmanuel Huertas", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Jared Miller", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Jermaine Holloway", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Jordan Browning", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Joshua Floyd", status: "A", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Juan Ponce", status: "P", group: "Foxtrot", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Miguel Chapa III", status: "P", group: "Delta", book: 1, lesson: 2 },
  { date: "2026-03-02", person: "Hani Elajan", status: "P", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-03-02", person: "Hugo Rodriguez", status: "P", group: "Golf", book: 1, lesson: 1 },
  { date: "2026-03-02", person: "Ismael Cortes", status: "P", group: "Golf", book: 1, lesson: 1 }
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d || d.length < 10) return d;
  const [y, m, day] = d.split("-");
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function initials(name) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}
function getColor(groupName, groups) {
  const idx = groups.indexOf(groupName);
  return idx >= 0 ? PALETTE[idx % PALETTE.length] : "#64748b";
}

// ─── REUSABLE COMPONENTS ──────────────────────────────────────────────────────
function Modal({ title, onClose, children, maxWidth = 480 }) {
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, width: "100%", maxWidth, padding: "28px 28px 24px", boxShadow: "0 25px 50px rgba(0,0,0,0.5)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <h2 style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", width: 32, height: 32, borderRadius: 9, cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

const iStyle = { width: "100%", background: "#1e293b", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 14px", color: "#f1f5f9", fontSize: 14, outline: "none", boxSizing: "border-box", colorScheme: "dark" };

function Btn({ children, onClick, color = "#3b82f6", flex = 1, disabled = false, variant = "solid" }) {
  const solid = { background: disabled ? `${color}50` : color, color: "#fff" };
  const ghost = { background: "rgba(255,255,255,0.07)", color: "#94a3b8" };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ flex, padding: "11px", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 700, cursor: disabled ? "default" : "pointer", ...(variant === "solid" ? solid : ghost) }}>
      {children}
    </button>
  );
}

// ─── MEMBER AVATAR ────────────────────────────────────────────────────────────
// Shows photo if available, otherwise colored initials circle
function MemberAvatar({ name, group, groups, photo, size = 34, fontSize = 12 }) {
  if (photo) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", flexShrink: 0, border: `2px solid ${getColor(group, groups)}60` }}>
        <img src={photo} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: getColor(group, groups), display: "flex", alignItems: "center", justifyContent: "center", fontSize, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
      {initials(name)}
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ appUsers, onLogin, gdriveStatus, gdriveMsg }) {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  function handleLogin() {
    const user = appUsers.find(u => u.email.toLowerCase() === email.trim().toLowerCase() && u.pin === pin && u.active);
    if (user) { setError(""); onLogin(user); }
    else setError("Invalid email or PIN. Please try again.");
  }

  const bannerColor = gdriveStatus === "ok" ? "#10b981" : gdriveStatus === "error" ? "#ef4444" : "#3b82f6";

  return (
    <div style={{ background: "#0f172a", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* GDrive sync status banner */}
        {gdriveMsg && (
          <div style={{ marginBottom: 14, padding: "10px 16px", background: `${bannerColor}18`, border: `1px solid ${bannerColor}40`, borderRadius: 10, fontSize: 13, color: bannerColor, display: "flex", alignItems: "center", gap: 8, textAlign: "center", justifyContent: "center" }}>
            {gdriveStatus === "syncing" && <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span>}
            {gdriveStatus === "ok" && "☁ "}
            {gdriveStatus === "error" && "⚠ "}
            {gdriveMsg}
          </div>
        )}
        <div style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: "40px 36px", boxShadow: "0 25px 60px rgba(0,0,0,0.5)" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ width: 52, height: 52, background: "linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, margin: "0 auto 14px" }}>⚔</div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "#f1f5f9" }}>Every Man A Warrior</div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4, letterSpacing: 1, textTransform: "uppercase" }}>Attendance Tracker</div>
          </div>
          <Field label="Email">
            <input style={iStyle} type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com" onKeyDown={e => e.key === "Enter" && handleLogin()} />
          </Field>
          <Field label="6-Digit PIN">
            <input style={{ ...iStyle, letterSpacing: 6, fontSize: 20, textAlign: "center" }}
              type="password" maxLength={6} value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••••" onKeyDown={e => e.key === "Enter" && handleLogin()} />
          </Field>
          {error && <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 12, textAlign: "center" }}>{error}</div>}
          <button onClick={handleLogin}
            style={{ width: "100%", background: "#3b82f6", border: "none", color: "#fff", padding: "13px", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 4 }}>
            Sign In
          </button>
          <div style={{ marginTop: 20, padding: "12px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 8, fontSize: 11, color: "#475569", textAlign: "center" }}>
            Default superuser: admin@emaw.org / 123456<br/>Change this after first login.
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── RESTORE PANEL COMPONENT ──────────────────────────────────────────────────
function RestorePanel({ appUsers, setAppUsers, roles, setRoles, members, setMembers,
  groups, setGroups, facilitators, setFacilitators, groupProgress, setGroupProgress,
  allHistory, setAllHistory, qtRecords, setQtRecords, showToast }) {

  const [backupData, setBackupData] = useState(null);
  const [backupMeta, setBackupMeta] = useState(null);
  const [selected, setSelected] = useState([]);

  const RESTORE_ITEMS = [
    { key: "members",      label: "Members",          icon: "👥" },
    { key: "history",      label: "Attendance History", icon: "📋" },
    { key: "groups",       label: "Groups",            icon: "🏷" },
    { key: "facilitators", label: "Facilitators",      icon: "👤" },
    { key: "progress",     label: "Book/Lesson Progress", icon: "📖" },
    { key: "qt",           label: "QT Records",        icon: "✝" },
    { key: "users",        label: "App Users",         icon: "🔐" },
    { key: "roles",        label: "Roles & Permissions", icon: "🛡" },
  ];

  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const backup = JSON.parse(e.target.result);
        if (!backup.data) { showToast("Invalid backup file.", "#ef4444"); return; }
        setBackupData(backup.data);
        setBackupMeta(backup.exportedAt ? backup.exportedAt.slice(0,10) : "unknown date");
        setSelected(RESTORE_ITEMS.map(i => i.key)); // default: all selected
        showToast("Backup file loaded — choose what to restore.");
      } catch { showToast("Failed to read backup file.", "#ef4444"); }
    };
    reader.readAsText(file);
  }

  function doRestore() {
    if (!backupData || selected.length === 0) { showToast("Select at least one item to restore.", "#ef4444"); return; }
    if (!window.confirm(`Restore ${selected.length} item(s) from backup dated ${backupMeta}? Selected data will be overwritten.`)) return;
    const d = backupData;
    if (selected.includes("users")        && d.users)        { setAppUsers(d.users);            save("emaw_users_v3", d.users); }
    if (selected.includes("roles")        && d.roles)        { setRoles(d.roles);                save("emaw_roles_v3", d.roles); }
    if (selected.includes("members")      && d.members)      { setMembers(d.members);            save("emaw_members_v3", d.members); }
    if (selected.includes("groups")       && d.groups)       { setGroups(d.groups);              save("emaw_groups_v3", d.groups); }
    if (selected.includes("facilitators") && d.facilitators) { setFacilitators(d.facilitators);  save("emaw_facilitators_v3", d.facilitators); }
    if (selected.includes("progress")     && d.progress)     { setGroupProgress(d.progress);     save("emaw_progress_v3", d.progress); }
    if (selected.includes("history")      && d.history)      { setAllHistory(d.history);         save("emaw_history_v3", d.history); }
    if (selected.includes("qt")           && d.qt)           { setQtRecords(d.qt);               save("emaw_qt_v3", d.qt); }
    showToast(`Restored ${selected.length} item(s) from ${backupMeta}!`);
    setBackupData(null); setBackupMeta(null); setSelected([]);
  }

  function toggle(key) {
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  if (!backupData) {
    return (
      <label style={{ display: "block", width: "100%", background: "#f59e0b", border: "none", color: "#000", padding: "11px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", textAlign: "center", boxSizing: "border-box" }}>
        Choose Backup File
        <input type="file" accept=".json" style={{ display: "none" }} onChange={e => { loadFile(e.target.files[0]); e.target.value = ""; }} />
      </label>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: "#10b981", fontWeight: 600, marginBottom: 10 }}>
        ✓ Backup loaded from {backupMeta} — select items to restore:
      </div>
      <div style={{ marginBottom: 8 }}>
        <button onClick={() => setSelected(selected.length === RESTORE_ITEMS.length ? [] : RESTORE_ITEMS.map(i => i.key))}
          style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
          {selected.length === RESTORE_ITEMS.length ? "Deselect All" : "Select All"}
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
        {RESTORE_ITEMS.map(item => {
          const available = !!backupData[item.key];
          return (
            <label key={item.key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: available ? "pointer" : "default", opacity: available ? 1 : 0.4 }}>
              <input type="checkbox" checked={selected.includes(item.key)} disabled={!available}
                onChange={() => available && toggle(item.key)} style={{ accentColor: "#f59e0b" }} />
              <span style={{ fontSize: 12, color: selected.includes(item.key) ? "#f1f5f9" : "#64748b" }}>
                {item.icon} {item.label}
                {!available && <span style={{ fontSize: 10, color: "#475569", marginLeft: 6 }}>(not in backup)</span>}
              </span>
            </label>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => { setBackupData(null); setBackupMeta(null); setSelected([]); }}
          style={{ flex: 1, background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", padding: "9px", borderRadius: 9, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          Cancel
        </button>
        <button onClick={doRestore} disabled={selected.length === 0}
          style={{ flex: 2, background: selected.length > 0 ? "#f59e0b" : "rgba(245,158,11,0.3)", border: "none", color: "#000", padding: "9px", borderRadius: 9, cursor: selected.length > 0 ? "pointer" : "default", fontSize: 13, fontWeight: 700 }}>
          Restore {selected.length} Item{selected.length !== 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
function MainApp({ currentUser, setCurrentUser, appUsers, setAppUsers, roles, setRoles, gdriveConnected, setGdriveConnected }) {

  // ── Persisted state — seeded from cache populated by App shell loadAllData ──
  const [members, setMembers] = useState(() => initStore("emaw_members_v3", SEED_MEMBERS));
  const [groups, setGroups] = useState(() => initStore("emaw_groups_v3", SEED_GROUPS));
  const [facilitators, setFacilitators] = useState(() => initStore("emaw_facilitators_v3", SEED_FACILITATORS));
  const [groupProgress, setGroupProgress] = useState(() => initStore("emaw_progress_v3", SEED_GROUP_PROGRESS));
  const [allHistory, setAllHistory] = useState(() => initStore("emaw_history_v3", HISTORY));
  // qtRecords: { id, date, person, group, quietTimeDays, scriptureRef, scriptureMemorized }
  const [qtRecords, setQtRecords] = useState(() => initStore("emaw_qt_v3", []));

  // Persist on every change — write to server (and localStorage fallback)
  useEffect(() => { save("emaw_members_v3", members); }, [members]);
  useEffect(() => { save("emaw_groups_v3", groups); }, [groups]);
  useEffect(() => { save("emaw_facilitators_v3", facilitators); }, [facilitators]);
  useEffect(() => { save("emaw_progress_v3", groupProgress); }, [groupProgress]);
  useEffect(() => { save("emaw_history_v3", allHistory); }, [allHistory]);
  useEffect(() => { save("emaw_qt_v3", qtRecords); }, [qtRecords]);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [view, setView] = useState("dashboard");
  const [selectedGroup, setSelectedGroup] = useState("All");
  const [search, setSearch] = useState("");
  const [takingAttendance, setTakingAttendance] = useState(false);
  const [sessionGroup, setSessionGroup] = useState("Alpha");
  const [sessionAttendance, setSessionAttendance] = useState({});
  const [sessionBook, setSessionBook] = useState(1);
  const [sessionLesson, setSessionLesson] = useState(1);

  const [sessionDate, setSessionDate] = useState(() => localToday());

  // ── Report state ─────────────────────────────────────────────────────────────
  const [reportType, setReportType] = useState("signin");
  const [reportGroup, setReportGroup] = useState("All");
  const [reportSession, setReportSession] = useState("");

  // ── Modal state ──────────────────────────────────────────────────────────────
  const [modal, setModal] = useState(null);
  const [editingMember, setEditingMember] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
  const [editingRole, setEditingRole] = useState(null);
  const [toast, setToast] = useState(null);

  // Member form
  const [f_first, setF_first] = useState("");
  const [f_last, setF_last] = useState("");
  const [f_phone, setF_phone] = useState("");
  const [f_email, setF_email] = useState("");
  const [f_group, setF_group] = useState("");
  // Group form
  const [f_gname, setF_gname] = useState("");
  const [f_gfac, setF_gfac] = useState("");
  const [f_gbook, setF_gbook] = useState(1);
  const [f_glesson, setF_glesson] = useState(1);
  // Edit member
  const [f_egroup, setF_egroup] = useState("");
  const [f_ephone, setF_ephone] = useState("");
  const [f_eemail, setF_eemail] = useState("");
  const [f_ephoto, setF_ephoto] = useState(null);
  // Edit group
  const [f_eg_fac, setF_eg_fac] = useState("");
  const [f_eg_book, setF_eg_book] = useState(1);
  const [f_eg_lesson, setF_eg_lesson] = useState(1);
  // User form
  const [f_uname, setF_uname] = useState("");
  const [f_uemail, setF_uemail] = useState("");
  const [f_upin, setF_upin] = useState("");
  const [f_urole, setF_urole] = useState("viewer");
  // User group access
  const [f_ugroups, setF_ugroups] = useState([]);
  // Change PIN form
  const [f_oldpin, setF_oldpin] = useState("");
  const [f_newpin, setF_newpin] = useState("");
  const [f_newpin2, setF_newpin2] = useState("");
  // Role form
  const [f_rname, setF_rname] = useState("");
  const [f_rperms, setF_rperms] = useState([]);
  // QT form
  const [f_qt_member, setF_qt_member] = useState("");
  const [f_qt_date, setF_qt_date] = useState(localToday());
  const [f_qt_days, setF_qt_days] = useState("");
  const [f_qt_ref, setF_qt_ref] = useState("");
  const [f_qt_mem, setF_qt_mem] = useState(false);
  // History editor
  const [histGroup, setHistGroup] = useState("Alpha");
  const [histDate, setHistDate] = useState("");
  const [editingRec, setEditingRec] = useState(null);
  const [f_hrec_person, setF_hrec_person] = useState("");
  const [f_hrec_date, setF_hrec_date] = useState("");
  const [f_hrec_status, setF_hrec_status] = useState("P");
  const [f_hrec_book, setF_hrec_book] = useState(1);
  const [f_hrec_lesson, setF_hrec_lesson] = useState(1);
  const [f_hrec_group, setF_hrec_group] = useState("Alpha");
  // Progress grid
  const [progGroup, setProgGroup] = useState("All");
  // Messaging
  const [msgGroup, setMsgGroup] = useState("All");
  const [msgTemplate, setMsgTemplate] = useState("general");
  const [msgCustom, setMsgCustom] = useState("");
  const [msgEditingFor, setMsgEditingFor] = useState(null); // member name being composed for
  const [msgEditText, setMsgEditText] = useState("");
  // Reminders
  const [reminderThreshold, setReminderThreshold] = useState(60);
  const [reminderTemplate, setReminderTemplate] = useState("Hi {first}, we miss you at Every Man A Warrior! Your current attendance is {rate}%. We\'d love to see you at our next meeting. Come back strong! ⚔");

  function showToast(msg, color = "#10b981") {
    setToast({ msg, color });
    setTimeout(() => setToast(null), 3200);
    return undefined;
  }
  function closeModal() { setModal(null); }

  // ── Google Drive sync state & helpers ────────────────────────────────────
  const [gdriveModal, setGdriveModal] = useState(false);
  const [gdriveSyncing, setGdriveSyncing] = useState(false);
  const [gdriveSyncMsg, setGdriveSyncMsg] = useState("");

  function _buildGDrivePayload() {
    return {
      exportedAt: new Date().toISOString(),
      version: "v3",
      data: {
        emaw_users_v3:        appUsers,
        emaw_roles_v3:        roles,
        emaw_members_v3:      members,
        emaw_groups_v3:       groups,
        emaw_facilitators_v3: facilitators,
        emaw_progress_v3:     groupProgress,
        emaw_history_v3:      allHistory,
        emaw_qt_v3:           qtRecords,
      }
    };
  }

  function _applyGDriveData(cloudData) {
    const d = cloudData.data || cloudData;
    if (d.emaw_users_v3        || d.users)        { const v = d.emaw_users_v3        ?? d.users;        setAppUsers(v);      save("emaw_users_v3", v); }
    if (d.emaw_roles_v3        || d.roles)        { const v = d.emaw_roles_v3        ?? d.roles;        setRoles(v);         save("emaw_roles_v3", v); }
    if (d.emaw_members_v3      || d.members)      { const v = d.emaw_members_v3      ?? d.members;      setMembers(v);       save("emaw_members_v3", v); }
    if (d.emaw_groups_v3       || d.groups)       { const v = d.emaw_groups_v3       ?? d.groups;       setGroups(v);        save("emaw_groups_v3", v); }
    if (d.emaw_facilitators_v3 || d.facilitators) { const v = d.emaw_facilitators_v3 ?? d.facilitators; setFacilitators(v);  save("emaw_facilitators_v3", v); }
    if (d.emaw_progress_v3     || d.progress)     { const v = d.emaw_progress_v3     ?? d.progress;     setGroupProgress(v); save("emaw_progress_v3", v); }
    if (d.emaw_history_v3      || d.history)      { const v = d.emaw_history_v3      ?? d.history;      setAllHistory(v);    save("emaw_history_v3", v); }
    if (d.emaw_qt_v3           || d.qt)           { const v = d.emaw_qt_v3           ?? d.qt;           setQtRecords(v);     save("emaw_qt_v3", v); }
  }

  async function handleGDrivePush() {
    setGdriveSyncing(true);
    setGdriveSyncMsg("Pushing data to Google Drive…");
    try {
      await syncToGDrive(_buildGDrivePayload());
      setGdriveSyncMsg("✓ Data pushed to Google Drive successfully!");
      showToast("Pushed to Google Drive ☁");
    } catch (e) {
      setGdriveSyncMsg("✗ Push failed: " + e.message);
      showToast("GDrive push failed: " + e.message, "#ef4444");
    } finally {
      setGdriveSyncing(false);
    }
  }

  async function handleGDrivePull() {
    if (!window.confirm("Pull from Google Drive? This will overwrite your local data with the cloud version.")) return;
    setGdriveSyncing(true);
    setGdriveSyncMsg("Pulling data from Google Drive…");
    try {
      const cloudData = await syncFromGDrive();
      if (!cloudData) {
        setGdriveSyncMsg("No data found in Google Drive yet.");
        return;
      }
      _applyGDriveData(cloudData);
      setGdriveSyncMsg("✓ Data pulled from Google Drive successfully!");
      showToast("Pulled from Google Drive ☁");
    } catch (e) {
      setGdriveSyncMsg("✗ Pull failed: " + e.message);
      showToast("GDrive pull failed: " + e.message, "#ef4444");
    } finally {
      setGdriveSyncing(false);
    }
  }

  function handleGDriveDisconnect() {
    _clearCachedToken();
    setGdriveConnected(false);
    setGdriveSyncMsg("Disconnected from Google Drive.");
    showToast("Disconnected from Google Drive", "#f59e0b");
  }

  // ── Welcome toast on mount ───────────────────────────────────────────────────
  useEffect(() => { 
    const t = setTimeout(() => showToast(`Welcome, ${currentUser.name}!`), 100);
    return () => clearTimeout(t);
  }, []);

  // ── Poll server every 30s so changes from other devices appear automatically ─
  useEffect(() => {
    const poll = setInterval(() => {
      fetch(`http://${window.location.hostname}:3001/api/data`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then(serverData => {
          if (serverData["emaw_members_v3"])     setMembers(serverData["emaw_members_v3"]);
          if (serverData["emaw_history_v3"])     setAllHistory(serverData["emaw_history_v3"]);
          if (serverData["emaw_progress_v3"])    setGroupProgress(serverData["emaw_progress_v3"]);
          if (serverData["emaw_qt_v3"])          setQtRecords(serverData["emaw_qt_v3"]);
          if (serverData["emaw_groups_v3"])      setGroups(serverData["emaw_groups_v3"]);
          if (serverData["emaw_facilitators_v3"]) setFacilitators(serverData["emaw_facilitators_v3"]);
        })
        .catch(() => {}); // silently ignore if server unreachable
    }, 30000); // every 30 seconds
    return () => clearInterval(poll);
  }, []);

  // ── Permission helper ────────────────────────────────────────────────────────
  function can(perm) {
    if (!currentUser) return false;
    const role = roles.find(r => r.id === currentUser.roleId);
    return role ? role.permissions.includes(perm) : false;
  }
  // Returns the groups this user can see (empty array = all groups)
  function visibleGroups() {
    if (!currentUser) return groups;
    const ga = currentUser.groupAccess;
    if (!ga || ga.length === 0) return groups;
    // Always include any group not yet known when groupAccess was set
    // (e.g. groups added after this user was created)
    const baseGroups = groups.filter(g => ga.includes(g));
    const newGroups = groups.filter(g => !ga.includes(g));
    return [...baseGroups, ...newGroups];
  }

  // ── Add Member ───────────────────────────────────────────────────────────────
  function openAddMember() {
    setF_first(""); setF_last(""); setF_phone(""); setF_email(""); setF_group(groups[0] || "");
    setModal("addMember");
  }
  function submitAddMember() {
    const first = f_first.trim(), last = f_last.trim();
    if (!first || !last) { showToast("First and last name required.", "#ef4444"); return; }
    const fullName = `${first} ${last}`;
    if (members.find(m => m.name.toLowerCase() === fullName.toLowerCase())) {
      showToast("Member already exists.", "#ef4444"); return;
    }
    setMembers(prev => [...prev, { name: fullName, phone: f_phone.trim() || null, email: f_email.trim() || null, group: f_group || groups[0] }]);
    closeModal(); showToast(`${fullName} added to ${f_group}.`);
  }

  // ── Add Group ────────────────────────────────────────────────────────────────
  function openAddGroup() { setF_gname(""); setF_gfac(""); setF_gbook(1); setF_glesson(1); setModal("addGroup"); }
  function submitAddGroup() {
    const name = f_gname.trim();
    if (!name) { showToast("Group name required.", "#ef4444"); return; }
    if (groups.map(g => g.toLowerCase()).includes(name.toLowerCase())) {
      showToast("Group already exists.", "#ef4444"); return;
    }
    setGroups(prev => [...prev, name]);
    if (f_gfac.trim()) setFacilitators(prev => ({ ...prev, [name]: f_gfac.trim() }));
    setGroupProgress(prev => ({ ...prev, [name]: { book: f_gbook, lesson: f_glesson } }));
    // Add new group to groupAccess for any users who have explicit group restrictions
    // so newly created groups are immediately visible to those users too
    setAppUsers(prev => prev.map(u =>
      u.groupAccess && u.groupAccess.length > 0
        ? { ...u, groupAccess: [...u.groupAccess, name] }
        : u
    ));
    closeModal(); showToast(`Group "${name}" created.`);
  }

  // ── Edit Group ───────────────────────────────────────────────────────────────
  function openEditGroup(g) {
    setEditingGroup(g);
    setF_eg_fac(facilitators[g] || "");
    setF_eg_book((groupProgress[g] || {}).book || 1);
    setF_eg_lesson((groupProgress[g] || {}).lesson || 1);
    setModal("editGroup");
  }
  function submitEditGroup() {
    setFacilitators(prev => ({ ...prev, [editingGroup]: f_eg_fac.trim() }));
    setGroupProgress(prev => ({ ...prev, [editingGroup]: { book: Number(f_eg_book), lesson: Number(f_eg_lesson) } }));
    closeModal(); showToast(`${editingGroup} updated.`);
  }

  // ── Edit Member ───────────────────────────────────────────────────────────────
  function openEditMember(member) {
    setEditingMember(member);
    setF_egroup(member.group);
    setF_ephone(member.phone || "");
    setF_eemail(member.email || "");
    setF_ephoto(member.photo || null);
    setModal("editMember");
  }
  function submitEditMember() {
    setMembers(prev => prev.map(m => m.name === editingMember.name
      ? { ...m, group: f_egroup, phone: f_ephone.trim() || null, email: f_eemail.trim() || null, photo: f_ephoto || null }
      : m));
    closeModal();
    showToast(`${editingMember.name} updated.`);
  }
  function handlePhotoUpload(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      // Compress by drawing onto a canvas at max 200x200
      const img = new Image();
      img.onload = () => {
        const MAX = 200;
        const scale = Math.min(MAX / img.width, MAX / img.height, 1);
        const canvas = document.createElement("canvas");
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setF_ephoto(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ── App Users ────────────────────────────────────────────────────────────────
  function openAddUser() { setF_uname(""); setF_uemail(""); setF_upin(""); setF_urole("viewer"); setF_ugroups([]); setModal("addUser"); }
  function submitAddUser() {
    if (!f_uname.trim() || !f_uemail.trim()) { showToast("Name and email required.", "#ef4444"); return; }
    if (f_upin.length !== 6) { showToast("PIN must be exactly 6 digits.", "#ef4444"); return; }
    if (appUsers.find(u => u.email.toLowerCase() === f_uemail.trim().toLowerCase())) {
      showToast("Email already in use.", "#ef4444"); return;
    }
    setAppUsers(prev => [...prev, { email: f_uemail.trim(), pin: f_upin, roleId: f_urole, name: f_uname.trim(), active: true, groupAccess: f_ugroups, lastLogin: null }]);
    closeModal(); showToast(`User ${f_uname.trim()} created.`);
  }
  function toggleUserActive(email) {
    setAppUsers(prev => prev.map(u => u.email === email ? { ...u, active: !u.active } : u));
  }
  function resetUserPin(email) {
    const newPin = Math.floor(100000 + Math.random() * 900000).toString();
    setAppUsers(prev => prev.map(u => u.email === email ? { ...u, pin: newPin } : u));
    showToast(`PIN reset to ${newPin} — share securely!`, "#f59e0b");
  }
  function openEditUser(u) {
    setEditingUser(u);
    setF_uname(u.name); setF_uemail(u.email); setF_upin("");
    setF_urole(u.roleId); setF_ugroups(u.groupAccess || []);
    setModal("editUser");
  }
  function submitEditUser() {
    if (!f_uname.trim() || !f_uemail.trim()) { showToast("Name and email required.", "#ef4444"); return; }
    if (f_upin && f_upin.length !== 6) { showToast("PIN must be exactly 6 digits.", "#ef4444"); return; }
    setAppUsers(prev => prev.map(u => u.email === editingUser.email ? {
      ...u,
      name: f_uname.trim(),
      email: f_uemail.trim(),
      pin: f_upin.length === 6 ? f_upin : u.pin,
      roleId: f_urole,
      groupAccess: f_ugroups,
    } : u));
    closeModal(); showToast(`User ${f_uname.trim()} updated.`);
  }
  function deleteUser(email) {
    if (email === currentUser.email) { showToast("Cannot delete your own account.", "#ef4444"); return; }
    setAppUsers(prev => prev.filter(u => u.email !== email));
    showToast("User deleted.");
  }

  // ── Roles ─────────────────────────────────────────────────────────────────
  function openAddRole() { setF_rname(""); setF_rperms([]); setModal("addRole"); }
  function submitAddRole() {
    if (!f_rname.trim()) { showToast("Role name required.", "#ef4444"); return; }
    const id = f_rname.trim().toLowerCase().replace(/\s+/g, "_");
    setRoles(prev => [...prev, { id, name: f_rname.trim(), permissions: f_rperms, locked: false }]);
    closeModal(); showToast(`Role "${f_rname.trim()}" created.`);
  }
  function openEditRole(role) { setEditingRole(role); setF_rname(role.name); setF_rperms([...role.permissions]); setModal("editRole"); }
  function submitEditRole() {
    setRoles(prev => prev.map(r => r.id === editingRole.id ? { ...r, name: f_rname, permissions: f_rperms } : r));
    closeModal(); showToast(`Role updated.`);
  }
  function deleteRole(roleId) {
    if (appUsers.find(u => u.roleId === roleId)) { showToast("Cannot delete a role that is assigned to users.", "#ef4444"); return; }
    setRoles(prev => prev.filter(r => r.id !== roleId));
    showToast("Role deleted.");
  }

  // ── QT ────────────────────────────────────────────────────────────────────
  function openAddQT() {
    setF_qt_member(activeMembersList[0]?.name || ""); setF_qt_date(localToday());
    setF_qt_days(""); setF_qt_ref(""); setF_qt_mem(false); setModal("addQT");
  }
  function submitAddQT() {
    if (!f_qt_member) { showToast("Select a member.", "#ef4444"); return; }
    const rec = { id: Date.now(), date: f_qt_date, person: f_qt_member, group: members.find(m => m.name === f_qt_member)?.group || "", quietTimeDays: Number(f_qt_days) || 0, scriptureRef: f_qt_ref.trim(), scriptureMemorized: f_qt_mem };
    setQtRecords(prev => [...prev, rec]);
    closeModal(); showToast(`QT record saved for ${f_qt_member}.`);
  }

  // ── Derived stats ─────────────────────────────────────────────────────────
  const activeMembersList = useMemo(() => members.filter(m => m.group !== "Inactive"), [members]);

  const memberStats = useMemo(() => {
    const stats = {};
    activeMembersList.forEach(m => {
      const recs = allHistory.filter(r => r.person === m.name);
      const present = recs.filter(r => r.status === "P" || r.status === "F").length;
      stats[m.name] = { total: recs.length, present, rate: recs.length ? Math.round((present / recs.length) * 100) : 0 };
    });
    return stats;
  }, [allHistory, activeMembersList]);

  const groupStats = useMemo(() => groups.map(g => {
    const gMembers = activeMembersList.filter(m => m.group === g);
    const totalRecs = allHistory.filter(r => r.group === g);
    const presentRecs = totalRecs.filter(r => r.status === "P" || r.status === "F");
    const rate = totalRecs.length ? Math.round((presentRecs.length / totalRecs.length) * 100) : 0;
    return { group: g, members: gMembers.length, rate, color: getColor(g, groups) };
  }), [allHistory, activeMembersList, groups]);

  const sessionDates = useMemo(() => [...new Set(allHistory.map(r => r.date))].sort(), [allHistory]);

  const lastSeen = useMemo(() => {
    const map = {};
    allHistory.forEach(r => {
      if (r.status === "P" || r.status === "F") {
        if (!map[r.person] || r.date > map[r.person]) map[r.person] = r.date;
      }
    });
    return map;
  }, [allHistory]);

  const trendData = useMemo(() => sessionDates.map(date => {
    const recs = allHistory.filter(r => r.date === date);
    return { date: fmtDate(date).replace(/, 20\d\d/, ""), present: recs.filter(r => r.status === "P" || r.status === "F").length, absent: recs.filter(r => r.status === "A").length };
  }), [allHistory, sessionDates]);

  const filteredMembers = useMemo(() =>
    activeMembersList.filter(m => selectedGroup === "All" || m.group === selectedGroup)
      .filter(m => m.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [selectedGroup, search, activeMembersList]);

  const groupMembers = useMemo(() => activeMembersList.filter(m => m.group === sessionGroup), [sessionGroup, activeMembersList]);

  // ── Low attendance list (for reminders) ──────────────────────────────────
  const lowAttendance = useMemo(() =>
    activeMembersList.filter(m => {
      const s = memberStats[m.name];
      return s && s.total >= 2 && s.rate < 60;
    }).sort((a, b) => (memberStats[a.name]?.rate || 0) - (memberStats[b.name]?.rate || 0)),
    [activeMembersList, memberStats]);

  function startSession(forGroup) {
    const grp = forGroup || sessionGroup;
    const members_for_group = activeMembersList.filter(m => m.group === grp);
    const init = {};
    members_for_group.forEach(m => { init[m.name] = "P"; });
    const prog = groupProgress[grp] || { book: 1, lesson: 1 };
    setSessionGroup(grp);
    setSessionBook(prog.book);
    setSessionLesson(prog.lesson);
    setSessionAttendance(init);
    setTakingAttendance(true);
  }

  function submitAttendance() {
    // Check for existing records for this group on this date
    const existing = allHistory.filter(r => r.date === sessionDate && r.group === sessionGroup);
    if (existing.length > 0) {
      const names = [...new Set(existing.map(r => r.person))].slice(0, 3).join(", ");
      const more = existing.length > 3 ? ` +${existing.length - 3} more` : "";
      if (!window.confirm(
        `⚠ ${sessionGroup} already has ${existing.length} record(s) for ${sessionDate}.
` +
        `(${names}${more})

` +
        `Submit anyway? This will ADD to the existing records.
` +
        `Use History Editor to remove duplicates if needed.`
      )) return;
    }
    const newRecs = Object.entries(sessionAttendance).map(([name, status]) => ({
      date: sessionDate, person: name, status, group: sessionGroup, book: Number(sessionBook), lesson: Number(sessionLesson)
    }));
    setAllHistory(prev => [...prev, ...newRecs]);
    setGroupProgress(prev => ({ ...prev, [sessionGroup]: { book: Number(sessionBook), lesson: Number(sessionLesson) } }));
    setTakingAttendance(false);
    setSessionDate(localToday());
    setView("dashboard");
    showToast(`Attendance submitted — ${sessionGroup} · Bk ${sessionBook} L${sessionLesson} · ${sessionDate}`);
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function exportCSV() {
    const header = ["Date","Person","Group","Status","Book","Lesson"].join(",");
    const rows = allHistory.map(r => [r.date, `"${r.person}"`, r.group, r.status, r.book||"", r.lesson||""].join(","));
    const csv = header + "\n" + rows.join("\n");
    const dataUri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const a = document.createElement("a");
    a.setAttribute("href", dataUri);
    a.setAttribute("download", "EMAW_Attendance.csv");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast("CSV downloaded!");
  }

  function exportQTCSV() {
    const header = ["Date","Person","Group","Quiet Time Days","Scripture Ref","Memorized"].join(",");
    const rows = qtRecords.map(r => [r.date, `"${r.person}"`, r.group, r.quietTimeDays, `"${r.scriptureRef}"`, r.scriptureMemorized ? "Yes" : "No"].join(","));
    const csv = header + "\n" + rows.join("\n");
    const dataUri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const a = document.createElement("a");
    a.setAttribute("href", dataUri);
    a.setAttribute("download", "EMAW_QuietTime.csv");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast("QT CSV downloaded!");
  }

  // ── Print ─────────────────────────────────────────────────────────────────
  function printReport() {
    const el = document.getElementById("emaw-print-area");
    if (!el) return;
    const isLandscape = el.dataset.landscape === "true";
    const w = window.open("", "_blank", "width=1100,height=800");
    w.document.write(`<!DOCTYPE html><html><head><title>EMAW Report</title>
      <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        @page { margin: 0.55in; size: ${isLandscape ? "landscape" : "portrait"}; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 4px 6px; font-size: 10px; border: 1px solid #ccc; }
        th { background: #f0f4f8; font-weight: bold; }
        tr:nth-child(even) { background: #f8fafc; }
      </style>
    </head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 500);
  }

  function printProgressGrid(rows, cols, group) {
    const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const bookColors = { 1: "#dbeafe", 2: "#dcfce7", 3: "#fef9c3" };
    const colHeaders = cols.map(c => `<th style="background:${bookColors[c.book]};text-align:center;width:18px;font-size:6px;padding:2px 1px;border:1px solid #ccc">B${c.book}L${c.lesson}</th>`).join("");
    const dataRows = rows.map((row, ri) => {
      const cells = cols.map(c => `<td style="text-align:center;color:#16a34a;font-weight:bold;font-size:9px;border:1px solid #ddd">${row.cells[c.book+"_"+c.lesson] ? "✓" : ""}</td>`).join("");
      return `<tr style="background:${ri%2===0?"#fff":"#f8fafc"}"><td style="border:1px solid #ddd;padding:2px 4px;font-size:8px;white-space:nowrap">${row.member}</td><td style="border:1px solid #ddd;padding:2px 3px;font-size:7px;text-align:center">${row.group}</td>${cells}</tr>`;
    }).join("");
    const html = `<!DOCTYPE html><html><head><title>EMAW Progress Grid</title>
      <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; font-size: 9px; }
        @page { margin: 0.4in; size: landscape; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        col.member { width: 14%; } col.group { width: 5%; }
      </style>
    </head><body>
      <div style="border-bottom:2px solid #1e3a5f;padding-bottom:8px;margin-bottom:10px;display:flex;justify-content:space-between">
        <strong style="font-size:13px;color:#1e3a5f">Every Man A Warrior — Progress Grid</strong>
        <span>${group==="All"?"All Groups":"Group: "+group} · ${dateStr}</span>
      </div>
      <table>
        <colgroup><col class="member"/><col class="group"/>${cols.map(()=>'<col/>').join("")}</colgroup>
        <thead><tr>
          <th style="text-align:left;background:#f0f4f8;border:1px solid #ccc;padding:3px 5px">Member</th>
          <th style="text-align:center;background:#f0f4f8;border:1px solid #ccc;padding:3px 2px">Grp</th>
          ${colHeaders}
        </tr></thead>
        <tbody>${dataRows}</tbody>
      </table>
    </body></html>`;
    const w = window.open("", "_blank", "width=1200,height=800");
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 500);
  }

  // ── History Editor ────────────────────────────────────────────────────────
  function openAddHistRec() {
    setEditingRec(null);
    setF_hrec_person(activeMembersList[0]?.name || "");
    setF_hrec_date(localToday());
    setF_hrec_status("P"); setF_hrec_book(1); setF_hrec_lesson(1);
    setF_hrec_group(groups[0] || "Alpha");
    setModal("editHistRec");
  }
  function openEditHistRec(rec) {
    setEditingRec(rec);
    setF_hrec_person(rec.person); setF_hrec_date(rec.date);
    setF_hrec_status(rec.status); setF_hrec_book(rec.book || 1);
    setF_hrec_lesson(rec.lesson || 1); setF_hrec_group(rec.group);
    setModal("editHistRec");
  }
  function submitHistRec() {
    const updated = { person: f_hrec_person, date: f_hrec_date, status: f_hrec_status, book: Number(f_hrec_book), lesson: Number(f_hrec_lesson), group: f_hrec_group };
    if (editingRec) {
      setAllHistory(prev => prev.map(r => r === editingRec ? updated : r));
      showToast("Record updated.");
    } else {
      setAllHistory(prev => [...prev, updated]);
      showToast("Record added.");
    }
    closeModal();
  }
  function deleteHistRec(rec) {
    if (window.confirm(`Delete attendance record for ${rec.person} on ${rec.date}?`)) {
      setAllHistory(prev => prev.filter(r => r !== rec));
      showToast("Record deleted.", "#ef4444");
    }
  }
  function deleteDuplicates(date, grp) {
    const recs = allHistory.filter(r => r.date === date && r.group === grp);
    const seen = new Set();
    const toRemove = [];
    recs.forEach(r => {
      if (seen.has(r.person)) { toRemove.push(r); } else { seen.add(r.person); }
    });
    if (toRemove.length === 0) { showToast("No duplicates found.", "#f59e0b"); return; }
    if (window.confirm(`Remove ${toRemove.length} duplicate record(s) for ${grp} on ${date}?`)) {
      setAllHistory(prev => prev.filter(r => !toRemove.includes(r)));
      showToast(`${toRemove.length} duplicate(s) removed.`, "#ef4444");
    }
  }

  // ── Progress Grid Export ───────────────────────────────────────────────────
  function exportProgressCSV(rows, cols) {
    const header = ["Member","Group", ...cols.map(c => `Bk${c.book}L${c.lesson}`)].join(",");
    const dataRows = rows.map(r => [
      `"${r.member}"`, r.group,
      ...cols.map(c => r.cells[`${c.book}_${c.lesson}`] ? "✓" : "")
    ].join(","));
    const csv = header + "\n" + dataRows.join("\n");
    const uri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const a = document.createElement("a"); a.setAttribute("href", uri);
    a.setAttribute("download", "EMAW_ProgressGrid.csv");
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast("Progress grid CSV downloaded!");
  }

  // ── Roster Report Export ───────────────────────────────────────────────────
  function exportRosterCSV() {
    const header = ["Name","Phone","Email","Group","Last Attendance"].join(",");
    const rows = activeMembersList.sort((a,b)=>a.name.localeCompare(b.name)).map(m => {
      const last = lastSeen[m.name] ? fmtDate(lastSeen[m.name]) : "Never";
      return [`"${m.name}"`, m.phone||"", m.email||"", m.group, last].join(",");
    });
    const csv = header + "\n" + rows.join("\n");
    const uri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const a = document.createElement("a"); a.setAttribute("href", uri);
    a.setAttribute("download", "EMAW_Roster.csv");
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast("Roster CSV downloaded!");
  }

  // ── Backup / Restore ──────────────────────────────────────────────────────
  function exportAllData() {
    const backup = {
      exportedAt: new Date().toISOString(),
      version: "v3",
      data: {
        users:        appUsers,
        roles:        roles,
        members:      members,
        groups:       groups,
        facilitators: facilitators,
        progress:     groupProgress,
        history:      allHistory,
        qt:           qtRecords,
      }
    };
    const json = JSON.stringify(backup, null, 2);
    const dataUri = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    const a = document.createElement("a");
    a.setAttribute("href", dataUri);
    const dateStr = localToday();
    a.setAttribute("download", `EMAW_Backup_${dateStr}.json`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast("Full backup downloaded!");
  }

  function importAllData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const backup = JSON.parse(e.target.result);
        if (!backup.data) { showToast("Invalid backup file.", "#ef4444"); return; }
        const d = backup.data;
        if (d.users)        { setAppUsers(d.users);        save("emaw_users_v3", d.users); }
        if (d.roles)        { setRoles(d.roles);            save("emaw_roles_v3", d.roles); }
        if (d.members)      { setMembers(d.members);        save("emaw_members_v3", d.members); }
        if (d.groups)       { setGroups(d.groups);          save("emaw_groups_v3", d.groups); }
        if (d.facilitators) { setFacilitators(d.facilitators); save("emaw_facilitators_v3", d.facilitators); }
        if (d.progress)     { setGroupProgress(d.progress); save("emaw_progress_v3", d.progress); }
        if (d.history)      { setAllHistory(d.history);     save("emaw_history_v3", d.history); }
        if (d.qt)           { setQtRecords(d.qt);           save("emaw_qt_v3", d.qt); }
        showToast(`Backup restored from ${backup.exportedAt ? backup.exportedAt.slice(0,10) : "file"}!`);
      } catch {
        showToast("Failed to parse backup file.", "#ef4444");
      }
    };
    reader.readAsText(file);
  }

  const totalPresent = allHistory.filter(r => r.status === "P" || r.status === "F").length;
  const overallRate = allHistory.length ? Math.round((totalPresent / allHistory.length) * 100) : 0;
  const latestDate = sessionDates[sessionDates.length - 1];
  const latestCount = allHistory.filter(r => r.date === latestDate && (r.status === "P" || r.status === "F")).length;

  // (Login gate moved to App shell to comply with React hooks rules)

  // ── Nav items based on permissions ────────────────────────────────────────
  const navItems = [
    { id: "dashboard",   label: "Dashboard",      perm: "dashboard" },
    { id: "roster",      label: "Roster",          perm: "roster" },
    { id: "sessions",    label: "Sessions",        perm: "sessions" },
    { id: "history",     label: "History Editor",  perm: "historyEditor" },
    { id: "qttracking",  label: "QT Tracking",     perm: "qtTracking" },
    { id: "progress",    label: "Progress Grid",   perm: "progressGrid" },
    { id: "messaging",   label: "Messaging",       perm: "messaging" },
    { id: "reminders",   label: "Reminders",       perm: "reminders" },
    { id: "manage",      label: "Manage",          perm: "manage" },
    { id: "reports",     label: "Reports",         perm: "reports" },
    { id: "security",    label: "Security",        perm: "security" },
  ].filter(n => can(n.perm));

  // ─── TAKE ATTENDANCE SCREEN ───────────────────────────────────────────────
  if (takingAttendance && can("takeAttendance")) {
    return (
      <div style={{ background: "#0f172a", minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", padding: "24px 16px" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        {toast && <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: toast.color, color: "#fff", padding: "12px 22px", borderRadius: 12, fontWeight: 600, fontSize: 14, zIndex: 300, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", whiteSpace: "nowrap" }}>{toast.msg}</div>}
        <div style={{ maxWidth: 600, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <button onClick={() => setTakingAttendance(false)} style={{ background: "rgba(255,255,255,0.08)", border: "none", color: "#94a3b8", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 14 }}>← Back</button>
            <div>
              <h2 style={{ color: "#f1f5f9", fontSize: 20, fontWeight: 700, margin: 0 }}>Take Attendance</h2>
              <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, display: "block", marginBottom: 6 }}>Session Date</label>
              <input type="date" value={sessionDate} onChange={e => setSessionDate(e.target.value)} style={iStyle} />
            </div>
            <div>
              <label style={{ color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, display: "block", marginBottom: 6 }}>Group</label>
              <select value={sessionGroup}
                onChange={e => { const g = e.target.value; setSessionGroup(g); const init = {}; activeMembersList.filter(m => m.group === g).forEach(m => { init[m.name] = "P"; }); setSessionAttendance(init); const p = groupProgress[g] || { book: 1, lesson: 1 }; setSessionBook(p.book); setSessionLesson(p.lesson); }}
                style={{ ...iStyle }}>
                {visibleGroups().map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label style={{ color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, display: "block", marginBottom: 6 }}>Book #</label>
              <input type="number" min="1" max="5" value={sessionBook} onChange={e => setSessionBook(e.target.value)} style={iStyle} />
            </div>
            <div>
              <label style={{ color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, display: "block", marginBottom: 6 }}>Lesson #</label>
              <input type="number" min="1" max="40" value={sessionLesson} onChange={e => setSessionLesson(e.target.value)} style={iStyle} />
            </div>
          </div>

          <div style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 10, padding: "8px 16px", marginBottom: 14, fontSize: 13, color: "#60a5fa" }}>
            📅 {new Date(sessionDate + "T12:00:00").toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" })} &nbsp;·&nbsp; 📖 Book {sessionBook}, Lesson {sessionLesson}
          </div>

          <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", marginBottom: 16 }}>
            {groupMembers.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#475569" }}>No active members in this group</div>}
            {groupMembers.map((m, i) => {
              const status = sessionAttendance[m.name] || "P";
              return (
                <div key={m.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: i < groupMembers.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <MemberAvatar name={m.name} group={sessionGroup} groups={groups} photo={m.photo} size={38} fontSize={12} />
                    <span style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 500 }}>{m.name}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {["P", "F", "A"].map(s => (
                      <button key={s} onClick={() => setSessionAttendance(prev => ({ ...prev, [m.name]: s }))}
                        style={{ padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none",
                          background: status === s ? (s === "P" ? "#10b981" : s === "F" ? "#3b82f6" : "#ef4444") : "rgba(255,255,255,0.07)",
                          color: status === s ? "#fff" : "#64748b" }}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {[["Present/Fac", "#10b981", ["P","F"]], ["Absent", "#ef4444", ["A"]]].map(([label, color, statuses]) => (
              <div key={label} style={{ flex: 1, background: `${color}18`, borderRadius: 10, padding: "10px 16px", textAlign: "center" }}>
                <div style={{ color, fontSize: 22, fontWeight: 700 }}>{Object.values(sessionAttendance).filter(s => statuses.includes(s)).length}</div>
                <div style={{ color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
              </div>
            ))}
          </div>
          <button onClick={submitAttendance} style={{ width: "100%", background: "#3b82f6", border: "none", color: "#fff", padding: "14px", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
            Submit Attendance
          </button>
        </div>
      </div>
    );
  }

  // ─── MAIN APP ─────────────────────────────────────────────────────────────
  return (
    <div style={{ background: "#0f172a", minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", color: "#f1f5f9" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: toast.color, color: "#fff", padding: "12px 22px", borderRadius: 12, fontWeight: 600, fontSize: 14, zIndex: 300, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", whiteSpace: "nowrap" }}>
          {toast.msg}
        </div>
      )}

      {/* ── MODALS ── */}
      {modal === "addMember" && (
        <Modal title="Add New Member" onClose={closeModal}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 4 }}>
            <Field label="First Name *"><input style={iStyle} value={f_first} onChange={e => setF_first(e.target.value)} placeholder="First" /></Field>
            <Field label="Last Name *"><input style={iStyle} value={f_last} onChange={e => setF_last(e.target.value)} placeholder="Last" /></Field>
          </div>
          <Field label="Phone"><input style={iStyle} value={f_phone} onChange={e => setF_phone(e.target.value)} placeholder="313-555-0100" /></Field>
          <Field label="Email"><input style={iStyle} value={f_email} onChange={e => setF_email(e.target.value)} placeholder="email@example.com" /></Field>
          <Field label="Assign to Group">
            <select style={iStyle} value={f_group} onChange={e => setF_group(e.target.value)}>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
              <option value="Inactive">Inactive</option>
            </select>
          </Field>
          {f_group && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: `${getColor(f_group, groups)}18`, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: getColor(f_group, groups) }} />
            <span style={{ color: getColor(f_group, groups), fontSize: 13, fontWeight: 600 }}>{f_group}</span>
            {facilitators[f_group] && <span style={{ color: "#475569", fontSize: 12 }}>· Facilitator: {facilitators[f_group]}</span>}
          </div>}
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitAddMember} flex={2}>Add Member</Btn></div>
        </Modal>
      )}

      {modal === "addGroup" && (
        <Modal title="Create New Group" onClose={closeModal}>
          <Field label="Group Name *"><input style={iStyle} value={f_gname} onChange={e => setF_gname(e.target.value)} placeholder='e.g. "Hotel"' /></Field>
          <Field label="Facilitator (optional)"><input style={iStyle} value={f_gfac} onChange={e => setF_gfac(e.target.value)} placeholder="Facilitator full name" /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Starting Book #"><input type="number" min="1" max="5" style={iStyle} value={f_gbook} onChange={e => setF_gbook(e.target.value)} /></Field>
            <Field label="Starting Lesson #"><input type="number" min="1" max="40" style={iStyle} value={f_glesson} onChange={e => setF_glesson(e.target.value)} /></Field>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitAddGroup} flex={2} color="#10b981">Create Group</Btn></div>
        </Modal>
      )}

      {modal === "editGroup" && editingGroup && (
        <Modal title={`Edit Group: ${editingGroup}`} onClose={closeModal}>
          <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#94a3b8" }}>
            📖 Current progress: <strong style={{ color: "#f1f5f9" }}>Book {groupProgress[editingGroup]?.book || 1}, Lesson {groupProgress[editingGroup]?.lesson || 1}</strong>
          </div>
          <Field label="Facilitator"><input style={iStyle} value={f_eg_fac} onChange={e => setF_eg_fac(e.target.value)} placeholder="Facilitator full name" /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Current Book #"><input type="number" min="1" max="5" style={iStyle} value={f_eg_book} onChange={e => setF_eg_book(e.target.value)} /></Field>
            <Field label="Current Lesson #"><input type="number" min="1" max="40" style={iStyle} value={f_eg_lesson} onChange={e => setF_eg_lesson(e.target.value)} /></Field>
          </div>
          <div style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#60a5fa", marginBottom: 12 }}>
            📖 This will also pre-fill the Book/Lesson when you take attendance for this group.
          </div>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitEditGroup} flex={2}>Save Changes</Btn></div>
        </Modal>
      )}

      {modal === "editMember" && editingMember && (
        <Modal title="Edit Member" onClose={closeModal} maxWidth={480}>
          {/* Photo + name header */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, padding: "14px 16px", background: "rgba(255,255,255,0.04)", borderRadius: 12 }}>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <MemberAvatar name={editingMember.name} group={f_egroup} groups={groups} photo={f_ephoto} size={64} fontSize={18} />
              <label title="Upload photo" style={{ position: "absolute", bottom: -2, right: -2, width: 22, height: 22, borderRadius: "50%", background: "#3b82f6", border: "2px solid #0f172a", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11 }}>
                📷
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => handlePhotoUpload(e.target.files[0])} />
              </label>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16 }}>{editingMember.name}</div>
              <div style={{ color: "#475569", fontSize: 12 }}>{editingMember.group}</div>
              {f_ephoto && (
                <button onClick={() => setF_ephoto(null)}
                  style={{ marginTop: 4, background: "rgba(239,68,68,0.15)", border: "none", color: "#ef4444", padding: "2px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11 }}>
                  Remove photo
                </button>
              )}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Phone">
              <input style={iStyle} value={f_ephone} onChange={e => setF_ephone(e.target.value)} placeholder="313-555-0100" />
            </Field>
            <Field label="Email">
              <input style={iStyle} value={f_eemail} onChange={e => setF_eemail(e.target.value)} placeholder="email@example.com" />
            </Field>
          </div>
          <Field label="Assign to Group">
            <select style={iStyle} value={f_egroup} onChange={e => setF_egroup(e.target.value)}>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
              <option value="Inactive">Inactive</option>
            </select>
          </Field>
          {f_egroup !== editingMember.group && <div style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 8, padding: "10px 12px", marginBottom: 8, fontSize: 12, color: "#f59e0b" }}>⚠ Historical records keep the original group label.</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitEditMember} flex={2}>Save Changes</Btn></div>
        </Modal>
      )}

      {modal === "addUser" && (
        <Modal title="Create App User" onClose={closeModal} maxWidth={520}>
          <Field label="Full Name *"><input style={iStyle} value={f_uname} onChange={e => setF_uname(e.target.value)} placeholder="John Smith" /></Field>
          <Field label="Email (Login ID) *"><input style={iStyle} type="email" value={f_uemail} onChange={e => setF_uemail(e.target.value)} placeholder="john@email.com" /></Field>
          <Field label="6-Digit PIN *">
            <input style={{ ...iStyle, letterSpacing: 4, textAlign: "center" }} type="password" maxLength={6} value={f_upin} onChange={e => setF_upin(e.target.value.replace(/\D/g, "").slice(0,6))} placeholder="••••••" />
          </Field>
          <Field label="Role">
            <select style={iStyle} value={f_urole} onChange={e => setF_urole(e.target.value)}>
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Group Access">
            <div style={{ marginBottom: 8 }}>
              <button type="button" onClick={() => setF_ugroups(f_ugroups.length === groups.length ? [] : [...groups])}
                style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa", padding: "4px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                {f_ugroups.length === groups.length ? "Deselect All" : "Select All Groups"}
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {groups.map(g => (
                <label key={g} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", background: f_ugroups.includes(g) ? `${getColor(g, groups)}22` : "rgba(255,255,255,0.04)", border: `1px solid ${f_ugroups.includes(g) ? getColor(g, groups) + "60" : "rgba(255,255,255,0.08)"}`, padding: "5px 10px", borderRadius: 8 }}>
                  <input type="checkbox" checked={f_ugroups.includes(g)} onChange={e => setF_ugroups(prev => e.target.checked ? [...prev, g] : prev.filter(x => x !== g))} style={{ accentColor: getColor(g, groups) }} />
                  <span style={{ color: f_ugroups.includes(g) ? getColor(g, groups) : "#94a3b8", fontSize: 13, fontWeight: 600 }}>{g}</span>
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 8 }}>Leave all unchecked to grant access to all groups (Superuser behavior).</div>
          </Field>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitAddUser} flex={2} color="#8b5cf6">Create User</Btn></div>
        </Modal>
      )}

      {modal === "addRole" && (
        <Modal title="Create Role" onClose={closeModal} maxWidth={540}>
          <Field label="Role Name *"><input style={iStyle} value={f_rname} onChange={e => setF_rname(e.target.value)} placeholder='e.g. "Co-Facilitator"' /></Field>
          <Field label="Permissions">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ALL_PERMISSIONS.map(p => (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={f_rperms.includes(p.id)} onChange={e => setF_rperms(prev => e.target.checked ? [...prev, p.id] : prev.filter(x => x !== p.id))} />
                  <span style={{ color: "#e2e8f0", fontSize: 13 }}>{p.label}</span>
                </label>
              ))}
            </div>
          </Field>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitAddRole} flex={2} color="#8b5cf6">Create Role</Btn></div>
        </Modal>
      )}

      {modal === "editRole" && editingRole && !editingRole.locked && (
        <Modal title={`Edit Role: ${editingRole.name}`} onClose={closeModal} maxWidth={540}>
          <Field label="Role Name"><input style={iStyle} value={f_rname} onChange={e => setF_rname(e.target.value)} /></Field>
          <Field label="Permissions">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ALL_PERMISSIONS.map(p => (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={f_rperms.includes(p.id)} onChange={e => setF_rperms(prev => e.target.checked ? [...prev, p.id] : prev.filter(x => x !== p.id))} />
                  <span style={{ color: "#e2e8f0", fontSize: 13 }}>{p.label}</span>
                </label>
              ))}
            </div>
          </Field>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitEditRole} flex={2} color="#8b5cf6">Save Role</Btn></div>
        </Modal>
      )}

      {modal === "editUser" && editingUser && (
        <Modal title={`Edit User: ${editingUser.name}`} onClose={closeModal} maxWidth={520}>
          <Field label="Full Name *"><input style={iStyle} value={f_uname} onChange={e => setF_uname(e.target.value)} /></Field>
          <Field label="Email (Login ID) *"><input style={iStyle} type="email" value={f_uemail} onChange={e => setF_uemail(e.target.value)} /></Field>
          <Field label="New PIN (leave blank to keep current)">
            <input style={{ ...iStyle, letterSpacing: 4, textAlign: "center" }} type="password" maxLength={6} value={f_upin}
              onChange={e => setF_upin(e.target.value.replace(/\D/g, "").slice(0,6))} placeholder="••••••  (optional)" />
          </Field>
          <Field label="Role">
            <select style={iStyle} value={f_urole} onChange={e => setF_urole(e.target.value)}>
              {roles.filter(r => !r.locked || editingUser.roleId === r.id).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Group Access">
            <div style={{ marginBottom: 8 }}>
              <button type="button" onClick={() => setF_ugroups(f_ugroups.length === groups.length ? [] : [...groups])}
                style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa", padding: "4px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                {f_ugroups.length === groups.length ? "Deselect All" : "Select All Groups"}
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {groups.map(g => (
                <label key={g} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", background: f_ugroups.includes(g) ? `${getColor(g, groups)}22` : "rgba(255,255,255,0.04)", border: `1px solid ${f_ugroups.includes(g) ? getColor(g, groups) + "60" : "rgba(255,255,255,0.08)"}`, padding: "5px 10px", borderRadius: 8 }}>
                  <input type="checkbox" checked={f_ugroups.includes(g)} onChange={e => setF_ugroups(prev => e.target.checked ? [...prev, g] : prev.filter(x => x !== g))} style={{ accentColor: getColor(g, groups) }} />
                  <span style={{ color: f_ugroups.includes(g) ? getColor(g, groups) : "#94a3b8", fontSize: 13, fontWeight: 600 }}>{g}</span>
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 8 }}>Leave all unchecked = access to all groups.</div>
          </Field>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitEditUser} flex={2} color="#8b5cf6">Save Changes</Btn></div>
        </Modal>
      )}

      {modal === "changePin" && (
        <Modal title="Change My PIN" onClose={closeModal} maxWidth={380}>
          <Field label="Current PIN">
            <input style={{ ...iStyle, letterSpacing: 4, textAlign: "center" }} type="password" maxLength={6} value={f_oldpin}
              onChange={e => setF_oldpin(e.target.value.replace(/\D/g, "").slice(0,6))} placeholder="••••••" />
          </Field>
          <Field label="New PIN">
            <input style={{ ...iStyle, letterSpacing: 4, textAlign: "center" }} type="password" maxLength={6} value={f_newpin}
              onChange={e => setF_newpin(e.target.value.replace(/\D/g, "").slice(0,6))} placeholder="••••••" />
          </Field>
          <Field label="Confirm New PIN">
            <input style={{ ...iStyle, letterSpacing: 4, textAlign: "center" }} type="password" maxLength={6} value={f_newpin2}
              onChange={e => setF_newpin2(e.target.value.replace(/\D/g, "").slice(0,6))} placeholder="••••••" />
          </Field>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={closeModal} variant="ghost">Cancel</Btn>
            <Btn flex={2} color="#3b82f6" onClick={() => {
              const me = appUsers.find(u => u.email === currentUser.email);
              if (!me || me.pin !== f_oldpin) { showToast("Current PIN is incorrect.", "#ef4444"); return; }
              if (f_newpin.length !== 6) { showToast("New PIN must be 6 digits.", "#ef4444"); return; }
              if (f_newpin !== f_newpin2) { showToast("PINs do not match.", "#ef4444"); return; }
              setAppUsers(prev => prev.map(u => u.email === currentUser.email ? { ...u, pin: f_newpin } : u));
              setF_oldpin(""); setF_newpin(""); setF_newpin2("");
              closeModal(); showToast("PIN changed successfully!");
            }}>Change PIN</Btn>
          </div>
        </Modal>
      )}

      {modal === "editHistRec" && (
        <Modal title={editingRec ? "Edit Attendance Record" : "Add Attendance Record"} onClose={closeModal} maxWidth={500}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Member">
              <select style={iStyle} value={f_hrec_person} onChange={e => setF_hrec_person(e.target.value)}>
                {activeMembersList.sort((a,b)=>a.name.localeCompare(b.name)).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Group">
              <select style={iStyle} value={f_hrec_group} onChange={e => setF_hrec_group(e.target.value)}>
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Date"><input type="date" style={iStyle} value={f_hrec_date} onChange={e => setF_hrec_date(e.target.value)} /></Field>
          <Field label="Status">
            <div style={{ display: "flex", gap: 8 }}>
              {["P","F","A"].map(s => (
                <button key={s} type="button" onClick={() => setF_hrec_status(s)}
                  style={{ flex: 1, padding: "10px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 14,
                    background: f_hrec_status === s ? (s==="A" ? "#ef4444" : s==="F" ? "#3b82f6" : "#10b981") : "rgba(255,255,255,0.07)",
                    color: f_hrec_status === s ? "#fff" : "#64748b" }}>
                  {s === "P" ? "P – Present" : s === "F" ? "F – Facilitator" : "A – Absent"}
                </button>
              ))}
            </div>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Book #"><input type="number" min="1" max="5" style={iStyle} value={f_hrec_book} onChange={e => setF_hrec_book(e.target.value)} /></Field>
            <Field label="Lesson #"><input type="number" min="1" max="40" style={iStyle} value={f_hrec_lesson} onChange={e => setF_hrec_lesson(e.target.value)} /></Field>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <Btn onClick={closeModal} variant="ghost">Cancel</Btn>
            <Btn onClick={submitHistRec} flex={2} color="#3b82f6">{editingRec ? "Save Changes" : "Add Record"}</Btn>
          </div>
        </Modal>
      )}

      {modal === "addQT" && (
        <Modal title="Log Quiet Time / Scripture" onClose={closeModal}>
          <Field label="Member">
            <select style={iStyle} value={f_qt_member} onChange={e => setF_qt_member(e.target.value)}>
              {activeMembersList.sort((a,b) => a.name.localeCompare(b.name)).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" style={iStyle} value={f_qt_date} onChange={e => setF_qt_date(e.target.value)} /></Field>
          <Field label="Quiet Time Days (this week)"><input type="number" min="0" max="7" style={iStyle} value={f_qt_days} onChange={e => setF_qt_days(e.target.value)} placeholder="0–7" /></Field>
          <Field label="Scripture Reference"><input style={iStyle} value={f_qt_ref} onChange={e => setF_qt_ref(e.target.value)} placeholder='e.g. "John 3:16"' /></Field>
          <Field label="Scripture Memorized?">
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={f_qt_mem} onChange={e => setF_qt_mem(e.target.checked)} />
              <span style={{ color: "#e2e8f0", fontSize: 14 }}>Yes, this scripture has been memorized</span>
            </label>
          </Field>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={closeModal} variant="ghost">Cancel</Btn><Btn onClick={submitAddQT} flex={2} color="#10b981">Save Record</Btn></div>
        </Modal>
      )}

      {/* ── GOOGLE DRIVE MODAL ── */}
      {gdriveModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "28px 28px 24px", width: "100%", maxWidth: 440, boxShadow: "0 25px 60px rgba(0,0,0,0.6)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <h3 style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 17, margin: 0 }}>☁ Google Drive Sync</h3>
                <p style={{ color: "#475569", fontSize: 12, margin: "4px 0 0" }}>
                  {gdriveConnected ? "Your account is connected." : "Using shared sync token."}
                </p>
              </div>
              <button onClick={() => setGdriveModal(false)} style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", width: 32, height: 32, borderRadius: 9, cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>

            {/* Status banner */}
            {gdriveSyncMsg && (
              <div style={{ marginBottom: 16, padding: "10px 14px", background: gdriveSyncMsg.startsWith("✓") ? "rgba(16,185,129,0.12)" : gdriveSyncMsg.startsWith("✗") ? "rgba(239,68,68,0.12)" : "rgba(59,130,246,0.12)", border: `1px solid ${gdriveSyncMsg.startsWith("✓") ? "rgba(16,185,129,0.3)" : gdriveSyncMsg.startsWith("✗") ? "rgba(239,68,68,0.3)" : "rgba(59,130,246,0.3)"}`, borderRadius: 10, fontSize: 13, color: gdriveSyncMsg.startsWith("✓") ? "#10b981" : gdriveSyncMsg.startsWith("✗") ? "#ef4444" : "#60a5fa" }}>
                {gdriveSyncing && <span style={{ marginRight: 6 }}>⟳</span>}
                {gdriveSyncMsg}
              </div>
            )}

            {/* Connection status */}
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 16px", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: gdriveConnected ? "#10b981" : "#f59e0b", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>
                    {gdriveConnected ? "Personal account connected" : "Using shared refresh token"}
                  </div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>
                    {gdriveConnected
                      ? "Your own Google account is linked for sync."
                      : "Shared token lets all users sync without their own Google login."}
                  </div>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Connect / Disconnect */}
              {!gdriveConnected ? (
                <button onClick={() => { setGdriveModal(false); startGoogleOAuth(); }}
                  disabled={gdriveSyncing}
                  style={{ background: "#4285f4", border: "none", color: "#fff", padding: "11px 16px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>G</span> Connect My Google Account
                </button>
              ) : (
                <button onClick={handleGDriveDisconnect}
                  disabled={gdriveSyncing}
                  style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", padding: "10px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Disconnect Google Account
                </button>
              )}

              {/* Push / Pull */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button onClick={handleGDrivePush} disabled={gdriveSyncing}
                  style={{ background: gdriveSyncing ? "rgba(59,130,246,0.3)" : "#3b82f6", border: "none", color: "#fff", padding: "11px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: gdriveSyncing ? "default" : "pointer" }}>
                  {gdriveSyncing ? "⟳ Working…" : "⬆ Push to Drive"}
                </button>
                <button onClick={handleGDrivePull} disabled={gdriveSyncing}
                  style={{ background: gdriveSyncing ? "rgba(16,185,129,0.2)" : "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.35)", color: "#10b981", padding: "11px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: gdriveSyncing ? "default" : "pointer" }}>
                  {gdriveSyncing ? "⟳ Working…" : "⬇ Pull from Drive"}
                </button>
              </div>

              {/* Tip */}
              <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 8, fontSize: 11, color: "#334155", lineHeight: 1.5 }}>
                <strong style={{ color: "#475569" }}>Push</strong> saves all local data to Drive.<br />
                <strong style={{ color: "#475569" }}>Pull</strong> replaces local data with the Drive version.<br />
                Sync also runs automatically on page load using the shared token.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── HEADER ── */}
      <div style={{ background: "rgba(15,23,42,0.97)", borderBottom: "1px solid rgba(255,255,255,0.07)", position: "sticky", top: 0, zIndex: 50, backdropFilter: "blur(12px)" }}>
        {/* Top bar: logo + user */}
        <div style={{ padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 52 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <div style={{ width: 28, height: 28, background: "linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>⚔</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Every Man A Warrior</div>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: 1, textTransform: "uppercase" }}>Attendance Tracker</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {can("takeAttendance") && (
              <button onClick={() => { const g = visibleGroups()[0] || groups[0]; startSession(g); }}
                style={{ background: "#3b82f6", border: "none", color: "#fff", padding: "6px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                + Attendance
              </button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", background: "rgba(255,255,255,0.05)", borderRadius: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{initials(currentUser.name)}</div>
              <span style={{ fontSize: 11, color: "#94a3b8", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.name.split(" ")[0]}</span>
              {/* Google Drive status button — inside user pill to save space */}
              <button onClick={() => { setGdriveModal(true); setGdriveSyncMsg(""); }}
                title="Google Drive Sync"
                style={{ background: gdriveConnected ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.08)", border: `1px solid ${gdriveConnected ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.15)"}`, color: gdriveConnected ? "#10b981" : "#94a3b8", cursor: "pointer", fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 5, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 3 }}>
                ☁<span style={{ width: 5, height: 5, borderRadius: "50%", background: gdriveConnected ? "#10b981" : "#475569", display: "inline-block" }} />
              </button>
              <button onClick={() => { setF_oldpin(""); setF_newpin(""); setF_newpin2(""); setModal("changePin"); }} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "#cbd5e1", cursor: "pointer", fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 5, whiteSpace: "nowrap" }}>PIN</button>
              <button onClick={() => setCurrentUser(null)} style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.25)", color: "#f87171", cursor: "pointer", fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 5, whiteSpace: "nowrap" }}>Sign Out</button>
            </div>
          </div>
        </div>
        {/* Nav row — scrollable horizontally, no page shift */}
        <div style={{ overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <nav style={{ display: "flex", gap: 1, padding: "0 12px", minWidth: "max-content" }}>
            {navItems.map(n => (
              <button key={n.id} onClick={() => setView(n.id)}
                style={{ padding: "8px 12px", borderRadius: 0, fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer", whiteSpace: "nowrap",
                  background: "transparent",
                  color: view === n.id ? "#60a5fa" : "#64748b",
                  borderBottom: view === n.id ? "2px solid #3b82f6" : "2px solid transparent" }}>
                {n.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 16px" }}>

        {/* ─── DASHBOARD ─────────────────────────────────────────────────── */}
        {view === "dashboard" && can("dashboard") && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 28 }}>
              {[
                { label: "Active Members", value: activeMembersList.length, sub: `across ${groups.length} groups`, icon: "👥", color: "#3b82f6" },
                { label: "Overall Attendance", value: `${overallRate}%`, sub: `${totalPresent} of ${allHistory.length} sessions`, icon: "📊", color: "#10b981" },
                { label: "Sessions Logged", value: sessionDates.length, sub: "Nov 2025 – present", icon: "📅", color: "#f59e0b" },
                { label: "Last Session", value: latestCount, sub: `present on ${fmtDate(latestDate)}`, icon: "✅", color: "#8b5cf6" },
              ].map(c => (
                <div key={c.label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "18px 20px" }}>
                  <div style={{ fontSize: 22, marginBottom: 8 }}>{c.icon}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600, marginTop: 2 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>{c.sub}</div>
                </div>
              ))}
            </div>

            {/* Last Session by Group tile */}
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 24px", marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>Last Session by Group</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
                {visibleGroups().map(g => {
                  const gDates = allHistory.filter(r=>r.group===g).map(r=>r.date);
                  const lastDate = gDates.length ? gDates.reduce((a,b)=>a>b?a:b) : null;
                  const count = lastDate ? allHistory.filter(r=>r.group===g&&r.date===lastDate&&(r.status==="P"||r.status==="F")).length : 0;
                  const total = lastDate ? allHistory.filter(r=>r.group===g&&r.date===lastDate).length : 0;
                  return (
                    <div key={g} style={{ background: `${getColor(g,groups)}12`, border: `1px solid ${getColor(g,groups)}30`, borderRadius: 10, padding: "12px 14px" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: getColor(g,groups), marginBottom: 4 }}>{g}</div>
                      {lastDate ? <>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>{fmtDate(lastDate)}</div>
                        <div style={{ fontSize: 12, color: "#10b981", fontWeight: 600, marginTop: 3 }}>{count}/{total} present</div>
                      </> : <div style={{ fontSize: 11, color: "#334155" }}>No sessions yet</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16, marginBottom: 28 }}>
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 24px" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1, marginBottom: 18 }}>Session Trend</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={trendData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fill: "#475569", fontSize: 10 }} />
                    <YAxis tick={{ fill: "#475569", fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#f1f5f9", fontSize: 12 }} />
                    <Line type="monotone" dataKey="present" stroke="#3b82f6" strokeWidth={2.5} dot={{ fill: "#3b82f6", r: 3 }} name="Present" />
                    <Line type="monotone" dataKey="absent" stroke="#ef4444" strokeWidth={2} dot={{ fill: "#ef4444", r: 3 }} name="Absent" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 24px" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1, marginBottom: 18 }}>By Group</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={groupStats} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="group" tick={{ fill: "#475569", fontSize: 10 }} />
                    <YAxis tick={{ fill: "#475569", fontSize: 10 }} domain={[0, 100]} unit="%" />
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#f1f5f9", fontSize: 12 }} formatter={v => [`${v}%`, "Attendance"]} />
                    <Bar dataKey="rate" radius={[4, 4, 0, 0]} fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>Groups</h3>
              {can("manage") && <button onClick={openAddGroup} style={{ background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ New Group</button>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {groupStats.filter(g => visibleGroups().includes(g.group)).map(g => {
                const prog = groupProgress[g.group] || {};
                return (
                  <div key={g.group} onClick={() => { setSelectedGroup(g.group); setView("roster"); }}
                    style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${g.color}30`, borderRadius: 12, padding: "16px 18px", cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: g.color }}>{g.group}</div>
                      <div style={{ fontSize: 11, color: "#475569" }}>{g.members}</div>
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#f1f5f9", margin: "10px 0 4px" }}>{g.rate}%</div>
                    <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${g.rate}%`, background: g.color, borderRadius: 2 }} />
                    </div>
                    <div style={{ fontSize: 10, color: "#475569", marginTop: 6 }}>
                      {facilitators[g.group] ? `Fac: ${facilitators[g.group].split(" ")[0]}` : "No facilitator"}
                      {prog.book && <span style={{ marginLeft: 6 }}>· Bk {prog.book} L{prog.lesson}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ─── ROSTER ────────────────────────────────────────────────────── */}
        {view === "roster" && can("roster") && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input placeholder="Search members…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...iStyle, width: 210 }} />
                {["All", ...visibleGroups()].map(g => (
                  <button key={g} onClick={() => setSelectedGroup(g)}
                    style={{ padding: "6px 13px", borderRadius: 8, fontSize: 13, fontWeight: 500, border: "none", cursor: "pointer",
                      background: selectedGroup === g ? (getColor(g, groups) || "#3b82f6") : "rgba(255,255,255,0.07)",
                      color: selectedGroup === g ? "#fff" : "#64748b" }}>
                    {g}
                  </button>
                ))}
              </div>
              {can("manage") && <button onClick={openAddMember} style={{ background: "#3b82f6", border: "none", color: "#fff", padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>+ Add Member</button>}
            </div>

            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 44px", padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.2)" }}>
                {["Member", "Group", "Attended", "Rate", "Last Session", ""].map(h => (
                  <div key={h} style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.8 }}>{h}</div>
                ))}
              </div>
              {filteredMembers.map((m, i) => {
                const s = memberStats[m.name] || { total: 0, present: 0, rate: 0 };
                const lastRec = allHistory.filter(r => r.person === m.name).sort((a, b) => b.date.localeCompare(a.date))[0];
                const rateColor = s.rate >= 75 ? "#10b981" : s.rate >= 50 ? "#f59e0b" : "#ef4444";
                return (
                  <div key={m.name}
                    style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 44px", padding: "13px 20px", borderBottom: i < filteredMembers.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none", alignItems: "center" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <MemberAvatar name={m.name} group={m.group} groups={groups} photo={m.photo} size={34} fontSize={12} />
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: "#475569" }}>{m.phone || "—"}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: getColor(m.group, groups) }}>{m.group}</div>
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>{s.present} / {s.total}</div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: rateColor }}>{s.rate}%</div>
                      <div style={{ height: 3, width: 55, background: "rgba(255,255,255,0.08)", borderRadius: 2, marginTop: 3 }}>
                        <div style={{ height: "100%", width: `${s.rate}%`, background: rateColor, borderRadius: 2 }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "#475569" }}>{lastRec ? fmtDate(lastRec.date) : "—"}</div>
                    {can("manage") && <button onClick={() => openEditMember(m)} title="Change group"
                      style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", width: 30, height: 30, borderRadius: 7, cursor: "pointer", fontSize: 13 }}>✎</button>}
                  </div>
                );
              })}
              {filteredMembers.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#475569" }}>No members found</div>}
            </div>
          </>
        )}

        {/* ─── SESSIONS ──────────────────────────────────────────────────── */}
        {view === "sessions" && can("sessions") && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Session History</h2>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {visibleGroups().map(g => (
                  <button key={g} onClick={() => setSessionGroup(g)}
                    style={{ padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer",
                      background: sessionGroup === g ? getColor(g, groups) : "rgba(255,255,255,0.07)",
                      color: sessionGroup === g ? "#fff" : "#64748b" }}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
            {sessionDates.slice().reverse().map(date => {
              const recs = allHistory.filter(r => r.date === date);
              const groupRecs = recs.filter(r => r.group === sessionGroup).sort((a, b) => a.person.localeCompare(b.person));
              const present = recs.filter(r => r.status === "P" || r.status === "F").length;
              const firstRec = recs[0];
              const allGroupsOnDate = [...new Set(recs.map(r => r.group))];
              function deleteSession(dateToDelete, grpFilter) {
                const label = grpFilter
                  ? `Delete all ${grpFilter} records for ${fmtDate(dateToDelete)}?`
                  : `Delete ALL records for ${fmtDate(dateToDelete)} across all groups (${recs.length} records)?`;
                if (window.confirm(label)) {
                  setAllHistory(prev => prev.filter(r =>
                    r.date !== dateToDelete || (grpFilter && r.group !== grpFilter)
                  ));
                  showToast(`Session records deleted.`, "#ef4444");
                }
              }
              return (
                <div key={date} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, marginBottom: 14, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <div>
                      <span style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}>{fmtDate(date)}</span>
                      {firstRec?.book && <span style={{ marginLeft: 12, fontSize: 11, color: "#475569", background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 5 }}>Book {firstRec.book} · Lesson {firstRec.lesson}</span>}
                      <span style={{ marginLeft: 10, fontSize: 11, color: "#334155" }}>{allGroupsOnDate.join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ color: "#10b981", fontSize: 13 }}>✓ {present} present</span>
                      <span style={{ color: "#ef4444", fontSize: 13 }}>✗ {recs.length - present} absent</span>
                      {can("historyEditor") && (
                        <div style={{ display: "flex", gap: 4 }}>
                          {groupRecs.length > 0 && (
                            <button onClick={() => deleteSession(date, sessionGroup)}
                              title={`Delete ${sessionGroup} records for this date`}
                              style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                              🗑 {sessionGroup}
                            </button>
                          )}
                          <button onClick={() => deleteSession(date, null)}
                            title="Delete ALL records for this date"
                            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                            🗑 All Groups
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {groupRecs.length > 0 ? (
                    <div style={{ padding: "10px 20px", display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {groupRecs.map(r => (
                        <div key={r.person} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "5px 10px" }}>
                          <div style={{ width: 22, height: 22, borderRadius: "50%", background: getColor(r.group, groups), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff" }}>{initials(r.person)}</div>
                          <span style={{ fontSize: 12, color: "#94a3b8" }}>{r.person}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: r.status === "A" ? "#ef4444" : r.status === "F" ? "#3b82f6" : "#10b981" }}>{r.status}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 20px", color: "#334155", fontSize: 12 }}>No records for {sessionGroup} this session</div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ─── QT TRACKING ───────────────────────────────────────────────── */}
        {view === "qttracking" && can("qtTracking") && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>Quiet Time & Scripture Memory</h2>
                <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>Track weekly quiet time days and scripture memorization progress.</p>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                {can("exportData") && <button onClick={exportQTCSV} style={{ background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>⬇ Export CSV</button>}
                <button onClick={openAddQT} style={{ background: "#10b981", border: "none", color: "#fff", padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+ Log QT</button>
              </div>
            </div>

            {/* QT summary per member */}
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden", marginBottom: 20 }}>
              <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8 }}>Member Summary</div>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "10px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.2)" }}>
                {["Member","Group","Avg QT Days/Wk","Scriptures Memorized"].map(h => <div key={h} style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.8 }}>{h}</div>)}
              </div>
              {activeMembersList.sort((a,b) => a.name.localeCompare(b.name)).map((m, i, arr) => {
                const recs = qtRecords.filter(r => r.person === m.name);
                const avgDays = recs.length ? (recs.reduce((s, r) => s + r.quietTimeDays, 0) / recs.length).toFixed(1) : "—";
                const memorized = recs.filter(r => r.scriptureMemorized).length;
                return (
                  <div key={m.name} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "11px 20px", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <MemberAvatar name={m.name} group={m.group} groups={groups} photo={m.photo} size={30} fontSize={11} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{m.name}</span>
                    </div>
                    <span style={{ fontSize: 12, color: getColor(m.group, groups), fontWeight: 600 }}>{m.group}</span>
                    <span style={{ fontSize: 13, color: avgDays === "—" ? "#475569" : avgDays >= 5 ? "#10b981" : avgDays >= 3 ? "#f59e0b" : "#ef4444", fontWeight: 600 }}>{avgDays}</span>
                    <span style={{ fontSize: 13, color: memorized > 0 ? "#10b981" : "#475569" }}>{memorized > 0 ? `✓ ${memorized}` : "—"}</span>
                  </div>
                );
              })}
            </div>

            {/* Recent QT records */}
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8 }}>Recent Records ({qtRecords.length} total)</div>
              {qtRecords.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#475569" }}>No QT records yet. Click "+ Log QT" to add one.</div>}
              {qtRecords.slice().sort((a,b) => b.date.localeCompare(a.date)).slice(0, 50).map((r, i, arr) => (
                <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 30, height: 30, borderRadius: "50%", background: getColor(r.group, groups), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>{initials(r.person)}</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{r.person}</div>
                      <div style={{ fontSize: 11, color: "#475569" }}>{fmtDate(r.date)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: r.quietTimeDays >= 5 ? "#10b981" : r.quietTimeDays >= 3 ? "#f59e0b" : "#ef4444" }}>{r.quietTimeDays}</div>
                      <div style={{ fontSize: 10, color: "#475569" }}>days</div>
                    </div>
                    {r.scriptureRef && <div style={{ background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 8, padding: "4px 10px", fontSize: 12, color: "#a78bfa" }}>📖 {r.scriptureRef}</div>}
                    {r.scriptureMemorized && <div style={{ background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 8, padding: "4px 10px", fontSize: 12, color: "#10b981" }}>✓ Memorized</div>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ─── MANAGE ────────────────────────────────────────────────────── */}
        {/* ─── PROGRESS GRID ─────────────────────────────────────────── */}
        {view === "progress" && can("progressGrid") && (() => {
          const cols = [
            ...Array.from({length:9},(_,i)=>({book:1,lesson:i+1})),
            ...Array.from({length:10},(_,i)=>({book:2,lesson:i+1})),
            ...Array.from({length:10},(_,i)=>({book:3,lesson:i+1})),
          ];
          const pgMembers = activeMembersList
            .filter(m => progGroup === "All" || m.group === progGroup)
            .sort((a,b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
          const rows = pgMembers.map(m => {
            const attended = allHistory.filter(r => r.person===m.name && (r.status==="P"||r.status==="F"));
            const cells = {};
            attended.forEach(r => { if (r.book && r.lesson) cells[`${r.book}_${r.lesson}`] = true; });
            return { member: m.name, group: m.group, cells };
          });
          const colStyle = { minWidth: 34, width: 34, textAlign: "center", fontSize: 10, padding: "0 2px", flexShrink: 0 };
          const bookGroups = [
            { book: 1, label: "Book 1", lessons: 9, color: "#3b82f6" },
            { book: 2, label: "Book 2", lessons: 10, color: "#10b981" },
            { book: 3, label: "Book 3", lessons: 10, color: "#f59e0b" },
          ];
          return (
            <>

              <div style={{ marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>Progress Grid</h2>
                  <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>Lesson completion per member. ✓ = attended (P or F). Prints landscape.</p>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <select style={{ ...iStyle, width: "auto" }} value={progGroup} onChange={e => setProgGroup(e.target.value)}>
                    <option value="All">All Groups</option>
                    {visibleGroups().map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                  {can("exportData") && (
                    <button onClick={() => exportProgressCSV(rows, cols)}
                      style={{ background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                      ⬇ Export CSV
                    </button>
                  )}
                  <button onClick={() => printProgressGrid(rows, cols, progGroup)}
                    style={{ background: "#3b82f6", border: "none", color: "#fff", padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                    🖨 Print Landscape
                  </button>
                </div>
              </div>

              {/* Frozen-header progress grid using CSS sticky positioning */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "auto", maxHeight: "70vh" }}>
                <table style={{ borderCollapse: "separate", borderSpacing: 0, minWidth: 900 }}>
                  <thead>
                    {/* Book header row */}
                    <tr>
                      <th colSpan={2} style={{ position: "sticky", top: 0, left: 0, zIndex: 30, background: "#0f172a", borderBottom: "1px solid rgba(255,255,255,0.1)", borderRight: "2px solid rgba(255,255,255,0.15)", padding: "6px 16px", fontSize: 10, fontWeight: 700, color: "#475569", textAlign: "left", minWidth: 280 }}>
                        MEMBER / GROUP
                      </th>
                      {bookGroups.map(bg => (
                        <th key={bg.book} colSpan={bg.lessons}
                          style={{ position: "sticky", top: 0, zIndex: 20, background: `${bg.color}22`, borderBottom: "1px solid rgba(255,255,255,0.1)", borderLeft: `2px solid ${bg.color}60`, padding: "6px 0", textAlign: "center", fontSize: 11, fontWeight: 700, color: bg.color }}>
                          {bg.label}
                        </th>
                      ))}
                    </tr>
                    {/* Lesson number row */}
                    <tr>
                      <th style={{ position: "sticky", top: 33, left: 0, zIndex: 30, background: "#0d1526", borderBottom: "2px solid rgba(255,255,255,0.12)", borderRight: "1px solid rgba(255,255,255,0.08)", padding: "4px 16px", fontSize: 10, fontWeight: 700, color: "#475569", minWidth: 200, textAlign: "left" }}>
                        MEMBER
                      </th>
                      <th style={{ position: "sticky", top: 33, left: 200, zIndex: 30, background: "#0d1526", borderBottom: "2px solid rgba(255,255,255,0.12)", borderRight: "2px solid rgba(255,255,255,0.15)", padding: "4px 8px", fontSize: 10, fontWeight: 700, color: "#475569", minWidth: 70, textAlign: "left" }}>
                        GROUP
                      </th>
                      {cols.map((col,i) => (
                        <th key={i} style={{ position: "sticky", top: 33, zIndex: 20, background: "#0d1526", borderBottom: "2px solid rgba(255,255,255,0.12)", borderLeft: col.lesson===1?"2px solid rgba(255,255,255,0.12)":"none", padding: "4px 2px", fontSize: 9, fontWeight: 700, color: col.book===1?"#3b82f6":col.book===2?"#10b981":"#f59e0b", textAlign: "center", minWidth: 32 }}>
                          L{col.lesson}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row,ri) => {
                      const isNewGroup = ri===0 || rows[ri-1].group !== row.group;
                      return (
                        <>
                          {isNewGroup && progGroup==="All" && (
                            <tr key={`grp-${row.group}`}>
                              <td colSpan={2 + cols.length} style={{ position: "sticky", left: 0, background: `${getColor(row.group,groups)}18`, borderBottom: "1px solid rgba(255,255,255,0.05)", padding: "4px 16px" }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: getColor(row.group,groups) }}>{row.group}</span>
                              </td>
                            </tr>
                          )}
                          <tr key={ri} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.04)"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                            <td style={{ position: "sticky", left: 0, zIndex: 10, background: "inherit", borderBottom: "1px solid rgba(255,255,255,0.04)", borderRight: "1px solid rgba(255,255,255,0.06)", padding: "7px 16px", fontSize: 12, color: "#e2e8f0", fontWeight: 500, whiteSpace: "nowrap", minWidth: 200 }}>
                              {row.member}
                            </td>
                            <td style={{ position: "sticky", left: 200, zIndex: 10, background: "inherit", borderBottom: "1px solid rgba(255,255,255,0.04)", borderRight: "2px solid rgba(255,255,255,0.12)", padding: "7px 8px", fontSize: 11, color: getColor(row.group,groups), fontWeight: 600, whiteSpace: "nowrap", minWidth: 70 }}>
                              {row.group}
                            </td>
                            {cols.map((col,ci) => (
                              <td key={ci} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", borderLeft: col.lesson===1?"1px solid rgba(255,255,255,0.08)":"none", padding: "7px 2px", textAlign: "center", fontSize: 13, fontWeight: 700, color: row.cells[`${col.book}_${col.lesson}`] ? "#10b981" : "#1e293b" }}>
                                {row.cells[`${col.book}_${col.lesson}`] ? "✓" : "·"}
                              </td>
                            ))}
                          </tr>
                        </>
                      );
                    })}
                    {rows.length===0 && (
                      <tr><td colSpan={2+cols.length} style={{ padding: 32, textAlign: "center", color: "#334155" }}>No members to display</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

            </>
          );
        })()}

        {/* ─── MESSAGING ──────────────────────────────────────────────── */}
        {view === "messaging" && can("messaging") && (() => {
          const msgMembers = activeMembersList
            .filter(m => msgGroup === "All" || m.group === msgGroup)
            .sort((a,b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

          // Build message for a given member, replacing template tokens
          function buildMsg(member) {
            const s = memberStats[member.name] || { rate: 0 };
            const custom = msgCustom.trim();
            const base = custom || `Hi {first}, hope you\'re doing well! We\'d love to see you at Every Man A Warrior. Keep pressing forward! ⚔`;
            return base
              .replace(/{first}/g, member.name.split(" ")[0])
              .replace(/{name}/g, member.name)
              .replace(/{group}/g, member.group)
              .replace(/{rate}/g, s.rate + "%");
          }

          // Build a single SMS/email href
          function smsHref(m) {
            if (!m.phone) return null;
            return `sms:${m.phone.replace(/\D/g,"")}?body=${encodeURIComponent(buildMsg(m))}`;
          }
          function emailHref(m) {
            if (!m.email) return null;
            return `mailto:${m.email}?subject=Every Man A Warrior&body=${encodeURIComponent(buildMsg(m))}`;
          }

          // Build group SMS (opens one text to all phone numbers separated by comma — works on iOS)
          function groupSmsHref() {
            const phones = msgMembers.filter(m=>m.phone).map(m=>m.phone.replace(/\D/g,"")).join(",");
            if (!phones) return null;
            const body = (msgCustom.trim() || "Hi all, hope to see you at Every Man A Warrior! ⚔")
              .replace(/{first}/g,"").replace(/{name}/g,"").replace(/{group}/g,msgGroup).replace(/{rate}/g,"");
            return `sms:${phones}?body=${encodeURIComponent(body)}`;
          }
          function groupEmailHref() {
            const emails = msgMembers.filter(m=>m.email).map(m=>m.email).join(",");
            if (!emails) return null;
            const body = (msgCustom.trim() || "Hi all, hope to see you at Every Man A Warrior! ⚔")
              .replace(/{first}/g,"").replace(/{name}/g,"").replace(/{group}/g,msgGroup).replace(/{rate}/g,"");
            return `mailto:${emails}?subject=Every Man A Warrior&body=${encodeURIComponent(body)}`;
          }

          const withPhone  = msgMembers.filter(m=>m.phone).length;
          const withEmail  = msgMembers.filter(m=>m.email).length;

          return (
            <>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>Messaging</h2>
                <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>Text or email members individually, by group, or all at once.</p>
              </div>

              {/* Controls */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 22px", marginBottom: 20 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Filter by Group</label>
                    <select style={iStyle} value={msgGroup} onChange={e => setMsgGroup(e.target.value)}>
                      <option value="All">All Groups</option>
                      {visibleGroups().map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 8 }}>
                    <div style={{ fontSize: 12, color: "#475569" }}>
                      {msgMembers.length} members · {withPhone} have phone · {withEmail} have email
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {groupSmsHref() && (
                        <a href={groupSmsHref()} style={{ flex: 1, background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "8px 10px", borderRadius: 9, fontSize: 12, fontWeight: 700, textDecoration: "none", textAlign: "center" }}>
                          💬 Text {msgGroup === "All" ? "Everyone" : msgGroup} ({withPhone})
                        </a>
                      )}
                      {groupEmailHref() && (
                        <a href={groupEmailHref()} style={{ flex: 1, background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa", padding: "8px 10px", borderRadius: 9, fontSize: 12, fontWeight: 700, textDecoration: "none", textAlign: "center" }}>
                          📧 Email {msgGroup === "All" ? "Everyone" : msgGroup} ({withEmail})
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                {/* Message template editor */}
                <div>
                  <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
                    Message Template
                    <span style={{ marginLeft: 8, color: "#334155", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                      — use <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, color: "#94a3b8" }}>{"{first}"}</code> {" "}
                      <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, color: "#94a3b8" }}>{"{name}"}</code> {" "}
                      <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, color: "#94a3b8" }}>{"{group}"}</code>
                    </span>
                  </label>
                  <textarea style={{ ...iStyle, height: 80, resize: "vertical", fontFamily: "inherit" }}
                    value={msgCustom}
                    onChange={e => setMsgCustom(e.target.value)}
                    placeholder="Hi {first}, hope you're doing well! We'd love to see you at Every Man A Warrior. Keep pressing forward! ⚔"
                  />
                  <div style={{ fontSize: 11, color: "#334155", marginTop: 4 }}>Leave blank to use the placeholder. Individual send shows a live preview per member.</div>
                </div>
              </div>

              {/* Member list */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: "10px 20px", background: "rgba(0,0,0,0.2)", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.8 }}>Individual Messages</span>
                  <span style={{ fontSize: 11, color: "#334155" }}>Click Text or Email to open your messaging app</span>
                </div>
                {msgMembers.map((m, i) => {
                  const preview = buildMsg(m);
                  const sms = smsHref(m);
                  const email = emailHref(m);
                  return (
                    <div key={m.name} style={{ borderBottom: i < msgMembers.length-1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <MemberAvatar name={m.name} group={m.group} groups={groups} photo={m.photo} size={32} fontSize={11} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{m.name}</div>
                          <div style={{ fontSize: 11, color: getColor(m.group, groups) }}>{m.group}</div>
                        </div>
                        {/* Preview toggle */}
                        <button onClick={() => setMsgEditingFor(msgEditingFor === m.name ? null : m.name)}
                          style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>
                          {msgEditingFor === m.name ? "▲ Hide" : "▼ Preview"}
                        </button>
                        {sms
                          ? <a href={sms} style={{ background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "5px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>💬 Text</a>
                          : <span style={{ color: "#334155", fontSize: 11, padding: "5px 10px" }}>No phone</span>}
                        {email
                          ? <a href={email} style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa", padding: "5px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>📧 Email</a>
                          : <span style={{ color: "#334155", fontSize: 11, padding: "5px 10px" }}>No email</span>}
                      </div>
                      {msgEditingFor === m.name && (
                        <div style={{ padding: "0 20px 12px 64px" }}>
                          <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>
                            {preview}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {msgMembers.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#334155" }}>No members in this group</div>}
              </div>
            </>
          );
        })()}

        {/* ─── REMINDERS ───────────────────────────────────────────────── */}
        {view === "reminders" && can("reminders") && (() => {
          const threshold = Number(reminderThreshold) || 60;
          const belowThreshold = activeMembersList
            .filter(m => {
              const s = memberStats[m.name];
              return s && s.total >= 2 && s.rate < threshold;
            })
            .sort((a,b) => (memberStats[a.name]?.rate||0) - (memberStats[b.name]?.rate||0));

          function buildReminderMsg(member) {
            const s = memberStats[member.name] || { rate: 0 };
            return reminderTemplate
              .replace(/{first}/g, member.name.split(" ")[0])
              .replace(/{name}/g, member.name)
              .replace(/{group}/g, member.group)
              .replace(/{rate}/g, s.rate + "%");
          }

          return (
            <>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>Attendance Reminders</h2>
                <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>Members below the attendance threshold. Edit the message then send individually.</p>
              </div>

              {/* Settings */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 22px", marginBottom: 20 }}>
                <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 20, alignItems: "start" }}>
                  <div>
                    <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Threshold</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="number" min="1" max="100" style={{ ...iStyle, width: 70 }}
                        value={reminderThreshold} onChange={e => setReminderThreshold(e.target.value)} />
                      <span style={{ color: "#64748b", fontSize: 13 }}>% attendance</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#334155", marginTop: 6 }}>{belowThreshold.length} member{belowThreshold.length !== 1 ? "s" : ""} below threshold</div>
                  </div>
                  <div>
                    <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
                      Reminder Message Template
                      <span style={{ marginLeft: 8, color: "#334155", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                        — <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, color: "#94a3b8" }}>{"{first}"}</code>{" "}
                        <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, color: "#94a3b8" }}>{"{name}"}</code>{" "}
                        <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, color: "#94a3b8" }}>{"{rate}"}</code>
                      </span>
                    </label>
                    <textarea style={{ ...iStyle, height: 75, resize: "vertical", fontFamily: "inherit" }}
                      value={reminderTemplate}
                      onChange={e => setReminderTemplate(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Member cards */}
              {belowThreshold.length === 0 && (
                <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 14, padding: 32, textAlign: "center", color: "#10b981", fontSize: 15, fontWeight: 600 }}>
                  🎉 All members are above {threshold}% attendance!
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
                {belowThreshold.map(m => {
                  const s = memberStats[m.name];
                  const msg = buildReminderMsg(m);
                  const smsLink = m.phone ? `sms:${m.phone.replace(/\D/g,"")}?body=${encodeURIComponent(msg)}` : null;
                  const emailLink = m.email ? `mailto:${m.email}?subject=We miss you at EMAW!&body=${encodeURIComponent(msg)}` : null;
                  return (
                    <div key={m.name} style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, padding: "14px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                        <MemberAvatar name={m.name} group={m.group} groups={groups} photo={m.photo} size={34} fontSize={12} />
                        <div style={{ flex: 1 }}>
                          <div style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 13 }}>{m.name}</div>
                          <div style={{ color: "#ef4444", fontSize: 12, fontWeight: 700 }}>{s.rate}% · {m.group}</div>
                        </div>
                      </div>
                      {/* Message preview */}
                      <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 7, padding: "8px 10px", fontSize: 11, color: "#94a3b8", marginBottom: 10, fontStyle: "italic", lineHeight: 1.5 }}>
                        {msg}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {smsLink
                          ? <a href={smsLink} style={{ flex: 1, background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, textDecoration: "none", textAlign: "center" }}>💬 Text</a>
                          : <span style={{ flex: 1, opacity: 0.4, background: "rgba(255,255,255,0.04)", padding: "6px 10px", borderRadius: 7, fontSize: 11, textAlign: "center", color: "#64748b" }}>No phone</span>}
                        {emailLink
                          ? <a href={emailLink} style={{ flex: 1, background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa", padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, textDecoration: "none", textAlign: "center" }}>📧 Email</a>
                          : <span style={{ flex: 1, opacity: 0.4, background: "rgba(255,255,255,0.04)", padding: "6px 10px", borderRadius: 7, fontSize: 11, textAlign: "center", color: "#64748b" }}>No email</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}

        {view === "manage" && can("manage") && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
              {/* Groups */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <div>
                    <h3 style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16, margin: 0 }}>Groups</h3>
                    <p style={{ color: "#475569", fontSize: 12, margin: "2px 0 0" }}>{groups.length} active groups</p>
                  </div>
                  <button onClick={openAddGroup} style={{ background: "#10b981", border: "none", color: "#fff", padding: "7px 14px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+ New Group</button>
                </div>
                <div>
                  {groupStats.map((g, i) => {
                    const prog = groupProgress[g.group] || {};
                    return (
                      <div key={g.group} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 22px", borderBottom: i < groupStats.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{ width: 11, height: 11, borderRadius: "50%", background: g.color }} />
                          <div>
                            <div style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 14 }}>{g.group}</div>
                            <div style={{ color: "#475569", fontSize: 11 }}>{facilitators[g.group] || "No facilitator"}</div>
                            <div style={{ color: "#60a5fa", fontSize: 11, fontWeight: 600 }}>{prog.book ? `📖 Book ${prog.book} · Lesson ${prog.lesson}` : "No progress set"}</div>
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ color: "#94a3b8", fontSize: 12 }}>{g.members} members</div>
                            <div style={{ color: g.rate >= 75 ? "#10b981" : g.rate >= 50 ? "#f59e0b" : "#ef4444", fontSize: 12, fontWeight: 600 }}>{g.rate}%</div>
                          </div>
                          <button onClick={() => openEditGroup(g.group)} style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", width: 28, height: 28, borderRadius: 7, cursor: "pointer", fontSize: 12 }}>✎</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Members */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <div>
                    <h3 style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16, margin: 0 }}>Members</h3>
                    <p style={{ color: "#475569", fontSize: 12, margin: "2px 0 0" }}>{activeMembersList.length} active · {members.filter(m => m.group === "Inactive").length} inactive</p>
                  </div>
                  <button onClick={openAddMember} style={{ background: "#3b82f6", border: "none", color: "#fff", padding: "7px 14px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+ New Member</button>
                </div>
                <div style={{ maxHeight: 460, overflowY: "auto" }}>
                  {members.filter(m => m.group !== "Inactive").sort((a, b) => a.name.localeCompare(b.name)).map((m, i, arr) => (
                    <div key={m.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 22px", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <MemberAvatar name={m.name} group={m.group} groups={groups} photo={m.photo} size={32} fontSize={11} />
                        <div>
                          <div style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                          <div style={{ color: "#475569", fontSize: 11 }}>{m.phone || "—"}</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: getColor(m.group, groups), background: `${getColor(m.group, groups)}18`, padding: "3px 9px", borderRadius: 6 }}>{m.group}</span>
                        <button onClick={() => openEditMember(m)} style={{ background: "rgba(255,255,255,0.07)", border: "none", color: "#94a3b8", width: 28, height: 28, borderRadius: 7, cursor: "pointer", fontSize: 12 }}>✎</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Inactive */}
            {members.filter(m => m.group === "Inactive").length > 0 && (
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ padding: "14px 22px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <h3 style={{ color: "#475569", fontWeight: 600, fontSize: 12, margin: 0, textTransform: "uppercase", letterSpacing: 1 }}>Inactive Members · {members.filter(m => m.group === "Inactive").length}</h3>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "14px 22px" }}>
                  {members.filter(m => m.group === "Inactive").map(m => (
                    <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "6px 12px" }}>
                      <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#475569", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff" }}>{initials(m.name)}</div>
                      <span style={{ color: "#64748b", fontSize: 13 }}>{m.name}</span>
                      <button onClick={() => openEditMember(m)} style={{ background: "rgba(59,130,246,0.15)", border: "none", color: "#60a5fa", padding: "2px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Reassign</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ─── HISTORY EDITOR ────────────────────────────────────────── */}
        {view === "history" && can("historyEditor") && (() => {
          const hDates = [...new Set(allHistory.map(r=>r.date))].sort().reverse();
          const filteredHist = allHistory.filter(r =>
            (histGroup === "All" || r.group === histGroup) &&
            (histDate === "" || r.date === histDate)
          ).sort((a,b) => b.date.localeCompare(a.date) || a.person.localeCompare(b.person));
          const sessionGroups = histDate ? [...new Set(allHistory.filter(r=>r.date===histDate).map(r=>r.group))] : [];
          return (
            <>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>History Editor</h2>
                <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>View, edit, add, or delete individual attendance records. Remove duplicates by session.</p>
              </div>

              {/* Filters */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 12, marginBottom: 20, alignItems: "end" }}>
                <div>
                  <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Group</label>
                  <select style={iStyle} value={histGroup} onChange={e => setHistGroup(e.target.value)}>
                    <option value="All">All Groups</option>
                    {visibleGroups().map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Session Date</label>
                  <select style={iStyle} value={histDate} onChange={e => setHistDate(e.target.value)}>
                    <option value="">All Dates</option>
                    {hDates.map(d => <option key={d} value={d}>{fmtDate(d)}</option>)}
                  </select>
                </div>
                <button onClick={openAddHistRec}
                  style={{ background: "#3b82f6", border: "none", color: "#fff", padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  + Add Record
                </button>
                {histDate && histGroup !== "All" && (
                  <button onClick={() => deleteDuplicates(histDate, histGroup)}
                    style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                    🗑 Remove Duplicates
                  </button>
                )}
              </div>

              {/* Records count */}
              <div style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>
                Showing {filteredHist.length} record{filteredHist.length !== 1 ? "s" : ""}
                {histDate && sessionGroups.length > 0 && <span style={{ marginLeft: 10, color: "#64748b" }}>· Groups in session: {sessionGroups.join(", ")}</span>}
              </div>

              {/* Table */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden" }}>
                {/* Header */}
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 0.6fr 0.6fr 0.6fr 80px", padding: "10px 20px", background: "rgba(0,0,0,0.3)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  {["Member","Date","Group","Status","Book","Lesson","Actions"].map(h => (
                    <div key={h} style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.8 }}>{h}</div>
                  ))}
                </div>
                {filteredHist.length === 0 && (
                  <div style={{ padding: 32, textAlign: "center", color: "#334155" }}>No records match the current filter</div>
                )}
                {filteredHist.map((r, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 0.6fr 0.6fr 0.6fr 80px", padding: "11px 20px", borderBottom: i < filteredHist.length-1 ? "1px solid rgba(255,255,255,0.04)" : "none", alignItems: "center" }}
                    onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.03)"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 500 }}>{r.person}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{fmtDate(r.date)}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: getColor(r.group, groups) }}>{r.group}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: r.status==="A" ? "#ef4444" : r.status==="F" ? "#3b82f6" : "#10b981" }}>{r.status}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.book || "—"}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.lesson || "—"}</div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => openEditHistRec(r)}
                        style={{ background: "rgba(59,130,246,0.15)", border: "none", color: "#60a5fa", padding: "4px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Edit</button>
                      <button onClick={() => deleteHistRec(r)}
                        style={{ background: "rgba(239,68,68,0.15)", border: "none", color: "#ef4444", padding: "4px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Del</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        })()}

        {/* ─── REPORTS ───────────────────────────────────────────────────── */}
        {view === "reports" && can("reports") && (() => {
          const signinMembers = activeMembersList
            .filter(m => reportGroup === "All" || m.group === reportGroup)
            .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
          const signinGroups = reportGroup === "All" ? groups : [reportGroup];
          const sessionDatesSorted = [...sessionDates].sort((a, b) => b.localeCompare(a));
          const curSession = reportSession || sessionDatesSorted[0] || "";
          const sessionRecs = allHistory.filter(r => r.date === curSession);
          const sessionMembers = activeMembersList
            .filter(m => reportGroup === "All" || m.group === reportGroup)
            .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
            .map(m => {
              const rec = sessionRecs.find(r => r.person === m.name);
              const prevRecs = allHistory.filter(r => r.person === m.name && r.date < curSession && (r.status === "P" || r.status === "F")).sort((a, b) => b.date.localeCompare(a.date));
              return { ...m, status: rec ? rec.status : "—", lastAttended: prevRecs[0]?.date || null, book: rec?.book, lesson: rec?.lesson };
            });
          const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

          return (
            <>


              <div style={{ marginBottom: 24 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>Reports</h2>
                <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>Generate printable sign-in sheets and session reports.</p>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 28 }}>
                <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 22px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 14 }}>Report Type</div>
                  {[
                    { id: "signin", icon: "📋", label: "Attendance Sign-In Sheet", desc: "Member list with notes column, last session date, and attendance rate." },
                    { id: "session", icon: "📊", label: "Session Attendance Report", desc: "P/A/F status per member for a chosen session with book/lesson info." },
                  ].map(opt => (
                    <div key={opt.id} onClick={() => setReportType(opt.id)}
                      style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderRadius: 10, marginBottom: 10, cursor: "pointer",
                        background: reportType === opt.id ? "rgba(59,130,246,0.12)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${reportType === opt.id ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.06)"}` }}>
                      <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${reportType === opt.id ? "#3b82f6" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
                        {reportType === opt.id && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3b82f6" }} />}
                      </div>
                      <div>
                        <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>{opt.icon} {opt.label}</div>
                        <div style={{ color: "#475569", fontSize: 12, marginTop: 3 }}>{opt.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "20px 22px", display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 14 }}>Options</div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", color: "#94a3b8", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Group</label>
                    <select style={iStyle} value={reportGroup} onChange={e => setReportGroup(e.target.value)}>
                      <option value="All">All Groups</option>
                      {visibleGroups().map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  {reportType === "session" && (
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ display: "block", color: "#94a3b8", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Session Date</label>
                      <select style={iStyle} value={curSession} onChange={e => setReportSession(e.target.value)}>
                        {sessionDatesSorted.map(d => <option key={d} value={d}>{fmtDate(d)}</option>)}
                      </select>
                    </div>
                  )}
                  <div style={{ marginTop: "auto" }}>
                    <div style={{ fontSize: 12, color: "#475569", marginBottom: 12, padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                      {reportType === "signin" ? `📋 ${signinMembers.length} members · ${signinGroups.length} group${signinGroups.length !== 1 ? "s" : ""}` : `📊 ${sessionMembers.length} members · ${fmtDate(curSession)}`}
                    </div>
                    {can("exportData") && (
                      <button onClick={exportCSV} style={{ width: "100%", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", color: "#10b981", padding: "10px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>
                        ⬇ Export Attendance CSV
                      </button>
                    )}
                    <button onClick={printReport}
                      style={{ width: "100%", background: "#3b82f6", border: "none", color: "#fff", padding: "12px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                      🖨 Print / Save as PDF
                    </button>
                  </div>
                </div>
              </div>

              {/* Preview */}
              <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8 }}>Preview</span>
                  <span style={{ fontSize: 11, color: "#334155" }}>Scroll to see full report</span>
                </div>
                <div style={{ background: "#e2e8f0", padding: 16 }}>
                  <div style={{ background: "#fff", borderRadius: 6, boxShadow: "0 2px 12px rgba(0,0,0,0.3)" }}>
                    {reportType === "signin"
                      ? <SignInSheetPrint members={signinMembers} groups={signinGroups} facilitators={facilitators} lastSeen={lastSeen} memberStats={memberStats} reportGroup={reportGroup} today={today} groupProgress={groupProgress} />
                      : <SessionReportPrint members={sessionMembers} session={curSession} reportGroup={reportGroup} facilitators={facilitators} groupProgress={groupProgress} />}
                  </div>
                </div>
              </div>

              {/* Print target — visually hidden via CSS, shown only during print */}
              <div id="emaw-print-area" style={{ position: "absolute", left: "-9999px", top: "-9999px", visibility: "hidden", pointerEvents: "none" }}>
                {reportType === "signin"
                  ? <SignInSheetPrint members={signinMembers} groups={signinGroups} facilitators={facilitators} lastSeen={lastSeen} memberStats={memberStats} reportGroup={reportGroup} today={today} groupProgress={groupProgress} />
                  : reportType === "session"
                  ? <SessionReportPrint members={sessionMembers} session={curSession} reportGroup={reportGroup} facilitators={facilitators} groupProgress={groupProgress} />
                  : <RosterReportPrint members={signinMembers} reportGroup={reportGroup} lastSeen={lastSeen} today={today} />}
              </div>
            </>
          );
        })()}

        {/* ─── SECURITY ──────────────────────────────────────────────────── */}
        {view === "security" && can("security") && (
          <>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", margin: "0 0 4px" }}>Security & Access Control</h2>
              <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>Manage users, roles, and permissions.</p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
              {/* App Users */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <div>
                    <h3 style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16, margin: 0 }}>App Users</h3>
                    <p style={{ color: "#475569", fontSize: 12, margin: "2px 0 0" }}>{appUsers.length} users · email + 6-digit PIN</p>
                  </div>
                  <button onClick={openAddUser} style={{ background: "#8b5cf6", border: "none", color: "#fff", padding: "7px 14px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+ New User</button>
                </div>
                <div>
                  {appUsers.map((u, i) => {
                    const role = roles.find(r => r.id === u.roleId);
                    return (
                      <div key={u.email} style={{ padding: "13px 22px", borderBottom: i < appUsers.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ width: 34, height: 34, borderRadius: "50%", background: u.active ? "#8b5cf6" : "#475569", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff" }}>{initials(u.name)}</div>
                            <div>
                              <div style={{ color: u.active ? "#e2e8f0" : "#475569", fontWeight: 600, fontSize: 14 }}>{u.name}</div>
                              <div style={{ color: "#475569", fontSize: 11 }}>{u.email}</div>
                              <div style={{ color: "#334155", fontSize: 10, marginTop: 2 }}>
                                {u.lastLogin ? `Last login: ${new Date(u.lastLogin).toLocaleString("en-US", { month:"short", day:"numeric", year:"numeric", hour:"2-digit", minute:"2-digit" })}` : "Never logged in"}
                              </div>
                              {u.groupAccess && u.groupAccess.length > 0 && (
                                <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>Groups: {u.groupAccess.join(", ")}</div>
                              )}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: role?.id === "superuser" ? "#f59e0b" : "#8b5cf6", background: role?.id === "superuser" ? "rgba(245,158,11,0.15)" : "rgba(139,92,246,0.15)", padding: "2px 8px", borderRadius: 5 }}>{role?.name || "—"}</span>
                            <button onClick={() => openEditUser(u)} title="Edit user" style={{ background: "rgba(59,130,246,0.15)", border: "none", color: "#60a5fa", padding: "3px 8px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 600 }}>✎ Edit</button>
                            <button onClick={() => resetUserPin(u.email)} title="Reset PIN" style={{ background: "rgba(245,158,11,0.15)", border: "none", color: "#f59e0b", padding: "3px 8px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 600 }}>Reset PIN</button>
                            {u.email !== currentUser.email && (
                              <>
                                <button onClick={() => toggleUserActive(u.email)} style={{ background: u.active ? "rgba(245,158,11,0.15)" : "rgba(16,185,129,0.15)", border: "none", color: u.active ? "#f59e0b" : "#10b981", padding: "3px 8px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 600 }}>
                                  {u.active ? "Disable" : "Enable"}
                                </button>
                                <button onClick={() => { if (window.confirm(`Delete user ${u.name}? This cannot be undone.`)) deleteUser(u.email); }} style={{ background: "rgba(239,68,68,0.15)", border: "none", color: "#ef4444", padding: "3px 8px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 600 }}>Delete</button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Roles */}
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <div>
                    <h3 style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16, margin: 0 }}>Roles & Permissions</h3>
                    <p style={{ color: "#475569", fontSize: 12, margin: "2px 0 0" }}>{roles.length} roles defined</p>
                  </div>
                  <button onClick={openAddRole} style={{ background: "#8b5cf6", border: "none", color: "#fff", padding: "7px 14px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+ New Role</button>
                </div>
                <div>
                  {roles.map((r, i) => (
                    <div key={r.id} style={{ padding: "13px 22px", borderBottom: i < roles.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 14 }}>{r.name}</div>
                          {r.locked && <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.15)", padding: "1px 6px", borderRadius: 4, fontWeight: 700 }}>LOCKED</span>}
                        </div>
                        {!r.locked && (
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => openEditRole(r)} style={{ background: "rgba(59,130,246,0.15)", border: "none", color: "#60a5fa", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>✎ Edit</button>
                            <button onClick={() => { if (window.confirm(`Delete role "${r.name}"?`)) deleteRole(r.id); }} style={{ background: "rgba(239,68,68,0.15)", border: "none", color: "#ef4444", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Delete</button>
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {r.permissions.map(p => {
                          const pm = ALL_PERMISSIONS.find(x => x.id === p);
                          return <span key={p} style={{ fontSize: 10, color: "#64748b", background: "rgba(255,255,255,0.05)", padding: "2px 7px", borderRadius: 4 }}>{pm?.label || p}</span>;
                        })}
                        {r.permissions.length === 0 && <span style={{ fontSize: 11, color: "#334155" }}>No permissions assigned</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Data Backup & Restore */}
            {can("security") && (
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, overflow: "hidden", marginBottom: 20 }}>
                <div style={{ padding: "18px 22px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <h3 style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16, margin: "0 0 2px" }}>💾 Data Backup & Restore</h3>
                  <p style={{ color: "#475569", fontSize: 12, margin: 0 }}>Export a full backup of all app data, or restore from a previous backup file.</p>
                </div>
                <div style={{ padding: "20px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  {/* Export */}
                  <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 12, padding: "18px 20px" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#10b981", marginBottom: 6 }}>⬇ Export All Data</div>
                    <div style={{ fontSize: 12, color: "#475569", marginBottom: 14 }}>
                      Downloads a <strong style={{ color: "#94a3b8" }}>.json</strong> backup file containing all members, attendance history, groups, users, QT records, and settings.
                    </div>
                    <button onClick={exportAllData}
                      style={{ width: "100%", background: "#10b981", border: "none", color: "#fff", padding: "11px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                      Download Backup
                    </button>
                  </div>
                  {/* Import */}
                  <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 12, padding: "18px 20px" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#f59e0b", marginBottom: 6 }}>⬆ Restore From Backup</div>
                    <div style={{ fontSize: 12, color: "#475569", marginBottom: 14 }}>
                      Select a backup file, then choose which data sets to restore. <strong style={{ color: "#ef4444" }}>Selected items will overwrite current data.</strong>
                    </div>
                    <RestorePanel appUsers={appUsers} setAppUsers={setAppUsers} roles={roles} setRoles={setRoles}
                      members={members} setMembers={setMembers} groups={groups} setGroups={setGroups}
                      facilitators={facilitators} setFacilitators={setFacilitators}
                      groupProgress={groupProgress} setGroupProgress={setGroupProgress}
                      allHistory={allHistory} setAllHistory={setAllHistory}
                      qtRecords={qtRecords} setQtRecords={setQtRecords}
                      showToast={showToast} />
                  </div>
                </div>
                <div style={{ padding: "10px 22px 16px", fontSize: 11, color: "#334155" }}>
                  💡 Tip: Export a backup before updating the app or clearing your browser. Backups are plain JSON files you can open in any text editor.
                </div>
              </div>
            )}

          </>
        )}

      </div>
    </div>
  );
}

// ─── PRINT COMPONENTS ─────────────────────────────────────────────────────────
const ps = {
  page:      { fontFamily: "Arial, sans-serif", color: "#000", background: "#fff", padding: "28px 32px", fontSize: 12 },
  header:    { borderBottom: "2px solid #1e3a5f", paddingBottom: 14, marginBottom: 20 },
  orgName:   { fontSize: 17, fontWeight: "bold", margin: "0 0 3px", color: "#1e3a5f" },
  orgSub:    { fontSize: 12, color: "#555", margin: 0 },
  groupHead: { background: "#1e3a5f", color: "#fff", padding: "7px 12px", fontSize: 13, fontWeight: "bold", marginTop: 20 },
  table:     { width: "100%", borderCollapse: "collapse" },
  th:        { borderBottom: "2px solid #1e3a5f", borderRight: "1px solid #ccc", padding: "6px 8px", textAlign: "left", fontSize: 11, fontWeight: "bold", background: "#f0f4f8" },
  td:        { borderBottom: "1px solid #ddd", borderRight: "1px solid #eee", padding: "7px 8px", fontSize: 11, verticalAlign: "middle" },
  footer:    { marginTop: 20, fontSize: 10, color: "#777", borderTop: "1px solid #ddd", paddingTop: 8, display: "flex", justifyContent: "space-between" },
};

function RosterReportPrint({ members, reportGroup, lastSeen, today }) {
  return (
    <div style={ps.page}>
      <div style={ps.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p style={ps.orgName}>⚔ Every Man A Warrior — Member Roster</p>
            <p style={ps.orgSub}>{reportGroup === "All" ? "All Groups" : `Group: ${reportGroup}`} · {today}</p>
          </div>
          <div style={{ textAlign: "right", fontSize: 11, color: "#555", border: "1px solid #ccc", padding: "8px 14px", borderRadius: 4 }}>
            <div style={{ fontSize: 16, fontWeight: "bold", color: "#1e3a5f" }}>{members.length} members</div>
          </div>
        </div>
      </div>
      <table style={ps.table}>
        <thead>
          <tr>
            {["Name","Phone","Email","Group","Last Attendance"].map(h => (
              <th key={h} style={ps.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)).map((m,i) => (
            <tr key={m.name} style={{ background: i%2===0?"#fff":"#f8fafc" }}>
              <td style={ps.td}><strong>{m.name}</strong></td>
              <td style={ps.td}>{m.phone || "—"}</td>
              <td style={ps.td}>{m.email || "—"}</td>
              <td style={ps.td}>{m.group}</td>
              <td style={ps.td}>{lastSeen[m.name] ? new Date(lastSeen[m.name]+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "Never"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={ps.footer}><span>Every Man A Warrior · Member Roster</span><span>Printed: {today}</span></div>
    </div>
  );
}

function SignInSheetPrint({ members, groups, facilitators, lastSeen, memberStats, reportGroup, today, groupProgress }) {
  const grouped = reportGroup === "All"
    ? groups.map(g => ({ group: g, rows: members.filter(m => m.group === g) })).filter(g => g.rows.length > 0)
    : [{ group: reportGroup, rows: members }];
  const totalPresent = members.reduce((n, m) => n + (memberStats[m.name]?.present || 0), 0);
  const totalSessions = members.reduce((n, m) => n + (memberStats[m.name]?.total || 0), 0);
  const overallRate = totalSessions ? Math.round((totalPresent / totalSessions) * 100) : 0;

  return (
    <div style={ps.page}>
      <div style={ps.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p style={ps.orgName}>⚔ Every Man A Warrior — Attendance Sign-In Sheet</p>
            <p style={ps.orgSub}>{reportGroup === "All" ? "All Groups" : `Group: ${reportGroup}`} · {today}</p>
          </div>
          <div style={{ textAlign: "right", fontSize: 11, color: "#555", border: "1px solid #ccc", padding: "8px 14px", borderRadius: 4 }}>
            <div style={{ fontSize: 16, fontWeight: "bold", color: "#1e3a5f" }}>{members.length} members</div>
            {totalSessions > 0 && <div>Overall attendance: <strong>{overallRate}%</strong></div>}
          </div>
        </div>
      </div>

      {grouped.map(({ group, rows }) => {
        const prog = (groupProgress || {})[group] || {};
        return (
          <div key={group} style={{ pageBreakInside: "avoid", marginBottom: 8 }}>
            <div style={ps.groupHead}>
              {group}{facilitators[group] ? ` · Facilitator: ${facilitators[group]}` : ""}
              {prog.book && <span style={{ marginLeft: 12, fontWeight: "normal", fontSize: 11 }}>Book {prog.book} · Lesson {prog.lesson}</span>}
              <span style={{ float: "right", fontWeight: "normal", fontSize: 11 }}>{rows.length} members</span>
            </div>
            <table style={ps.table}>
              <thead>
                <tr>
                  <th style={{ ...ps.th, width: "26%" }}>#  Name</th>
                  <th style={{ ...ps.th, width: "15%" }}>Phone</th>
                  <th style={{ ...ps.th, width: "14%", textAlign: "center" }}>Last Session</th>
                  <th style={{ ...ps.th, width: "7%", textAlign: "center" }}>Att %</th>
                  <th style={{ ...ps.th, width: "10%", textAlign: "center", borderRight: "none" }}>P / A / F</th>
                  <th style={{ ...ps.th, width: "28%", borderRight: "none" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m, i) => {
                  const stat = memberStats[m.name] || { rate: 0, total: 0 };
                  const ls = lastSeen[m.name];
                  const rc = stat.rate >= 75 ? "#14532d" : stat.rate >= 50 ? "#78350f" : "#7f1d1d";
                  return (
                    <tr key={m.name} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                      <td style={ps.td}><span style={{ color: "#999", marginRight: 6 }}>{i + 1}.</span><strong>{m.name}</strong></td>
                      <td style={ps.td}>{m.phone || "—"}</td>
                      <td style={{ ...ps.td, textAlign: "center" }}>{ls ? fmtDate(ls) : <span style={{ color: "#bbb" }}>Never</span>}</td>
                      <td style={{ ...ps.td, textAlign: "center", fontWeight: "bold", color: rc }}>{stat.total > 0 ? `${stat.rate}%` : "—"}</td>
                      <td style={{ ...ps.td, textAlign: "center", borderRight: "none" }}>
                        <span style={{ display: "inline-flex", gap: 3 }}>
                          {["P","A","F"].map(s => <span key={s} style={{ display: "inline-block", width: 18, height: 18, border: "1px solid #999", borderRadius: 2, fontSize: 9, textAlign: "center", lineHeight: "18px", fontWeight: "bold" }}>{s}</span>)}
                        </span>
                      </td>
                      <td style={{ ...ps.td, borderRight: "none" }}><div style={{ borderBottom: "1px solid #bbb", minHeight: 18 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
      <div style={ps.footer}><span>Every Man A Warrior · EMAW Attendance Tracker</span><span>Printed: {today}</span></div>
    </div>
  );
}

function SessionReportPrint({ members, session, reportGroup, facilitators, groupProgress }) {
  const grouped = reportGroup === "All"
    ? [...new Set(members.map(m => m.group))].sort().map(g => ({ group: g, rows: members.filter(m => m.group === g) }))
    : [{ group: reportGroup, rows: members }];
  const present = members.filter(m => m.status === "P" || m.status === "F").length;
  const absent = members.filter(m => m.status === "A").length;
  const noRec = members.filter(m => m.status === "—").length;
  const attended = members.filter(m => m.status !== "—").length;
  const rate = attended ? Math.round((present / attended) * 100) : 0;
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  return (
    <div style={ps.page}>
      <div style={ps.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p style={ps.orgName}>⚔ Every Man A Warrior — Session Attendance Report</p>
            <p style={ps.orgSub}>Session: <strong>{fmtDate(session)}</strong> · {reportGroup === "All" ? "All Groups" : `Group: ${reportGroup}`}</p>
          </div>
          <div style={{ border: "1px solid #ccc", padding: "10px 16px", borderRadius: 4, fontSize: 11 }}>
            <div style={{ display: "flex", gap: 20, textAlign: "center" }}>
              <div><div style={{ fontSize: 20, fontWeight: "bold", color: "#14532d" }}>{present}</div><div>Present</div></div>
              <div><div style={{ fontSize: 20, fontWeight: "bold", color: "#7f1d1d" }}>{absent}</div><div>Absent</div></div>
              {noRec > 0 && <div><div style={{ fontSize: 20, fontWeight: "bold", color: "#777" }}>{noRec}</div><div>No Record</div></div>}
              <div><div style={{ fontSize: 20, fontWeight: "bold", color: "#1e3a5f" }}>{rate}%</div><div>Rate</div></div>
            </div>
          </div>
        </div>
      </div>

      {grouped.map(({ group, rows }) => {
        const gPresent = rows.filter(r => r.status === "P" || r.status === "F").length;
        const gTotal = rows.filter(r => r.status !== "—").length;
        const firstRow = rows.find(r => r.book);
        return (
          <div key={group} style={{ pageBreakInside: "avoid", marginBottom: 8 }}>
            <div style={ps.groupHead}>
              {group}{facilitators[group] ? ` · Facilitator: ${facilitators[group]}` : ""}
              {firstRow?.book && <span style={{ marginLeft: 12, fontWeight: "normal", fontSize: 11 }}>Book {firstRow.book} · Lesson {firstRow.lesson}</span>}
              <span style={{ float: "right", fontWeight: "normal", fontSize: 11 }}>{gPresent}/{gTotal} present {gTotal > 0 ? `(${Math.round(gPresent/gTotal*100)}%)` : ""}</span>
            </div>
            <table style={ps.table}>
              <thead>
                <tr>
                  <th style={{ ...ps.th, width: "30%" }}>#  Name</th>
                  <th style={{ ...ps.th, width: "15%" }}>Phone</th>
                  <th style={{ ...ps.th, width: "14%", textAlign: "center" }}>Status</th>
                  <th style={{ ...ps.th, width: "17%", textAlign: "center" }}>Last Attended</th>
                  <th style={{ ...ps.th, width: "24%", borderRight: "none" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m, i) => {
                  const colors = { P: "#14532d", F: "#1e3a8a", A: "#7f1d1d", "—": "#777" };
                  const labels = { P: "Present", F: "Facilitator", A: "Absent", "—": "No Record" };
                  const bgColors = { P: "#dcfce7", F: "#dbeafe", A: "#fee2e2", "—": "#f1f5f9" };
                  return (
                    <tr key={m.name} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                      <td style={ps.td}><span style={{ color: "#999", marginRight: 6 }}>{i + 1}.</span><strong>{m.name}</strong></td>
                      <td style={ps.td}>{m.phone || "—"}</td>
                      <td style={{ ...ps.td, textAlign: "center" }}>
                        <span style={{ display: "inline-block", fontWeight: "bold", fontSize: 10, color: colors[m.status], background: bgColors[m.status], padding: "2px 8px", borderRadius: 3 }}>{labels[m.status]}</span>
                      </td>
                      <td style={{ ...ps.td, textAlign: "center" }}>{m.lastAttended ? fmtDate(m.lastAttended) : <span style={{ color: "#bbb" }}>—</span>}</td>
                      <td style={{ ...ps.td, borderRight: "none" }}><div style={{ borderBottom: "1px solid #ccc", minHeight: 16 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
      <div style={ps.footer}><span>Every Man A Warrior · EMAW Attendance Tracker</span><span>Session: {fmtDate(session)} · Printed: {today}</span></div>
    </div>
  );
}

// ─── APP SHELL (auth only — keeps hooks-before-return rule) ───────────────────
export default function App() {
  const [ready, setReady] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [appUsers, setAppUsers] = useState(SEED_APP_USERS);
  const [roles, setRoles] = useState(SEED_ROLES);
  const [gdriveStatus, setGdriveStatus] = useState("idle"); // idle | syncing | ok | error
  const [gdriveMsg, setGdriveMsg] = useState("");
  const [gdriveConnected, setGdriveConnected] = useState(false);

  // Check if user has a personal GDrive session token
  useEffect(() => {
    setGdriveConnected(!!sessionStorage.getItem("gdrive_user_refresh_token"));
  }, []);

  // Handle OAuth callback (?code= in URL)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("code")) {
      setGdriveStatus("syncing");
      setGdriveMsg("Completing Google sign-in…");
      handleGoogleOAuthCallback()
        .then(() => {
          setGdriveConnected(true);
          setGdriveStatus("ok");
          setGdriveMsg("Connected to Google Drive ✓");
          setTimeout(() => { setGdriveStatus("idle"); setGdriveMsg(""); }, 4000);
        })
        .catch(e => {
          setGdriveStatus("error");
          setGdriveMsg("OAuth error: " + e.message);
        });
    }
  }, []);

  // Load all data from server on first mount, pre-seeded with GDrive cloud data
  useEffect(() => {
    // Pre-login sync from GDrive using shared refresh token
    setGdriveStatus("syncing");
    setGdriveMsg("Syncing from Google Drive…");
    syncFromGDrive()
      .then(cloudData => {
        if (cloudData?.data) {
          // Write cloud keys to localStorage so loadAllData picks them up
          const KEY_MAP = {
            emaw_users_v3: "users", emaw_roles_v3: "roles",
            emaw_members_v3: "members", emaw_groups_v3: "groups",
            emaw_facilitators_v3: "facilitators", emaw_progress_v3: "progress",
            emaw_history_v3: "history", emaw_qt_v3: "qt",
          };
          Object.entries(KEY_MAP).forEach(([storeKey, cloudKey]) => {
            if (cloudData.data[storeKey] !== undefined) {
              try { localStorage.setItem(storeKey, JSON.stringify(cloudData.data[storeKey])); } catch {}
            } else if (cloudData.data[cloudKey] !== undefined) {
              try { localStorage.setItem(storeKey, JSON.stringify(cloudData.data[cloudKey])); } catch {}
            }
          });
          setGdriveStatus("ok");
          setGdriveMsg("Synced from Google Drive ✓");
        } else {
          setGdriveStatus("idle");
          setGdriveMsg("");
        }
      })
      .catch(() => { setGdriveStatus("idle"); setGdriveMsg(""); })
      .finally(() => { setTimeout(() => { setGdriveStatus("idle"); setGdriveMsg(""); }, 3000); });

    loadAllData({
      "emaw_users_v3":       SEED_APP_USERS,
      "emaw_roles_v3":       SEED_ROLES,
      "emaw_members_v3":     SEED_MEMBERS,
      "emaw_groups_v3":      SEED_GROUPS,
      "emaw_facilitators_v3": SEED_FACILITATORS,
      "emaw_progress_v3":    SEED_GROUP_PROGRESS,
      "emaw_history_v3":     HISTORY,
      "emaw_qt_v3":          [],
    }).then(data => {
      setAppUsers(data["emaw_users_v3"]);
      setRoles(data["emaw_roles_v3"]);
      setReady(true);
    });
  }, []);

  useEffect(() => { if (ready) { save("emaw_users_v3", appUsers); } }, [appUsers]);
  useEffect(() => { if (ready) { save("emaw_roles_v3", roles); } }, [roles]);

  if (!ready) {
    return (
      <div style={{ background: "#0f172a", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
        <div style={{ textAlign: "center", color: "#475569" }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⚔</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#94a3b8" }}>Every Man A Warrior</div>
          <div style={{ fontSize: 13, marginTop: 8 }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginScreen appUsers={appUsers} onLogin={user => {
      const now = new Date().toISOString();
      const updated = appUsers.map(u => u.email === user.email ? { ...u, lastLogin: now } : u);
      setAppUsers(updated);
      save("emaw_users_v3", updated);
      setCurrentUser({ ...user, lastLogin: now });
    }} gdriveStatus={gdriveStatus} gdriveMsg={gdriveMsg} />;
  }
  return <MainApp currentUser={currentUser} setCurrentUser={setCurrentUser}
    appUsers={appUsers} setAppUsers={setAppUsers}
    roles={roles} setRoles={setRoles}
    gdriveConnected={gdriveConnected} setGdriveConnected={setGdriveConnected} />;
}

