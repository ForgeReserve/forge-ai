package com.forgereserve.ai

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient

/** The Forge app: the v2 web app from the APK's own files, in Capacitor's web view. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ShareInPlugin::class.java)
        registerPlugin(SharePlugin::class.java)
        registerPlugin(NfcPlugin::class.java)
        registerPlugin(TillPlugin::class.java)
        registerPlugin(VoicePlugin::class.java)
        registerPlugin(SpeechPlugin::class.java)
        registerPlugin(BarsPlugin::class.java)
        super.onCreate(savedInstanceState)
        // The app's own files are served cross-origin isolated, as the website serves /v2/, so the natural
        // voice can run on several threads (IsolationRules).
        bridge?.let { b ->
            b.setWebViewClient(
                object : BridgeWebViewClient(b) {
                    override fun onPageFinished(view: WebView, url: String?) {
                        super.onPageFinished(view, url)
                        labAuto?.let {
                            labAuto = null
                            view.evaluateJavascript(it, null)
                        }
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val res = super.shouldInterceptRequest(view, request) ?: return null
                        val add = IsolationRules.headersFor(request.url.scheme, request.url.host, b.scheme, b.host)
                        if (add.isNotEmpty()) res.responseHeaders = IsolationRules.merge(res.responseHeaders, add)
                        return res
                    }
                },
            )
        }
        takeLabAuto(intent)
        speechCheck(intent)
        // The back button walks back through the app's screens (they are web history), then leaves.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val web = bridge?.webView
                    when (BackRule.step(web?.canGoBack() == true)) {
                        BackRule.Step.WEB_BACK -> web?.goBack()
                        BackRule.Step.LEAVE -> moveTaskToBack(true)
                    }
                }
            },
        )
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLabAuto(intent)
        speechCheck(intent)
        labAuto?.let { js ->
            labAuto = null
            bridge?.webView?.evaluateJavascript(js, null)
        }
    }

    /**
     * Debug builds only: `adb shell am start -n com.forgereserve.ai/.MainActivity -e forge.labAuto
     * native:10` opens the voice lab and runs those candidates on that many lines; the results go to
     * the app's files (files/voice-lab/), where `adb shell run-as com.forgereserve.ai` reads them. A
     * release build ignores the extra.
     */
    private var labAuto: String? = null

    private fun takeLabAuto(intent: Intent?) {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
        labAuto = LabAuto.script(intent?.getStringExtra("forge.labAuto")) ?: return
    }

    /**
     * Debug builds only: `adb shell am start -n com.forgereserve.ai/.MainActivity -e forge.speechCheck
     * en-US` runs ForgeSpeech's availability check for that language and logs it (`adb logcat -s
     * ForgeSpeech`), without the page and without listening. A release build ignores the extra.
     */
    private fun speechCheck(intent: Intent?) {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
        val locale = intent?.getStringExtra("forge.speechCheck") ?: return
        SpeechCheck.run(this, Handler(Looper.getMainLooper()), locale) {}
    }
}
