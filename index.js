// ====================== بوت إفادة على واتساب ======================

const {
  default: makeWASocket,
  Browsers,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const P = require("pino");
const Groq = require("groq-sdk");

// ==================== الإعدادات ====================

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const IEFADA_SUMMARY_API = "https://www.iefada.com/api/v1/website/global-summary";
const IEFADA_COURSE_API = "https://www.iefada.com/api/v1/website/courses/{slug}";
const IEFADA_URL = "https://www.iefada.com";
const LOCAL_COURSES_FILE = "all_courses_details.json";
const CUSTOM_KNOWLEDGE_FILE = "custom_knowledge.json";
const PAUSED_USERS_FILE    = "paused_users.json";
const CONTACTS_FILE        = "contacts.json";
const CONFIG_FILE          = "bot_config.json";

const MAX_HISTORY = 4;

const AI_MODELS = [
  "groq/compound-mini",
  "groq/compound",
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
];

const AUTH_DIR = "./lafsh_auth";

const groq = new Groq({ apiKey: GROQ_API_KEY });

const conversationHistory = new Map();
const lidToRealPhone = new Map();
let coursesData = [];
const _contextCache = {};

// ==================== الإعداد العام ====================

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (e) {}
  const defaults = { dashboardPassword: "cs1234", ownerPassword: "owner9999" };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2), "utf-8");
  return defaults;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

// ==================== جهات الاتصال ====================

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) return JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
  } catch (e) {}
  return [];
}

function getRealPhone(jid) {
  if (!jid) return "";
  if (!jid.endsWith("@lid")) return "+" + jid.split("@")[0];
  const realNum = lidToRealPhone.get(jid);
  return realNum ? "+" + realNum : "+" + jid.split("@")[0];
}

function upsertContact(userId, name) {
  const jid      = userId;
  const phone    = getRealPhone(jid);
  const contacts = loadContacts();
  const idx      = contacts.findIndex(c => c.jid === jid);
  const now      = Date.now();
  if (idx >= 0) {
    contacts[idx].lastContact = now;
    contacts[idx].phone = phone;
    if (name && name !== phone) contacts[idx].name = name;
  } else {
    contacts.push({ jid, phone, name: name || phone, firstContact: now, lastContact: now });
  }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), "utf-8");
}

// ==================== إدارة العملاء ====================

// تحميل قائمة الإيقاف من الملف عند البدء
function loadPausedUsers() {
  try {
    if (fs.existsSync(PAUSED_USERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(PAUSED_USERS_FILE, "utf-8"));
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch (e) {}
  return new Set();
}

function savePausedUsers() {
  try {
    fs.writeFileSync(PAUSED_USERS_FILE, JSON.stringify([...pausedUsers]), "utf-8");
  } catch (e) {
    console.log("خطأ في حفظ paused_users:", e?.message);
  }
}

// مجموعة المستخدمين الموقوف البوت عنهم — محفوظة على القرص
const pausedUsers = loadPausedUsers();
console.log(`✅ تم تحميل ${pausedUsers.size} مستخدم موقوف من الملف`);

// بيانات العملاء للوحة التحكم
// userId -> { name, lastMessage, lastTime, messageCount, messages: [] }
const clientsData = new Map();

function updateClientData(userId, name, text, fromBot = false) {
  const isNew = !clientsData.has(userId);
  if (isNew) {
    clientsData.set(userId, {
      name: name || userId.replace("@s.whatsapp.net", ""),
      lastMessage: text,
      lastTime: Date.now(),
      messageCount: 0,
      messages: [],
    });
  }
  const data = clientsData.get(userId);
  if (name && name !== userId) data.name = name;
  data.lastMessage = text;
  data.lastTime = Date.now();
  if (!fromBot) data.messageCount++;
  data.messages.push({ text, time: Date.now(), fromBot });
  if (data.messages.length > 50) data.messages = data.messages.slice(-50);
  // حفظ جهة الاتصال عند أول رسالة من العميل (ليس من البوت)
  if (!fromBot) upsertContact(userId, name);
}

global.qrCodeUrl = null;

// ==================== المعرفة المخصصة (أقسام) ====================

const KNOWLEDGE_SECTIONS = {
  offers:       "عروض وخصومات",
  instructions: "تعليمات خاصة",
  faqs:         "أسئلة شائعة",
};

function loadKnowledgeData() {
  try {
    if (fs.existsSync(CUSTOM_KNOWLEDGE_FILE)) {
      const raw = fs.readFileSync(CUSTOM_KNOWLEDGE_FILE, "utf-8");
      // دعم الملف القديم .txt إن وُجد كنص عادي
      if (raw.trim().startsWith("{")) return JSON.parse(raw);
    }
  } catch (e) {}
  return { offers: "", instructions: "", faqs: "" };
}

function saveKnowledgeData(data) {
  fs.writeFileSync(CUSTOM_KNOWLEDGE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function loadCustomKnowledge() {
  const data = loadKnowledgeData();
  const parts = [];
  if (data.offers?.trim())       parts.push(`[العروض والخصومات]\n${data.offers.trim()}`);
  if (data.instructions?.trim()) parts.push(`[تعليمات خاصة]\n${data.instructions.trim()}`);
  if (data.faqs?.trim())         parts.push(`[أسئلة شائعة]\n${data.faqs.trim()}`);
  return parts.join("\n\n");
}

// ==================== خرائط الكلمات المفتاحية ====================

const CATEGORY_KEYWORDS = {
  "Web Development": [
    "web", "ويب", "وب", "webdev", "تطوير الويب", "تطوير ويب",
    "تطوير مواقع", "مواقع", "موقع", "برمجة مواقع",
    "html", "css", "javascript", "js", "frontend", "backend",
    "fullstack", "فرونت", "باك اند", "فول ستاك",
    "react", "node", "php", "django", "laravel",
  ],
  "Mobile Development": [
    "mobile", "موبايل", "موبيل", "موبل", "تطوير تطبيقات",
    "تطبيقات", "تطبيق", "تطبيقات موبايل", "تطبيقات الجوال",
    "android", "ios", "اندرويد", "ايفون", "ايوس",
    "flutter", "react native", "kotlin", "swift",
    "app", "ابلكيشن", "جوال",
  ],
  "Data Science": [
    "data", "data science", "داتا", "بيانات", "علم البيانات",
    "تحليل بيانات", "تحليل", "python", "machine learning",
    "ml", "ذكاء اصطناعي", "deep learning", "تعلم الآلة",
    "pandas", "numpy", "tensorflow", "keras",
    "big data", "بيج داتا", "إحصاء",
  ],
  "DevOps & Cloud": [
    "devops", "ديف اوبس", "ديفوبس", "dev ops",
    "cloud", "كلاود", "سحابة", "سحابي",
    "docker", "kubernetes", "k8s", "jenkins",
    "aws", "azure", "gcp", "google cloud",
    "ci/cd", "linux", "لينكس", "server", "سيرفر",
    "بنية تحتية",
  ],
  "UI/UX Design": [
    "ui", "ux", "ui/ux", "uiux", "ux/ui",
    "تصميم", "design", "ديزاين", "فيجما", "figma",
    "adobe xd", "sketch", "واجهات", "واجهة مستخدم",
    "تجربة مستخدم", "تجربة", "تصميم واجهات", "prototyping",
  ],
};

const GENERAL_KEYWORDS = [
  "من انتم", "عن المنصة", "ما هي افادة", "ما هي إفادة",
  "about", "تسجيل", "سجل", "اشتراك", "دفع", "payment",
  "شهادة", "certificate", "كيف", "how", "طريقة",
  "تواصل", "contact", "support", "دعم", "مساعدة",
  "سعر", "price", "اسعار", "prices", "تكلفة", "cost",
  "مجاني", "free", "خصم", "discount", "كورسات", "courses",
];

const DETAIL_KEYWORDS = [
  "يتعلم", "يشمل", "محتوى", "تفاصيل", "ايش فيه", "ما فيه",
  "learnings", "what", "مواضيع", "درس", "دروس",
  "مناهج", "منهج",
];

// ==================== بناء السياق ====================

function buildBaseContext() {
  return (
    `المنصة: إفادة — ${IEFADA_URL}\n` +
    "50 كورس | 5 مجالات | أسعار: 19-99 ريال | مسجلة\n" +
    "التسجيل والدفع: عبر الموقع"
  );
}

function buildCategoryContextSlim(categoryName) {
  const catCourses = coursesData.filter(c => c.category_title === categoryName);
  if (catCourses.length === 0) return "";
  const lines = [`[${categoryName}]`];
  for (const c of catCourses) {
    lines.push(
      `- ${c.title || ""} | ${c.price_formatted || ""} | ${IEFADA_URL}/courses/${c.slug || ""}`
    );
  }
  return lines.join("\n");
}

function buildCourseDetail(needleRaw) {
  const needle = (needleRaw || "").toLowerCase();
  for (const c of coursesData) {
    const slug = (c.slug || "").toLowerCase();
    const title = (c.title || "").toLowerCase();
    if (slug.includes(needle) || title.includes(needle)) {
      const learnings = c.learnings || [];
      const desc = c.description || "";
      const lines = [`[تفاصيل: ${c.title}]`];
      if (desc) lines.push(`الوصف: ${desc}`);
      if (learnings.length) lines.push("يتعلم: " + learnings.join("، "));
      return lines.join("\n");
    }
  }
  return "";
}

function buildAllCategoriesSummary() {
  const categories = {};
  for (const c of coursesData) {
    const cat = c.category_title || "";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(c);
  }
  const lines = ["[الكورسات]"];
  for (const catName of Object.keys(categories).sort()) {
    const list = categories[catName];
    const prices = list.map(c => (c.price_amount || 0) / 100);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    lines.push(
      `${catName}: ${list.length} كورس | ${min.toFixed(0)}-${max.toFixed(0)} ريال`
    );
  }
  return lines.join("\n");
}

function prebuildContextCache() {
  const base = buildBaseContext();
  _contextCache.base = base;
  _contextCache.general = base + "\n" + buildAllCategoriesSummary();
  for (const cat of Object.keys(CATEGORY_KEYWORDS)) {
    _contextCache[cat] = base + "\n" + buildCategoryContextSlim(cat);
  }
  console.log(`  [Cache] بُني السياق لـ ${Object.keys(_contextCache).length} حالة`);
}

// ==================== كاشف النية ====================

function normalize(text) {
  let t = (text || "").toLowerCase().trim();
  t = t.replace(/[\u064b-\u065f]/g, "");
  t = t.replace(/[أإآا]/g, "ا");
  t = t.replace(/[يى]/g, "ي");
  t = t.replace(/[ةه]/g, "ه");
  return t;
}

function detectIntent(userMessage, history) {
  let fullText = userMessage;
  for (const msg of history.slice(-2)) {
    fullText += " " + (msg.content || "");
  }
  const norm = normalize(fullText);

  const matchedCategories = new Set();
  for (const [catName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (norm.includes(normalize(kw))) {
        matchedCategories.add(catName);
        break;
      }
    }
  }

  let isGeneral = false;
  if (matchedCategories.size === 0) {
    for (const kw of GENERAL_KEYWORDS) {
      if (norm.includes(normalize(kw))) {
        isGeneral = true;
        break;
      }
    }
  }

  const wantsDetail = DETAIL_KEYWORDS.some(kw => norm.includes(normalize(kw)));
  return { matchedCategories, isGeneral, wantsDetail };
}

function buildDynamicContext(userMessage, history) {
  const { matchedCategories, isGeneral, wantsDetail } = detectIntent(userMessage, history);

  let context;
  let label;

  if (matchedCategories.size > 0) {
    const ctx = [...matchedCategories].map(c => _contextCache[c] || "").join("\n");
    const base = _contextCache.base;
    context = base + "\n" + ctx;

    if (wantsDetail) {
      const norm = normalize(userMessage);
      for (const c of coursesData) {
        if (norm.includes(normalize(c.title || "")) || norm.includes(normalize(c.slug || ""))) {
          context += "\n" + buildCourseDetail(c.slug || "");
          break;
        }
      }
    }
    label = `فئة:${[...matchedCategories].join(",")}`;
  } else if (isGeneral) {
    context = _contextCache.general || _contextCache.base;
    label = "عام";
  } else {
    context = _contextCache.base;
    label = "أساسي";
  }

  // أضف المعرفة المخصصة إن وُجدت
  const custom = loadCustomKnowledge();
  if (custom) context += "\n\n[معلومات إضافية]\n" + custom;

  const tokens = Math.round(context.split(/\s+/).length * 1.3);
  console.log(`  [Context:${label}] ~${tokens} توكن`);
  return context;
}

// ==================== برومبت النظام ====================

const SYSTEM_BASE = `أنت عبدالله، موظف سعودي في منصة إفادة للتعليم التقني.

مهمتك الوحيدة: مساعدة الشخص في اختيار وتسجيل الكورس المناسب له على منصة إفادة.

طريقة كلامك:
- تكلّم بشكل مباشر وحازم مثل الموظف السعودي — جملتين أو ثلاث كحد أقصى.
- لا تبدأ بـ"بالطبع" أو "أهلاً" في كل رد.
- لا قوائم ولا نقاط. حوار طبيعي فقط.
- الروابط في سطر مستقل.

قواعد صارمة:
- لا تُجب على أي سؤال خارج نطاق منصة إفادة وكورساتها. إذا سألك الشخص عن شيء لا علاقة له بالمنصة، رُدّ باختصار: "هذا خارج نطاق عملي، أقدر أساعدك في كورسات إفادة فقط."
- لا تكرر جملة "ما يأخذ دقيقتين" إلا مرة واحدة في المحادثة كلها.
- لا ترسل رابط الموقع في كل رسالة — أرسله عند الحاجة الفعلية فقط.
- لا تخترع معلومات. لو ما عندك التفاصيل → وجّه للموقع.
- لو سألك "هل أنت بوت؟" → "لا، أنا عبدالله 😄 ليش؟"

الإقناع:
- ركّز على كيف يغيّر الكورس وضع الشخص، مو مجرد مدحه.
- السعر "استثمار" مو "تكلفة".
- لو ما عرفت هدفه — اسأله أولاً.

تصعيد الحالة:
- إذا وجدت نفسك غير قادر على مساعدة الشخص أو وصلت لطلب خارج صلاحياتك تمامًا، اكتب فقط هذا بالضبط في أول الرد: [ESCALATE]
- ثم اكتب رسالة مناسبة للعميل.

بيانات المنصة:
{context}`;

// ==================== تنسيق النص ====================

function formatReply(text) {
  let t = text || "";
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");
  t = t.replace(/(.+?)\s*(https?:\/\/\S+)/g, (m, before, url) => {
    const b = (before || "").trimEnd();
    return b ? `${b}\n${url}` : url;
  });
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// ==================== استدعاء AI ====================

async function callAI(messages, models = AI_MODELS) {
  for (const model of models) {
    try {
      console.log(`  [AI] جرب: ${model}`);
      const response = await groq.chat.completions.create({
        model,
        messages,
        max_tokens: 500,
        temperature: 0.5,
      });
      const reply = response.choices[0].message.content;
      const usage = response.usage || {};
      console.log(
        `  [TOKENS] prompt=${usage.prompt_tokens} | completion=${usage.completion_tokens} | total=${usage.total_tokens}`
      );
      console.log(`  [AI] نجح: ${model}`);
      return reply;
    } catch (e) {
      const err = String(e?.message || e);
      console.log(`  [AI] فشل ${model}: ${err.slice(0, 100)}`);
      if (/429|413|rate_limit|quota|tokens/i.test(err)) continue;
      break;
    }
  }
  return null;
}

async function getAIResponse(userId, userMessage) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  let history = conversationHistory.get(userId);

  const context = buildDynamicContext(userMessage, history);
  const systemPrompt = SYSTEM_BASE.replace("{context}", context);

  history.push({ role: "user", content: userMessage });
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
    conversationHistory.set(userId, history);
  }

  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const reply = await callAI(messages);

  if (reply) {
    conversationHistory.get(userId).push({ role: "assistant", content: reply });
    return reply;
  }

  conversationHistory.set(userId, conversationHistory.get(userId).slice(-2));
  return "المنظومة مشغولة الحين، حاول بعد شوي";
}

// ==================== الصوت: STT ====================

async function transcribeVoice(filePath) {
  try {
    const result = await groq.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: fs.createReadStream(filePath),
      response_format: "text",
      language: "ar",
    });
    const text = (typeof result === "string" ? result : result.text || "").trim();
    console.log(`  [STT] النص: ${text.slice(0, 80)}`);
    return text;
  } catch (e) {
    console.log(`  [STT] خطأ: ${e?.message || e}`);
    return null;
  }
}

// ==================== سيرفر صحي + QR + Dashboard ====================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/login"));

// صفحة تسجيل الدخول
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// التحقق من الباسورد
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  const cfg = loadConfig();
  if (password === cfg.dashboardPassword) return res.json({ role: "cs", redirect: `/dashboard/${password}` });
  if (password === cfg.ownerPassword)    return res.json({ role: "owner", redirect: `/owner/${password}` });
  res.status(401).json({ error: "كلمة المرور غير صحيحة" });
});

app.get("/qr", (req, res) => {
  if (global.qrCodeUrl) {
    res.send(
      `<html><body style="background:#111;color:#fff;text-align:center;font-family:sans-serif;padding:30px">
        <h2>امسح الكود من واتساب</h2>
        <img src="${global.qrCodeUrl}" style="max-width:90vw"/>
        <p>الأجهزة المرتبطة → ربط جهاز</p>
      </body></html>`
    );
  } else {
    res.send("لا يوجد QR حاليًا (إما البوت متصل، أو ينتظر إعادة محاولة)");
  }
});

app.get("/api/qr-status", (req, res) => {
  res.json({ hasQR: !!global.qrCodeUrl, dataUrl: global.qrCodeUrl || null });
});

// تشغيل الاتصال بوضع QR (بدون مصادقة مسبقة)
app.post("/api/owner/start-qr", (req, res) => {
  const { ownerKey } = req.body;
  const cfg = loadConfig();
  if (ownerKey !== cfg.ownerPassword) return res.status(403).json({ error: "غير مصرح" });
  if (global.botConnected) return res.status(400).json({ error: "البوت متصل بالفعل" });
  if (global.pairingConnecting) return res.status(400).json({ error: "جاري الاتصال بالفعل" });
  global.qrCodeUrl = null;
  connectToWhatsApp();
  res.json({ ok: true });
});

// طلب كود الربط — يُشغّل الاتصال بنفسه ثم يجلب الكود
app.post("/api/pairing-code", async (req, res) => {
  const { ownerKey, phone } = req.body;
  const cfg = loadConfig();
  if (ownerKey !== cfg.ownerPassword) return res.status(403).json({ error: "غير مصرح" });
  if (!phone) return res.status(400).json({ error: "أدخل رقم الهاتف" });

  const cleanPhone = phone.replace(/\D/g, "");
  if (cleanPhone.length < 7) return res.status(400).json({ error: "رقم الهاتف غير صحيح" });

  if (global.botConnected) {
    return res.status(400).json({ needDisconnect: true, error: "البوت متصل حالياً — يجب فصله أولاً" });
  }

  // إذا الكود جاهز مسبقاً أرجعه فوراً
  if (global.pairingCodeResult) {
    const r = global.pairingCodeResult;
    global.pairingCodeResult = null;
    global.pairingConnecting = false;
    if (r.error) return res.status(500).json({ error: r.error });
    return res.json({ code: r.code });
  }

  // شغّل الاتصال إن لم يكن شغّالاً
  if (!global.pairingConnecting) {
    global.pairingConnecting = true;
    global.pairingCodeResult = null;
    connectWithPairingCode(cleanPhone);
  }

  // انتظر حتى 35 ثانية للحصول على الكود
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (global.pairingCodeResult) {
      const r = global.pairingCodeResult;
      global.pairingCodeResult = null;
      global.pairingConnecting = false;
      if (r.error) return res.status(500).json({ error: r.error });
      return res.json({ code: r.code });
    }
  }
  global.pairingConnecting = false;
  res.status(504).json({ error: "انتهت المهلة — لم يصل الكود، تأكد من الرقم وحاول مجدداً" });
});

// فصل البوت فقط (بدون بدء اتصال جديد)
app.post("/api/owner/disconnect", async (req, res) => {
  const { ownerKey } = req.body;
  const cfg = loadConfig();
  if (ownerKey !== cfg.ownerPassword) return res.status(403).json({ error: "غير مصرح" });

  global.pairingCodeResult = null;
  global.pairingConnecting = false;
  global.botConnected = false;
  global.qrCodeUrl = null;

  try {
    if (sock) {
      sock.ev.removeAllListeners();
      await sock.logout().catch(() => {});
      sock.ws?.close();
    }
  } catch (e) {}
  sock = null;

  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {}

  res.json({ ok: true, message: "تم فصل البوت وحذف بيانات الاتصال" });
});

// ===== API لوحة التحكم =====

// قائمة العملاء مرتبة بالأحدث
app.get("/api/clients", (req, res) => {
  const list = [];
  for (const [userId, data] of clientsData.entries()) {
    list.push({
      userId,
      name: data.name,
      lastMessage: data.lastMessage,
      lastTime: data.lastTime,
      messageCount: data.messageCount,
      paused: pausedUsers.has(userId),
    });
  }
  list.sort((a, b) => b.lastTime - a.lastTime);
  res.json(list);
});

// محادثات عميل معين
app.get("/api/clients/:userId/messages", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const data = clientsData.get(userId);
  if (!data) return res.json([]);
  res.json(data.messages);
});

// إيقاف/تشغيل البوت لعميل
app.post("/api/clients/:userId/toggle-pause", (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  if (pausedUsers.has(userId)) {
    pausedUsers.delete(userId);
    savePausedUsers();
    res.json({ paused: false });
  } else {
    pausedUsers.add(userId);
    savePausedUsers();
    res.json({ paused: true });
  }
});

// المعرفة المخصصة — أقسام
app.get("/api/knowledge", (req, res) => {
  res.json(loadKnowledgeData());
});

app.post("/api/knowledge/:section", (req, res) => {
  const { section } = req.params;
  if (!KNOWLEDGE_SECTIONS[section]) return res.status(400).json({ error: "قسم غير موجود" });
  const { text } = req.body;
  if (typeof text !== "string") return res.status(400).json({ error: "invalid" });
  const data = loadKnowledgeData();
  data[section] = text;
  saveKnowledgeData(data);
  res.json({ ok: true });
});

app.delete("/api/knowledge/:section", (req, res) => {
  const { section } = req.params;
  if (!KNOWLEDGE_SECTIONS[section]) return res.status(400).json({ error: "قسم غير موجود" });
  const data = loadKnowledgeData();
  data[section] = "";
  saveKnowledgeData(data);
  res.json({ ok: true });
});

// إحصائيات سريعة
app.get("/api/stats", (req, res) => {
  res.json({
    totalClients: clientsData.size,
    activeClients: clientsData.size - pausedUsers.size,
    pausedClients: pausedUsers.size,
    botConnected: !!sock,
  });
});

// ===== حماية الداشبورد بالباسورد =====
app.get("/dashboard/:key", (req, res) => {
  const cfg = loadConfig();
  if (req.params.key !== cfg.dashboardPassword) return res.status(403).send("❌ كلمة المرور غير صحيحة");
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/owner/:key", (req, res) => {
  const cfg = loadConfig();
  if (req.params.key !== cfg.ownerPassword) return res.status(403).send("❌ كلمة المرور غير صحيحة");
  res.sendFile(path.join(__dirname, "public", "owner.html"));
});

// ===== APIs المالك =====

// إحصائيات المالك (شهرية وأسبوعية)
app.get("/api/owner/stats", (req, res) => {
  const contacts = loadContacts();
  const now = Date.now();
  const ms = { day: 86400000, week: 604800000, month: 2592000000 };
  res.json({
    total:     contacts.length,
    today:     contacts.filter(c => now - c.lastContact < ms.day).length,
    thisWeek:  contacts.filter(c => now - c.lastContact < ms.week).length,
    thisMonth: contacts.filter(c => now - c.lastContact < ms.month).length,
    botConnected: !!sock,
    totalSessions: clientsData.size,
    pausedSessions: pausedUsers.size,
    monthlyBreakdown: buildMonthlyBreakdown(contacts),
  });
});

function buildMonthlyBreakdown(contacts) {
  const map = {};
  for (const c of contacts) {
    const d = new Date(c.firstContact);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    map[key] = (map[key] || 0) + 1;
  }
  return Object.entries(map).sort().slice(-6).map(([k,v]) => ({ month: k, count: v }));
}

// تحميل جهات الاتصال
app.get("/api/owner/contacts", (req, res) => {
  res.json(loadContacts());
});

app.get("/api/owner/contacts/download", (req, res) => {
  const contacts = loadContacts();
  res.setHeader("Content-Disposition", `attachment; filename="iefada_contacts_${Date.now()}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(contacts, null, 2));
});

// قراءة الإعدادات (للمالك فقط)
app.get("/api/owner/get-config", (req, res) => {
  const { key } = req.query;
  const cfg = loadConfig();
  if (key !== cfg.ownerPassword) return res.status(403).json({ error: "غير مصرح" });
  res.json({ dashboardPassword: cfg.dashboardPassword });
});

// تغيير باسورد خدمة العملاء
app.post("/api/owner/change-cs-password", (req, res) => {
  const { ownerKey, newPassword } = req.body;
  const cfg = loadConfig();
  if (ownerKey !== cfg.ownerPassword) return res.status(403).json({ error: "غير مصرح" });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "الباسورد قصير جداً" });
  cfg.dashboardPassword = newPassword;
  saveConfig(cfg);
  res.json({ ok: true });
});

// إرسال رسالة إعلانية
app.post("/api/owner/broadcast", async (req, res) => {
  const { ownerKey, message, phones, withButtons, imageBase64, imageMime } = req.body;
  const cfg = loadConfig();
  if (ownerKey !== cfg.ownerPassword) return res.status(403).json({ error: "غير مصرح" });
  if (!phones || !phones.length) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!sock) return res.status(503).json({ error: "البوت غير متصل" });

  const hasImage   = !!(imageBase64 && imageMime);
  const hasMessage = !!(message && message.trim());
  if (!hasImage && !hasMessage) return res.status(400).json({ error: "أرسل نصاً أو صورة على الأقل" });

  const imgBuf = hasImage ? Buffer.from(imageBase64, "base64") : null;

  const results = [];
  for (const identifier of phones) {
    const jid = identifier.includes("@")
      ? identifier
      : identifier.replace(/\D/g, "") + "@s.whatsapp.net";
    try {
      if (hasImage) {
        // صورة (مع كابشن اختياري) + زر "أنا مهتم" اختياري
        const imgPayload = {
          image: imgBuf,
          mimetype: imageMime,
          caption: hasMessage ? message : undefined,
        };
        if (withButtons) {
          try {
            await sock.sendMessage(jid, {
              ...imgPayload,
              buttons: [
                { buttonId: "interested", buttonText: { displayText: "← أنا مهتم" }, type: 1 },
              ],
              footer: "",
              headerType: 4,
            });
          } catch (_) {
            // fallback: صورة بدون أزرار
            await sock.sendMessage(jid, imgPayload);
          }
        } else {
          await sock.sendMessage(jid, imgPayload);
        }
      } else {
        // نص فقط + زر اختياري
        if (withButtons) {
          try {
            await sock.sendMessage(jid, {
              text: message,
              buttons: [
                { buttonId: "interested", buttonText: { displayText: "← أنا مهتم" }, type: 1 },
              ],
              headerType: 1,
            });
          } catch (_) {
            await sock.sendMessage(jid, { text: message });
          }
        } else {
          await sock.sendMessage(jid, { text: message });
        }
      }
      results.push({ id: identifier, ok: true });
    } catch (e) {
      results.push({ id: identifier, ok: false, error: e?.message || "فشل" });
    }
    await new Promise(r => setTimeout(r, 700));
  }
  res.json({ results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
});

app.listen(5000, "0.0.0.0", () => {
  console.log("✅ Server on port 5000 — /dashboard للوحة التحكم");
});

// ==================== تأخير بشري ====================

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

async function humanDelay(jid) {
  const delay = rand(800, 2200);
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (e) {}
  await new Promise(r => setTimeout(r, delay));
}

// ==================== تحميل الكورسات ====================

async function fetchAllCoursesFromAPI() {
  try {
    const r = await axios.get(IEFADA_SUMMARY_API, { timeout: 10000 });
    const slugs = r.data.data.courses.map(c => c.slug);
    const allDetails = [];
    for (const slug of slugs) {
      try {
        const r2 = await axios.get(IEFADA_COURSE_API.replace("{slug}", slug), {
          timeout: 10000,
        });
        if (r2.status === 200) allDetails.push(r2.data);
      } catch (e) {}
      await new Promise(r => setTimeout(r, 50));
    }
    return allDetails;
  } catch (e) {
    console.log(`Error fetching courses: ${e?.message || e}`);
    return null;
  }
}

async function loadCourses() {
  try {
    if (fs.existsSync(LOCAL_COURSES_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_COURSES_FILE, "utf-8"));
      console.log(`✅ Loaded ${data.length} courses from local file`);
      return data;
    }
  } catch (e) {}
  console.log("🔄 Fetching courses from API...");
  const data = await fetchAllCoursesFromAPI();
  if (data) {
    fs.writeFileSync(LOCAL_COURSES_FILE, JSON.stringify(data, null, 2), "utf-8");
    console.log(`✅ Fetched and saved ${data.length} courses`);
    return data;
  }
  return [];
}

// ==================== معالجة الأوامر ====================

const CAT_ICONS = {
  "Web Development": "🌐",
  "Mobile Development": "📱",
  "Data Science": "📊",
  "DevOps & Cloud": "☁️",
  "UI/UX Design": "🎨",
};

function buildStartMessage(displayName) {
  const name = displayName || "أهلاً";
  return (
    `هلا ${name}، أنا عبدالله من فريق إفادة 👋\n\n` +
    "أقدر أساعدك في أي شي يخص كورساتنا — أسعار، تفاصيل، تسجيل.\n\n" +
    "بس اسألني 😊"
  );
}

function buildCoursesMessage() {
  const categories = {};
  for (const c of coursesData) {
    const cat = c.category_title || "أخرى";
    categories[cat] = (categories[cat] || 0) + 1;
  }
  const lines = ["الكورسات المتاحة في إفادة:\n"];
  for (const cat of Object.keys(categories).sort()) {
    const icon = CAT_ICONS[cat] || "📌";
    lines.push(`${icon} ${cat} — ${categories[cat]} كورس`);
  }
  lines.push(`\n${IEFADA_URL}`);
  return lines.join("\n");
}

const HELP_MESSAGE =
  "الأوامر:\n" +
  "/start — بداية جديدة\n" +
  "/courses — عرض التصنيفات\n\n" +
  "أو أرسل سؤالك نصاً أو صوتاً 🎙️";

const ESCALATION_MESSAGE =
  "سيتواصل معك فريق الدعم قريبًا لمساعدتك بشكل أكبر 🙏";

// ==================== اتصال واتساب ====================

let sock;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 500;
const messageStore = new Map();
const IGNORE_OLD_MESSAGES_THRESHOLD = 15 * 60 * 1000;

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    reconnectAttempts = 0;
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) global.qrCodeUrl = url;
    });
    console.log("📱 افتح /qr في المعاينة لمسح الكود من المتصفح");
  }

  if (connection === "open") {
    reconnectAttempts = 0;
    global.qrCodeUrl = null;
    global.botConnected = true;
    global.botOwnJid = sock?.user?.id || null;
    try {
      await sock.sendPresenceUpdate("unavailable");
    } catch (e) {}
    console.log("🟢 البوت متصل بواتساب" + (global.botOwnJid ? ` (${global.botOwnJid})` : ""));
  }

  if (connection === "close") {
    global.botConnected = false;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message || statusCode || "unknown";
    console.log(`🔴 انقطع الاتصال — سبب: ${reason}`);

    if (statusCode === 401) {
      // تسجيل خروج من واتساب → احذف المصادقة ولا تعد الاتصال
      if (fs.existsSync(AUTH_DIR)) {
        console.log("⚠️ تم تسجيل الخروج — حذف بيانات المصادقة");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      console.log("ℹ️ يجب الربط من جديد من لوحة المالك");
    } else if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`🔄 إعادة محاولة الاتصال #${reconnectAttempts} خلال 15 ثانية...`);
      setTimeout(connectToWhatsApp, 15000);
    } else {
      console.log("❌ تجاوز الحد الأقصى لمحاولات الاتصال — انتظر تدخل يدوي");
    }
  }
}

// ربط معالج LID للـ socket الحالي
function registerLidHandler() {
  if (!sock?.ws) return;
  sock.ws.on("CB:message", (node) => {
    try {
      const attrs = node.attrs || {};
      if (attrs.from?.endsWith("@lid") && attrs.sender_pn?.endsWith("@s.whatsapp.net")) {
        const realNum = attrs.sender_pn.split("@")[0].replace(/\s+/g, "");
        if (!lidToRealPhone.has(attrs.from) || lidToRealPhone.get(attrs.from) !== realNum) {
          lidToRealPhone.set(attrs.from, realNum);
          console.log(`✅ LID→رقم: ${attrs.from} = +${realNum}`);
          try {
            const contacts = loadContacts();
            const idx = contacts.findIndex(c => c.jid === attrs.from);
            if (idx >= 0) {
              contacts[idx].phone = "+" + realNum;
              fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), "utf-8");
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  });
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (e) {
      version = [2, 2413, 51];
    }

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      version,
      logger: P({ level: "silent" }),
      markOnlineOnConnect: false,
      getMessage: async key => {
        if (!key?.id) return undefined;
        return messageStore.get(key.id) || undefined;
      },
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", handleConnectionUpdate);
    sock.ev.on("messages.upsert", handleMessagesUpsert);
    registerLidHandler();
  } catch (e) {
    console.error("خطأ في connectToWhatsApp:", e);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// اتصال خاص بوضع كود الربط
async function connectWithPairingCode(phone) {
  console.log(`📲 بدء الاتصال بوضع كود الربط للرقم: ${phone}`);

  // أغلق أي socket موجود قبل البدء
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.ws?.close(); } catch (_) {}
    sock = null;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (e) {
      version = [2, 2413, 51];
    }

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      version,
      logger: P({ level: "silent" }),
      markOnlineOnConnect: false,
      getMessage: async key => {
        if (!key?.id) return undefined;
        return messageStore.get(key.id) || undefined;
      },
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", handleMessagesUpsert);
    registerLidHandler();

    let pairingCodeRequested = false;
    let pairingSucceeded    = false;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // عند ظهور QR = الـ socket اتصل بخوادم واتساب → نطلب الكود
      if (qr && !pairingCodeRequested) {
        pairingCodeRequested = true;
        qrcode.toDataURL(qr, (err, url) => { if (!err) global.qrCodeUrl = url; });
        try {
          const rawCode = await sock.requestPairingCode(phone);
          // نعرض الكود بصيغة XXXX-XXXX لتسهيل الإدخال في واتساب
          const code = rawCode && rawCode.length === 8 && !rawCode.includes("-")
            ? rawCode.slice(0, 4) + "-" + rawCode.slice(4)
            : rawCode;
          global.pairingCodeResult = { code, ts: Date.now() };
          console.log(`✅ كود الربط: ${code}`);
        } catch (e) {
          console.error("❌ خطأ في طلب كود الربط:", e?.message);
          global.pairingCodeResult = { error: e?.message || "فشل طلب الكود" };
          global.pairingConnecting = false;
        }
      }

      if (connection === "open") {
        pairingSucceeded = true;
        global.pairingConnecting = false;
        global.qrCodeUrl = null;
        global.botConnected = true;
        global.botOwnJid = sock?.user?.id || null;
        try { await sock.sendPresenceUpdate("unavailable"); } catch (_) {}
        console.log("🟢 البوت متصل بواتساب (pairing code)" + (global.botOwnJid ? ` (${global.botOwnJid})` : ""));
      }

      if (connection === "close") {
        global.botConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || statusCode || "unknown";
        console.log(`🔴 انقطع الاتصال (pairing) — سبب: ${reason}`);

        if (statusCode === 401 && fs.existsSync(AUTH_DIR)) {
          console.log("⚠️ تم تسجيل الخروج — حذف بيانات المصادقة");
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }

        if (pairingSucceeded) {
          // الربط نجح سابقاً → أعد الاتصال الطبيعي
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`🔄 إعادة الاتصال #${reconnectAttempts} خلال 15 ثانية...`);
            setTimeout(connectToWhatsApp, 15000);
          }
        } else if (pairingCodeRequested && statusCode !== 401) {
          // الكود أُرسل لكن المصادقة لم تكتمل → أعد المحاولة بكود جديد بعد 3 ثوانٍ
          console.log("🔄 إعادة الاتصال للحصول على كود ربط جديد...");
          global.pairingConnecting = true;
          setTimeout(() => connectWithPairingCode(phone), 3000);
        } else {
          global.pairingConnecting = false;
        }
      }
    });
  } catch (e) {
    console.error("❌ خطأ في connectWithPairingCode:", e?.message);
    global.pairingCodeResult = { error: e?.message || "فشل طلب الكود" };
    global.pairingConnecting = false;
  }
}

// ==================== معالجة الرسائل ====================

async function sendText(jid, text) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.log(`خطأ في إرسال الرسالة: ${e?.message || e}`);
  }
}

async function handleMessagesUpsert({ messages }) {
  try {
    const msg = messages[0];
    if (!msg || !msg.message) return;
    if (msg.key?.id && msg.message) messageStore.set(msg.key.id, msg.message);

    const sender = msg.key.remoteJid;
    if (!sender || sender.endsWith("@g.us")) return;
    if (msg.key.fromMe) return;

    const messageTimestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
    if (messageTimestamp < Date.now() - IGNORE_OLD_MESSAGES_THRESHOLD) return;

    const userId = sender;
    const pushName = msg.pushName || "";

    // ===== رسالة صوتية =====
    const audioMsg = msg.message.audioMessage;
    if (audioMsg) {
      console.log(`[VOICE] من: ${userId}`);

      // تحديث بيانات العميل حتى لو موقوف
      updateClientData(userId, pushName, "[رسالة صوتية]");

      // إذا كان البوت موقوفًا تجاهل الرسالة تمامًا
      if (pausedUsers.has(userId)) {
        console.log(`  [PAUSED] تجاهل رسالة صوتية من: ${userId}`);
        return;
      }

      await humanDelay(sender);

      let tmpPath;
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        tmpPath = path.join(os.tmpdir(), `wa_${Date.now()}.ogg`);
        fs.writeFileSync(tmpPath, buffer);
      } catch (e) {
        console.log(`  [VOICE] خطأ تحميل: ${e?.message || e}`);
        await sendText(sender, "ما قدرت أسمع الرسالة، جرب مرة ثانية 🙏");
        return;
      }

      const userText = await transcribeVoice(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch (e) {}

      if (!userText) {
        await sendText(sender, "ما فهمت الصوت، تقدر تكتب سؤالك؟ 😊");
        return;
      }

      console.log(`  [VOICE] النص المُستخرج: ${userText}`);
      await humanDelay(sender);
      let aiText = await getAIResponse(userId, userText);

      // كشف التصعيد
      if (aiText && aiText.startsWith("[ESCALATE]")) {
        pausedUsers.add(userId);
        savePausedUsers();
        console.log(`  [ESCALATE] تم إيقاف البوت عن: ${userId}`);
        await sendText(sender, ESCALATION_MESSAGE);
        updateClientData(userId, pushName, ESCALATION_MESSAGE, true);
        // تنبيه المالك على رقم البوت
        if (global.botOwnJid) {
          const phone = getRealPhone(userId);
          const notif = `🔔 *تنبيه تصعيد*\n👤 العميل: ${pushName || "غير معروف"}\n📞 الرقم: ${phone}\n💬 آخر رسالة: ${userText.slice(0, 120)}`;
          try { await sendText(global.botOwnJid, notif); } catch (_) {}
        }
        return;
      }

      const formatted = formatReply(aiText);
      await sendText(sender, formatted);
      updateClientData(userId, pushName, formatted, true);
      return;
    }

    // ===== نص =====
    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""
    ).trim();

    if (!text) return;

    console.log(`[MSG] ${userId}: ${text.slice(0, 60)}`);

    // تحديث بيانات العميل دائمًا
    updateClientData(userId, pushName, text);

    // إذا كان البوت موقوفًا تجاهل تمامًا (لا ترسل للـ AI)
    if (pausedUsers.has(userId)) {
      console.log(`  [PAUSED] تجاهل رسالة من: ${userId}`);
      return;
    }

    // أوامر بسيطة
    const lower = text.toLowerCase();
    if (lower === "/start" || lower === "ابدا" || lower === "ابدأ") {
      conversationHistory.set(userId, []);
      const startMsg = buildStartMessage(pushName);
      await sendText(sender, startMsg);
      updateClientData(userId, pushName, startMsg, true);
      return;
    }
    if (lower === "/courses" || lower === "الكورسات" || lower === "كورسات") {
      const coursesMsg = buildCoursesMessage();
      await sendText(sender, coursesMsg);
      updateClientData(userId, pushName, coursesMsg, true);
      return;
    }
    if (lower === "/help" || lower === "مساعدة" || lower === "help") {
      await sendText(sender, HELP_MESSAGE);
      updateClientData(userId, pushName, HELP_MESSAGE, true);
      return;
    }

    await humanDelay(sender);
    let response = await getAIResponse(userId, text);

    // كشف التصعيد
    if (response && response.startsWith("[ESCALATE]")) {
      pausedUsers.add(userId);
      savePausedUsers();
      console.log(`  [ESCALATE] تم إيقاف البوت عن: ${userId}`);
      await sendText(sender, ESCALATION_MESSAGE);
      updateClientData(userId, pushName, ESCALATION_MESSAGE, true);
      // تنبيه المالك على رقم البوت
      if (global.botOwnJid) {
        const phone = getRealPhone(userId);
        const notif = `🔔 *تنبيه تصعيد*\n👤 العميل: ${pushName || "غير معروف"}\n📞 الرقم: ${phone}\n💬 آخر رسالة: ${text.slice(0, 120)}`;
        try { await sendText(global.botOwnJid, notif); } catch (_) {}
      }
      return;
    }

    response = formatReply(response);

    if (Math.random() < 0.3) {
      await new Promise(r => setTimeout(r, rand(300, 800)));
    }

    await sendText(sender, response);
    updateClientData(userId, pushName, response, true);
  } catch (e) {
    console.error("خطأ في handleMessagesUpsert:", e);
  } finally {
    if (sock) {
      try { await sock.sendPresenceUpdate("unavailable"); } catch (e) {}
    }
  }
}

// ==================== التشغيل ====================

(async () => {
  console.log("✅ بوت إفادة (واتساب) يبدأ التشغيل...");

  // إنشاء مجلد public إن لم يكن موجودًا
  if (!fs.existsSync("public")) fs.mkdirSync("public");

  console.log("🔄 جاري تحميل بيانات الكورسات...");
  coursesData = await loadCourses();

  if (coursesData && coursesData.length) {
    console.log(`✅ تم تحميل ${coursesData.length} كورس`);
    prebuildContextCache();
    console.log(`🤖 النماذج: ${AI_MODELS.join(" → ")}`);
  } else {
    console.log("⚠️ تعذر تحميل بيانات الكورسات");
    prebuildContextCache();
  }

  // اتصال تلقائي فقط إذا كانت بيانات مصادقة موجودة
  const hasAuth = fs.existsSync(AUTH_DIR) &&
    fs.readdirSync(AUTH_DIR).filter(f => !f.startsWith(".")).length > 0;

  if (hasAuth) {
    console.log("🟢 بيانات مصادقة موجودة — جاري الاتصال...");
    connectToWhatsApp();
  } else {
    console.log("ℹ️ لا توجد بيانات مصادقة — انتظر الربط من لوحة المالك");
  }
})();
