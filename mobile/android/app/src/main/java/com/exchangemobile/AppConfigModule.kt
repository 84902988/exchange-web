package com.exchangemobile

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.util.concurrent.atomic.AtomicBoolean

class AppConfigModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private val fullyDrawnReported = AtomicBoolean(false)

  override fun getName(): String = "AppConfig"

  override fun getConstants(): Map<String, Any> =
      mapOf(
          "API_BASE_URL" to BuildConfig.API_BASE_URL,
          "CHART_WEB_BASE_URL" to BuildConfig.CHART_WEB_BASE_URL,
          "BUILD_TYPE" to BuildConfig.BUILD_TYPE,
      )

  @ReactMethod
  fun reportFullyDrawn() {
    if (!fullyDrawnReported.compareAndSet(false, true)) return
    UiThreadUtil.runOnUiThread {
      reactApplicationContext.currentActivity?.reportFullyDrawn()
    }
  }

  @ReactMethod
  fun logBenchmarkChartPerf(payload: String) {
    if (BuildConfig.BUILD_TYPE != "benchmark") return
    if (payload.isBlank() || payload.length > 4096 || payload.contains('\n') || payload.contains('\r')) return
    Log.i("AdvancedChartPerf", payload)
  }
}
