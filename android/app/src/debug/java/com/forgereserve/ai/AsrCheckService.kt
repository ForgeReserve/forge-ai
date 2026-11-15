package com.forgereserve.ai

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Debug builds only: ForgeAsr's check (AsrClient.check, the same path Hold to talk takes, with a WAV clip
 * from files/asr-check/ in place of the microphone) without opening the app's screen, so a phone someone
 * is using is not taken over:
 * `adb shell am start-foreground-service -n <app id>/com.forgereserve.ai.AsrCheckService -e forge.asrCheck clip.wav`
 * then `adb logcat -s ForgeAsr`. Exported only to callers holding DUMP (the adb shell).
 */
class AsrCheckService : Service() {
    private var client: AsrClient? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Speech to text check", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, CHANNEL).setContentTitle("Speech to text check").setSmallIcon(android.R.drawable.ic_btn_speak_now).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, n)
        val name = intent?.getStringExtra("forge.asrCheck")
        val c = client ?: AsrClient(this) { _, type, data ->
            if (type == "error") Log.i(AsrClient.TAG, "check error ${data.optString("code")}")
            if (type == "end") stopSelf()
        }.also { client = it }
        if (name == null || c.listening) {
            Log.i(AsrClient.TAG, "check not run: ${if (name == null) "no forge.asrCheck" else "busy"}")
            if (!c.listening) stopSelf()
        } else {
            c.check(name)
            if (!c.listening) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        client?.destroy()
        super.onDestroy()
    }

    private companion object {
        const val CHANNEL = "asr-check"
    }
}
