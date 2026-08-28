package jp.lab.studentcardreader.pasori

import android.media.AudioAttributes
import android.media.MediaPlayer
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import jp.lab.studentcardreader.BuildConfig

class PasoriConfigModule(
    reactContext: ReactApplicationContext,
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
}
