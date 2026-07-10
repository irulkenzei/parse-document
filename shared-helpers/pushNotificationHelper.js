// 🔔 Helper reusable buat kirim push notification lewat Expo Push API.
// COPY-PASTE fungsi ini ke Function manapun yang butuh ngirim notifikasi
// setelah proses panjang selesai (generate-subtitle, convert-document,
// web-connect-replicate, dst) -- Appwrite Functions itu deployment
// terpisah-terpisah, jadi tidak ada mekanisme "shared code" otomatis
// antar-Function, kode ini perlu disalin manual ke tiap Function yang
// butuh.
//
// Cara pakai (dalam Function manapun):
//   const { Query } = require('node-appwrite');
//   await sendPushNotification(databases, DATABASE_ID, userId,
//     'Subtitle Ready!', 'Your subtitle file has been generated.',
//     { type: 'subtitle_ready', requestId });

async function sendPushNotification(databases, databaseId, userId, title, body, data = {}) {
  const { Query } = require('node-appwrite');

  if (!userId) {
    console.log('[push] No userId provided, skipping push notification.');
    return;
  }

  try {
    // 1. Cari semua push token milik user ini (bisa lebih dari 1 kalau
    // dia pakai beberapa device -- Android + iOS sekaligus, misalnya)
    const tokenDocs = await databases.listDocuments(databaseId, 'push_tokens', [
      Query.equal('user_id', userId),
    ]);

    if (tokenDocs.documents.length === 0) {
      console.log(`[push] No push tokens found for user ${userId}, skipping.`);
      return;
    }

    // 2. Bentuk pesan buat tiap token (format yang diminta Expo Push API)
    const messages = tokenDocs.documents.map((doc) => ({
      to: doc.expo_push_token,
      sound: 'default',
      title,
      body,
      data,
    }));

    // 3. Kirim ke Expo Push API -- ini endpoint PUBLIK Expo, tidak perlu
    // API key apapun buat kirim notifikasi (beda dari APNs/FCM native
    // yang butuh setup credential rumit -- Expo yang handle itu semua
    // di baliknya).
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    console.log('[push] Push notification sent:', JSON.stringify(result));
  } catch (e) {
    // ⚠️ PENTING: kegagalan kirim notifikasi TIDAK BOLEH bikin seluruh
    // Function gagal -- proses utama (transkripsi/konversi/dst) sudah
    // berhasil, notifikasi itu cuma "bonus", jadi errornya di-log doang.
    console.error('[push] Failed to send push notification:', e.message);
  }
}

module.exports = { sendPushNotification };
