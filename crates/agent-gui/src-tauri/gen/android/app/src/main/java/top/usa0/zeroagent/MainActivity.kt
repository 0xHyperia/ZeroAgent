package top.usa0.zeroagent

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  @Volatile
  private var safeAreaInsetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  private inner class AndroidSafeAreaBridge {
    @JavascriptInterface
    fun getSafeAreaInsets(): String = safeAreaInsetsJson
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.addJavascriptInterface(AndroidSafeAreaBridge(), "__ZEROAGENT_ANDROID__")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      val insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val density = resources.displayMetrics.density.coerceAtLeast(1f)
      val top = (insets.top / density).roundToInt()
      val right = (insets.right / density).roundToInt()
      val bottom = (insets.bottom / density).roundToInt()
      val left = (insets.left / density).roundToInt()
      safeAreaInsetsJson = "{\"top\":$top,\"right\":$right,\"bottom\":$bottom,\"left\":$left}"
      webView.post {
        webView.evaluateJavascript(
          """
          (() => {
            const detail = { top: $top, right: $right, bottom: $bottom, left: $left };
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
