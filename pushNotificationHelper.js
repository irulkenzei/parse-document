import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { databases } from './appwrite';

const DATABASE_ID = process.env.EXPO_PUBLIC_APPWRITE_DATABASE_ID!;
const PUSH_TOKENS_COLLECTION_ID = 'push_tokens';

// 🔔 Behavior notifikasi saat app lagi kebuka (foreground) -- tanpa ini,
// notifikasi yang masuk pas app lagi aktif dipakai nggak akan muncul
// sebagai alert/banner sama sekali (default-nya diam-diam aja).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// 📲 Minta izin notifikasi + ambil Expo Push Token + simpan ke database,
// terhubung ke userId. Dipanggil sekali begitu userId tersedia (lihat
// wiring di VoiceScreen.tsx).
//
// ⚠️ CATATAN: expo-notifications itu modul NATIVE -- setelah install,
// WAJIB rebuild dev client (`eas build`), nggak cukup `expo start` biasa.
export async function registerForPushNotificationsAsync(userId: string): Promise<string | null> {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[push] Permission not granted, skipping token registration.');
      return null;
    }

    // Android WAJIB punya notification channel biar notifikasi muncul
    // dengan benar (suara, prioritas, dst) di Android 8+.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    // Expo Push Token butuh projectId (EAS project ID) -- diambil dari
    // app.json/eas.json via expo-constants, bukan di-hardcode di sini.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) {
      console.log('[push] No EAS projectId found in app config -- cannot get push token.');
      return null;
    }

    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenResponse.data;

    // 💾 Simpan token ke database -- document ID = `${userId}-${platform}`,
    // biar 1 user bisa punya token beda per-device (HP Android + iPhone
    // sekaligus, misalnya), dan gampang di-upsert (bukan numpuk banyak
    // token duplikat tiap kali app dibuka ulang).
    const docId = `${userId}-${Platform.OS}`.slice(0, 36);
    try {
      await databases.updateDocument(DATABASE_ID, PUSH_TOKENS_COLLECTION_ID, docId, {
        user_id: userId,
        expo_push_token: token,
        platform: Platform.OS,
      });
    } catch (updateErr: any) {
      // Dokumen belum ada -- bikin baru.
      await databases.createDocument(DATABASE_ID, PUSH_TOKENS_COLLECTION_ID, docId, {
        user_id: userId,
        expo_push_token: token,
        platform: Platform.OS,
      });
    }

    console.log('[push] Push token registered successfully.');
    return token;
  } catch (e: any) {
    console.log('[push] Failed to register for push notifications:', e?.message || e);
    return null;
  }
}

// 👆 Listener buat pas user TAP notifikasi (baik app lagi kebuka di
// background maupun ke-tap dari luar app sama sekali). `data` yang
// dikirim dari Function (lihat sendPushNotification di backend) bisa
// dipakai buat nentuin mau navigasi ke mana -- panggil ini sekali di
// level root app (mis. VoiceScreen.tsx), kasih callback sesuai kebutuhan
// navigasi yang ada.
export function addNotificationResponseListener(
  onNotificationTapped: (data: Record<string, any>) => void
) {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data || {};
    onNotificationTapped(data);
  });
}
