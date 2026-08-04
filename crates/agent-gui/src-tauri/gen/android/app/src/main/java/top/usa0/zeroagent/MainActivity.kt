package top.usa0.zeroagent

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private val oauthCallbackFile: File by lazy { File(filesDir, "pending-mobile-oauth-callback") }

  @Volatile
  private var safeAreaInsetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  private inner class AndroidSafeAreaBridge {
    @JavascriptInterface
    fun getSafeAreaInsets(): String = safeAreaInsetsJson

    @JavascriptInterface
    fun moveTaskToBack() {
      runOnUiThread { this@MainActivity.moveTaskToBack(true) }
    }

    @JavascriptInterface
    fun getPendingOAuthCallback(): String? = readPendingOAuthCallback()

    @JavascriptInterface
    fun acknowledgeOAuthCallback(url: String) {
      if (readPendingOAuthCallback() == url) oauthCallbackFile.delete()
    }
  }

  private fun isOAuthCallback(intent: android.content.Intent?): Boolean {
    val uri = intent?.data ?: return false
    return uri.scheme == "top.usa0.zeroagent" && uri.host == null && uri.path == "/oauth/callback"
  }

  private fun persistOAuthCallback(intent: android.content.Intent?) {
    if (!isOAuthCallback(intent)) return
    runCatching { oauthCallbackFile.writeText(intent?.data.toString(), Charsets.UTF_8) }
  }

  private fun readPendingOAuthCallback(): String? = runCatching {
    val value = oauthCallbackFile.takeIf(File::isFile)?.readText(Charsets.UTF_8)?.trim()
    val uri = value?.let(android.net.Uri::parse)
    if (
      uri?.scheme == "top.usa0.zeroagent" &&
        uri.host == null &&
        uri.path == "/oauth/callback"
    ) value else null
  }.getOrNull()

  override fun onCreate(savedInstanceState: Bundle?) {
    persistOAuthCallback(intent)
    enableEdgeToEdge()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val webView = appWebView
          if (webView == null) {
            moveTaskToBack(true)
            return
          }
          webView.evaluateJavascript(
            "window.dispatchEvent(new Event('zeroagent:native-back', { cancelable: true }))",
          ) { unhandled ->
            if (unhandled == "true") moveTaskToBack(true)
          }
        }
      },
    )
  }

  override fun onNewIntent(intent: android.content.Intent) {
    persistOAuthCallback(intent)
    super.onNewIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.addJavascriptInterface(AndroidSafeAreaBridge(), "__ZEROAGENT_ANDROID__")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      val insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      val imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
      val density = resources.displayMetrics.density.coerceAtLeast(1f)
      val top = (insets.top / density).roundToInt()
      val right = (insets.right / density).roundToInt()
      val bottom = (insets.bottom / density).roundToInt()
      val left = (insets.left / density).roundToInt()
      val imeBottom = (imeInsets.bottom / density).roundToInt()
      safeAreaInsetsJson =
        "{\"top\":$top,\"right\":$right,\"bottom\":$bottom,\"left\":$left," +
          "\"imeBottom\":$imeBottom,\"imeVisible\":$imeVisible}"
      webView.post {
        webView.evaluateJavascript(
          """
          (() => {
            const detail = {
              top: $top,
              right: $right,
              bottom: $bottom,
              left: $left,
              imeBottom: $imeBottom,
              imeVisible: $imeVisible,
            };
            window.__ZEROAGENT_NATIVE_INSETS__ = detail;
            window.dispatchEvent(new CustomEvent("zeroagent:native-insets", { detail }));
          })();
          """.trimIndent(),
          null,
        )
      }
      windowInsets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) appWebView?.let(ViewCompat::requestApplyInsets)
  }
}
