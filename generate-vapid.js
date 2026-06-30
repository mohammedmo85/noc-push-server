// شغّل هذا الملف مرة واحدة فقط لتوليد مفاتيح VAPID
// node generate-vapid.js
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('\n=== احفظ هذه المفاتيح في ملف .env ===\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nانسخ VAPID_PUBLIC_KEY أيضاً والصقه في index.html بمكان PUSH_VAPID_PUBLIC_KEY\n');
