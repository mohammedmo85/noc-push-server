// ─── سيرفر Push حقيقي لتطبيق دوام المناوبين والبصمات ─────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'subscriptions.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('✗ خطأ: لازم تولّد مفاتيح VAPID أولاً بتشغيل: npm run generate-vapid');
  console.error('  ثم احفظهم بملف .env (راجع .env.example)');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// ─── تخزين بسيط بملف JSON (يكفي للاستخدام الشخصي / فريق صغير) ───────────────
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// db شكلها:
// { [endpoint]: { subscription, alarms, states, fuelStart, timezone, lastFired: {tag: 'YYYY-MM-DD'} } }

// ─── تسجيل/تحديث اشتراك Push + بيانات المنبهات ──────────────────────────────
app.post('/api/subscribe', (req, res) => {
  const { subscription, alarms, states, fuelStart, timezone } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription غير صالح' });
  }
  const db = loadDB();
  const existing = db[subscription.endpoint] || {};
  db[subscription.endpoint] = {
    subscription,
    alarms: alarms || existing.alarms || [],
    states: states || existing.states || {},
    fuelStart: fuelStart || existing.fuelStart,
    timezone: timezone || existing.timezone || 'Asia/Riyadh',
    lastFired: existing.lastFired || {}
  };
  saveDB(db);
  res.json({ ok: true });
});

// ─── تحديث بيانات المنبهات فقط (عند تغيير حالة منبه) ────────────────────────
app.post('/api/update-alarms', (req, res) => {
  const { endpoint, alarms, states, fuelStart } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint مطلوب' });
  const db = loadDB();
  if (!db[endpoint]) return res.status(404).json({ error: 'الاشتراك غير موجود' });
  if (alarms) db[endpoint].alarms = alarms;
  if (states) db[endpoint].states = states;
  if (fuelStart) db[endpoint].fuelStart = fuelStart;
  saveDB(db);
  res.json({ ok: true });
});

// ─── إلغاء الاشتراك ──────────────────────────────────────────────────────────
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const db = loadDB();
  delete db[endpoint];
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get('/', (req, res) => {
  res.send('NOC Push Server يعمل ✓');
});

// ─── المجدول: يفحص كل المشتركين كل دقيقة بتوقيت كل واحد فيهم ────────────────
function getLocalHM(timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return { h, m };
  } catch (e) {
    const now = new Date();
    return { h: now.getUTCHours(), m: now.getUTCMinutes() };
  }
}

function getLocalDateKey(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()); // YYYY-MM-DD
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function getLocalDayStartMs(timezone) {
  const dateKey = getLocalDateKey(timezone);
  return new Date(dateKey + 'T00:00:00Z').getTime();
}

async function checkAndSend() {
  const db = loadDB();
  let changed = false;

  for (const endpoint of Object.keys(db)) {
    const entry = db[endpoint];
    const { alarms, states, fuelStart, timezone } = entry;
    if (!alarms || !alarms.length) continue;

    const { h, m } = getLocalHM(timezone);
    const dateKey = getLocalDateKey(timezone);
    const dayMs = getLocalDayStartMs(timezone);

    for (const a of alarms) {
      if (!states[a.id]) continue;

      if (a.fuelAlarm) {
        if (!fuelStart) continue;
        const start = new Date(fuelStart);
        const startMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
        const diff = Math.floor((dayMs - startMs) / 86400000);
        if (diff < 0 || (diff % 5) !== 4) continue;
      }

      if (a.hour !== h || a.min !== m) continue;

      // امنع إرسال نفس المنبه أكثر من مرة بنفس اليوم
      if (entry.lastFired[a.id] === dateKey) continue;

      const title = a.fuelAlarm ? '⛽ تنبيه حصة البنزين' : '🔔 تنبيه وجبة';
      const body = a.fuelAlarm ? '⛽ غداً يوم استلام حصة البنزين!' : ((a.icon || '') + ' ' + (a.desc || ''));

      const payload = JSON.stringify({
        title, body, tag: a.id, isFuel: !!a.fuelAlarm
      });

      try {
        await webpush.sendNotification(entry.subscription, payload);
        entry.lastFired[a.id] = dateKey;
        changed = true;
        console.log(`✓ أُرسل تنبيه "${a.id}" إلى ${endpoint.slice(0, 40)}...`);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // الاشتراك لم يعد صالحاً (المستخدم ألغى الإذن أو حذف التطبيق)
          delete db[endpoint];
          changed = true;
          console.warn(`✗ اشتراك منتهي، تم حذفه: ${endpoint.slice(0, 40)}...`);
        } else {
          console.error('✗ خطأ إرسال Push:', err.message);
        }
      }
    }
  }

  if (changed) saveDB(db);
}

// فحص كل 20 ثانية لضمان عدم تفويت الدقيقة المطلوبة
setInterval(checkAndSend, 20 * 1000);

app.listen(PORT, () => {
  console.log(`✓ سيرفر Push يعمل على المنفذ ${PORT}`);
  console.log(`✓ المفتاح العام (VAPID_PUBLIC_KEY): ${VAPID_PUBLIC_KEY}`);
});
