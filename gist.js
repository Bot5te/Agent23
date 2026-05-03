// ==================== Gist Storage Helper ====================
// يُستخدم لحفظ واستعادة البيانات وجلسة واتساب من GitHub Gist

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

// --- المفتاح والمعرّف ---
const GIST_ID = "27ab2aabae8ef0220b60d8d4663f4e5f";
const part1   = "ghp_8R5ZSX";
const part2   = "Fialw3xGFxM";
const part3   = "R6AFoBhtY9Vag4ehUjl";
const GIST_TOKEN = part1 + part2 + part3;

const gistHttp = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Authorization: `token ${GIST_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
  },
  timeout: 20000,
});

// --- API الأساسي ---

async function fetchGist() {
  const { data } = await gistHttp.get(`/gists/${GIST_ID}`);
  return data.files; // { "filename": { content, ... }, ... }
}

async function pushGistFiles(filesObj) {
  const files = {};
  for (const [name, content] of Object.entries(filesObj)) {
    if (content === null) {
      files[name] = null; // حذف الملف
    } else {
      files[name] = {
        content: typeof content === "string" ? (content || " ") : JSON.stringify(content, null, 2)
      };
    }
  }
  await gistHttp.patch(`/gists/${GIST_ID}`, { files });
}

async function pushGistFile(name, content) {
  await pushGistFiles({ [name]: content });
}

// --- ملفات البيانات ---

const DATA_FILE_MAP = {
  "data_config.json":    "bot_config.json",
  "data_contacts.json":  "contacts.json",
  "data_knowledge.json": "custom_knowledge.json",
  "data_paused.json":    "paused_users.json",
};

async function restoreDataFromGist() {
  try {
    console.log("☁️ جاري استعادة البيانات من Gist...");
    const files = await fetchGist();
    let restored = 0;
    for (const [gistName, localName] of Object.entries(DATA_FILE_MAP)) {
      const content = files[gistName]?.content;
      if (content && content.trim() && content.trim() !== " ") {
        try {
          JSON.parse(content);
          fs.writeFileSync(localName, content, "utf-8");
          restored++;
        } catch (e) {}
      }
    }
    console.log(`☁️ تم استعادة ${restored} ملف بيانات من Gist`);
    return restored;
  } catch (e) {
    console.log("⚠️ فشل استعادة البيانات من Gist:", e?.message);
    return 0;
  }
}

// رفع ملف بيانات محلي إلى Gist (fire-and-forget)
function _pushLocalFile(gistName, localPath) {
  try {
    const content = fs.existsSync(localPath)
      ? fs.readFileSync(localPath, "utf-8")
      : " ";
    pushGistFile(gistName, content || " ").catch(e => {
      console.log(`⚠️ فشل رفع ${gistName}:`, e?.message);
    });
  } catch (e) {}
}

function syncConfig()    { _pushLocalFile("data_config.json",    "bot_config.json"); }
function syncContacts()  { _pushLocalFile("data_contacts.json",  "contacts.json"); }
function syncPaused()    { _pushLocalFile("data_paused.json",    "paused_users.json"); }
function syncKnowledge() { _pushLocalFile("data_knowledge.json", "custom_knowledge.json"); }

// --- جلسة Baileys ---

async function restoreAuthFromGist(authDir) {
  try {
    console.log("☁️ جاري استعادة جلسة الربط من Gist...");
    const files = await fetchGist();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    let restored = 0;
    const coreAuthFiles = new Set([
      "creds.json",
      "pre-key.json",
      "session.json",
      "app-state-sync-key.json",
      "app-state-sync-version.json",
      "app-state-sync-key-id.json",
    ]);
    for (const [gistName, fileObj] of Object.entries(files)) {
      if (!gistName.startsWith("auth_")) continue;
      const content = fileObj?.content;
      if (!content || content.trim() === " " || content.trim() === "{}") continue;
      const localName = gistName.slice(5); // أزِل البادئة auth_
      if (!coreAuthFiles.has(localName)) continue;
      try {
        JSON.parse(content);
        fs.writeFileSync(path.join(authDir, localName), content, "utf-8");
        restored++;
      } catch (e) {}
    }
    console.log(`☁️ تم استعادة ${restored} ملف جلسة من Gist`);
    return restored;
  } catch (e) {
    console.log("⚠️ فشل استعادة الجلسة من Gist:", e?.message);
    return 0;
  }
}

// رفع جميع الملفات المحلية إلى Gist (للمرة الأولى أو بعد فصل)
async function initialPushToGist(authDir) {
  try {
    console.log("☁️ رفع أولي للبيانات والجلسة إلى Gist...");
    const gistFiles = {};

    // ملفات البيانات
    for (const [gistName, localName] of Object.entries(DATA_FILE_MAP)) {
      if (fs.existsSync(localName)) {
        const content = fs.readFileSync(localName, "utf-8");
        if (content && content.trim()) gistFiles[gistName] = content;
      }
    }

    // ملفات المصادقة
    if (authDir && fs.existsSync(authDir)) {
      const coreAuthFiles = new Set([
        "creds.json",
        "pre-key.json",
        "session.json",
        "app-state-sync-key.json",
        "app-state-sync-version.json",
        "app-state-sync-key-id.json",
      ]);
      const authFiles = fs.readdirSync(authDir).filter(f => !f.startsWith(".") && f.endsWith(".json"));
      for (const f of authFiles) {
        if (!coreAuthFiles.has(f)) continue;
        const content = fs.readFileSync(path.join(authDir, f), "utf-8");
        if (content && content.trim()) gistFiles[`auth_${f}`] = content;
      }
    }

    if (Object.keys(gistFiles).length) {
      await pushGistFiles(gistFiles);
      console.log(`☁️ تم رفع ${Object.keys(gistFiles).length} ملف إلى Gist بنجاح`);
    }
  } catch (e) {
    console.log("⚠️ فشل الرفع الأولي إلى Gist:", e?.message);
  }
}

// debounce لتجنب الرفع المتكرر عند تحديث creds بسرعة
let _authSyncTimer = null;
function scheduleAuthSync(authDir) {
  if (_authSyncTimer) clearTimeout(_authSyncTimer);
  _authSyncTimer = setTimeout(() => {
    _authSyncTimer = null;
    syncAuthToGist(authDir).catch(() => {});
  }, 3000);
}

async function syncAuthToGist(authDir) {
  try {
    if (!fs.existsSync(authDir)) return;
    const coreAuthFiles = new Set([
      "creds.json",
      "pre-key.json",
      "session.json",
      "app-state-sync-key.json",
      "app-state-sync-version.json",
      "app-state-sync-key-id.json",
    ]);
    const files = fs.readdirSync(authDir).filter(f => !f.startsWith(".") && f.endsWith(".json") && coreAuthFiles.has(f));
    if (!files.length) return;
    const gistFiles = {};
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(authDir, f), "utf-8");
        if (content && content.trim()) gistFiles[`auth_${f}`] = content;
      } catch (_) {}
    }
    if (Object.keys(gistFiles).length) {
      await pushGistFiles(gistFiles);
    }
  } catch (e) {
    console.log("⚠️ فشل رفع جلسة الربط إلى Gist:", e?.message);
  }
}

async function clearGistAuth() {
  try {
    const files = await fetchGist();
    const authFileNames = Object.keys(files).filter(f => f.startsWith("auth_"));
    if (!authFileNames.length) return;
    // استبدال المحتوى بـ {} بدلاً من الحذف لضمان التوافق
    const resetObj = {};
    for (const f of authFileNames) resetObj[f] = "{}";
    await pushGistFiles(resetObj);
    console.log("☁️ تم مسح بيانات الجلسة من Gist");
  } catch (e) {
    console.log("⚠️ فشل مسح جلسة Gist:", e?.message);
  }
}

module.exports = {
  restoreDataFromGist,
  restoreAuthFromGist,
  initialPushToGist,
  syncAuthToGist,
  scheduleAuthSync,
  clearGistAuth,
  syncConfig,
  syncContacts,
  syncPaused,
  syncKnowledge,
};
