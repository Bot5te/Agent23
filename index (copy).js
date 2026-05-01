// ====================== بوت إفادة على واتساب ======================
// نسخة Node.js من main.py — اتصال واتساب مأخوذ من otherindex.js (Baileys)

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

const GROQ_API_KEY =
  process.env.GROQ_API_KEY ||
  "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";

const IEFADA_SUMMARY_API = "https://www.iefada.com/api/v1/website/global-summary";
const IEFADA_COURSE_API = "https://www.iefada.com/api/v1/website/courses/{slug}";
const IEFADA_URL = "https://www.iefada.com";
const LOCAL_COURSES_FILE = "all_courses_details.json";

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
let coursesData = [];
const _contextCache = {};

global.qrCodeUrl = null;

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

  const tokens = Math.round(context.split(/\s+/).length * 1.3);
  console.log(`  [Context:${label}] ~${tokens} توكن`);
  return context;
}

// ==================== برومبت النظام ====================

const SYSTEM_BASE = `أنت عبدالله، شاب سعودي في فريق إفادة للتعليم.

مهمتك: تحاور الشخص بشكل طبيعي حتى يسجّل في كورس.

طريقة كلامك:
- تحكي زي ما تكلّم صاحبك — قصير، مباشر، جملتين أو ثلاث.
- لا قوائم، لا نقاط، لا عناوين. حاور فقط.
- لا تبدأ بـ"بالطبع" أو "أهلاً وسهلاً" كل مرة.

الإقناع:
- وضّح كيف يغيّر الكورس وضع الشخص، لا تمدحه فقط.
- السعر  "استثمار صغير" مو "تكلفة".
- "بعد سنة من الحين راح تتمنى بدأت اليوم".
- "التسجيل ما يأخذ دقيقتين".
- لو ما عرفت هدفه — اسأله أولاً.
-لا تكرر نفس الكلام مش كل رسالة تقولي التسجيل ما ياخذ دقيقتين ولا تكرر ارسال الرابط بكل رسالة

قواعد:
- لو سألك "هل أنت بوت؟" → "لا، أنا عبدالله 😄 ليش؟"
- لا تخترع معلومات. لو ما عندك → وجه للموقع.
- لا نجوم، لا جداول. الروابط في سطر لوحدها.

بيانات المنصة:
{context}`;

// ==================== تنسيق النص ====================

function formatReply(text) {
  let t = text || "";
  // **bold** -> *bold* (تنسيق واتساب)
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // ضع الروابط في سطر مستقل
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

  // عند الفشل: قصّر الذاكرة وأعد رسالة احتياطية
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

// ==================== سيرفر صحي + QR ====================

const app = express();
app.get("/", (req, res) => res.send("OK"));
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
app.listen(5000, "0.0.0.0", () => {
  console.log("✅ Health server on port 5000 (افتح /qr لمسح الكود)");
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

// ==================== اتصال واتساب (مأخوذ من otherindex.js) ====================

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
    const terminalQR = await qrcode.toString(qr, { type: "terminal", small: true });
    console.log(terminalQR);
    console.log("📱 افتح /qr في المعاينة لمسح الكود من المتصفح");
  }

  if (connection === "open") {
    reconnectAttempts = 0;
    global.qrCodeUrl = null;
    try {
      await sock.sendPresenceUpdate("unavailable");
    } catch (e) {}
    console.log("🟢 البوت متصل بواتساب");
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    if (statusCode === 401 && fs.existsSync(AUTH_DIR)) {
      console.log("⚠️ تم تسجيل الخروج — حذف بيانات المصادقة");
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`🔄 إعادة محاولة الاتصال #${reconnectAttempts} خلال 15 ثانية...`);
      setTimeout(connectToWhatsApp, 15000);
    }
  }
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
  } catch (e) {
    console.error("خطأ في connectToWhatsApp:", e);
    setTimeout(connectToWhatsApp, 10000);
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
    if (!sender || sender.endsWith("@g.us")) return; // تجاهل المجموعات
    if (msg.key.fromMe) return; // تجاهل الرسائل الصادرة منا

    const messageTimestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
    if (messageTimestamp < Date.now() - IGNORE_OLD_MESSAGES_THRESHOLD) return;

    const userId = sender;
    const pushName = msg.pushName || "";

    // ===== رسالة صوتية =====
    const audioMsg = msg.message.audioMessage;
    if (audioMsg) {
      console.log(`[VOICE] من: ${userId}`);
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
      const aiText = await getAIResponse(userId, userText);
      await sendText(sender, formatReply(aiText));
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

    // أوامر بسيطة
    const lower = text.toLowerCase();
    if (lower === "/start" || lower === "ابدا" || lower === "ابدأ") {
      conversationHistory.set(userId, []);
      await sendText(sender, buildStartMessage(pushName));
      return;
    }
    if (lower === "/courses" || lower === "الكورسات" || lower === "كورسات") {
      await sendText(sender, buildCoursesMessage());
      return;
    }
    if (lower === "/help" || lower === "مساعدة" || lower === "help") {
      await sendText(sender, HELP_MESSAGE);
      return;
    }

    await humanDelay(sender);
    let response = await getAIResponse(userId, text);
    response = formatReply(response);

    if (Math.random() < 0.3) {
      await new Promise(r => setTimeout(r, rand(300, 800)));
    }

    await sendText(sender, response);
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

  console.log("🔄 جاري تحميل بيانات الكورسات...");
  coursesData = await loadCourses();

  if (coursesData && coursesData.length) {
    console.log(`✅ تم تحميل ${coursesData.length} كورس`);
    prebuildContextCache();
    console.log(`🤖 النماذج: ${AI_MODELS.join(" → ")}`);
  } else {
    console.log("⚠️ تعذر تحميل بيانات الكورسات");
    // ابنِ كاش أساسي على الأقل
    prebuildContextCache();
  }

  console.log("🟢 جاري الاتصال بواتساب...");
  connectToWhatsApp();
})();