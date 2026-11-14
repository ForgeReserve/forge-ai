package com.forgereserve.ai

import android.os.Bundle
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
        super.onCreate(savedInstanceState)
        // The app's own files are served cross-origin isolated, as the website serves /v2/, so the natural
        // voice can run on several threads (IsolationRules).
        bridge?.let { b ->
            b.setWebViewClient(
                object : BridgeWebViewClient(b) {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val res = super.shouldInterceptRequest(view, request) ?: return null
                        val add = IsolationRules.headersFor(request.url.scheme, request.url.host, b.scheme, b.host)
                        if (add.isNotEmpty()) res.responseHeaders = IsolationRules.merge(res.responseHeaders, add)
                        return res
                    }
                },
            )
        }
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
}
