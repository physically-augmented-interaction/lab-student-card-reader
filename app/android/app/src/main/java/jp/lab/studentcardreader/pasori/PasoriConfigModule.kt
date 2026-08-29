package jp.lab.studentcardreader.pasori

import android.media.AudioAttributes
import android.media.MediaPlayer
import java.util.concurrent.atomic.AtomicBoolean
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import jp.lab.studentcardreader.BuildConfig
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode

class PasoriConfigModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private var player: MediaPlayer? = null

    override fun getName(): String = "PasoriConfig"

    override fun getConstants(): MutableMap<String, Any> {
        return hashMapOf(
            "API_BASE_URL" to BuildConfig.API_BASE_URL,
            "API_KEY" to BuildConfig.API_KEY,
            "DEVICE_ID" to BuildConfig.DEVICE_ID,
        )
    }

    @ReactMethod
    fun playSound(url: String, promise: Promise) {
        try {
            player?.release()
            val mediaPlayer = MediaPlayer()
            mediaPlayer.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            mediaPlayer.setDataSource(url)
            mediaPlayer.setOnPreparedListener { it.start() }
            mediaPlayer.setOnCompletionListener {
                it.release()
                if (player === it) player = null
            }
            mediaPlayer.prepareAsync()
            player = mediaPlayer
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("SOUND", error)
        }
    }

    @ReactMethod
    fun scanQr(promise: Promise) {
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("QR", "画面が表示されていないためカメラを開けません")
            return
        }

        val settled = AtomicBoolean(false)
        fun resolveValue(value: String) {
            if (settled.compareAndSet(false, true)) promise.resolve(value)
        }
        fun rejectValue(code: String, message: String, error: Throwable? = null) {
            if (!settled.compareAndSet(false, true)) return
            if (error != null) promise.reject(code, message, error) else promise.reject(code, message)
        }

        activity.runOnUiThread {
            try {
                val options = GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .enableAutoZoom()
                    .build()
                val scanner = GmsBarcodeScanning.getClient(activity, options)
                scanner.startScan()
                    .addOnSuccessListener { barcode ->
                        val value = barcode.rawValue
                        if (value.isNullOrBlank()) {
                            rejectValue("QR", "QR の内容が空です")
                        } else {
                            resolveValue(value)
                        }
                    }
                    .addOnCanceledListener { rejectValue("QR_CANCELLED", "cancelled") }
                    .addOnFailureListener { error ->
                        val detail = error.message ?: error.javaClass.simpleName
                        rejectValue("QR", "QR カメラを起動できません: " + detail, error)
                    }
            } catch (error: Exception) {
                val detail = error.message ?: error.javaClass.simpleName
                rejectValue("QR", "QR カメラを起動できません: " + detail, error)
            }
        }
    }
}
