package com.forgereserve.ai

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity

/** The Forge app: the v2 web app from the APK's own files, in Capacitor's web view. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ShareInPlugin::class.java)
        registerPlugin(SharePlugin::class.java)
        super.onCreate(savedInstanceState)
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
