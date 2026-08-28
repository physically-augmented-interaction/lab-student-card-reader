package jp.lab.studentcardreader.pasori

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class PasoriModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    private val usbManager = reactContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private val client = PasoriS380Client(usbManager)
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val polling = AtomicBoolean(false)
    private var pollTask: ScheduledFuture<*>? = null
    private var lastStudentId: String? = null
    private var lastReadAt = 0L

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    val device = extraDevice(intent) ?: return
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) {
                        openDevice(device)
                    } else {
                        emitReader("permission-denied", "USB permission denied")
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    extraDevice(intent)?.let { requestOrOpen(it) }
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    extraDevice(intent)?.let { detached ->
                        if (PasoriS380Client.isSupported(detached)) {
                            stopPollingLocked()
                            client.close()
                            emitReader("detached", "RC-S380 disconnected")
                        }
                    }
                }
            }
        }
    }

    init {
        reactContext.addLifecycleEventListener(this)
        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            reactContext.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactContext.registerReceiver(usbReceiver, filter)
        }
    }

    override fun getName(): String = "PasoriModule"

    @ReactMethod
    fun start(promise: Promise) {
        executor.execute {
            try {
                val device = findDevice()
                if (device == null) {
                    emitReader("detached", "RC-S380 not connected")
                    promise.resolve(false)
                    return@execute
                }
                requestOrOpen(device)
                promise.resolve(true)
            } catch (error: Exception) {
                promise.reject("PASORI_START", error)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        executor.execute {
            stopPollingLocked()
            client.close()
            emitReader("stopped", "polling stopped")
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // NativeEventEmitter compatibility
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // NativeEventEmitter compatibility
    }

    override fun onHostResume() {}

    override fun onHostPause() {}

    override fun onHostDestroy() {
        stopPollingLocked()
        client.close()
        runCatching { reactContext.unregisterReceiver(usbReceiver) }
        executor.shutdownNow()
    }

    private fun findDevice(): UsbDevice? {
        return usbManager.deviceList.values.firstOrNull { PasoriS380Client.isSupported(it) }
    }

    private fun requestOrOpen(device: UsbDevice) {
        if (!PasoriS380Client.isSupported(device)) return
        if (usbManager.hasPermission(device)) {
            openDevice(device)
            return
        }
        val flags = if (Build.VERSION.SDK_INT >= 31) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
        val permissionIntent = PendingIntent.getBroadcast(
            reactContext,
            0,
            Intent(ACTION_USB_PERMISSION).setPackage(reactContext.packageName),
            flags,
        )
        usbManager.requestPermission(device, permissionIntent)
        emitReader("permission-required", "USB permission requested")
    }

    private fun openDevice(device: UsbDevice) {
        try {
            client.open(device)
            emitReader("attached", device.productName ?: "RC-S380")
            startPollingLocked()
        } catch (error: Exception) {
            emitReader("error", error.message ?: "USB open failed")
        }
    }

    private fun startPollingLocked() {
        if (!polling.compareAndSet(false, true)) return
        pollTask = executor.scheduleWithFixedDelay({
            if (!polling.get() || !client.initialized) return@scheduleWithFixedDelay
            try {
                val card = client.pollCard() ?: return@scheduleWithFixedDelay
                val now = System.currentTimeMillis()
                if (card.studentId == lastStudentId && now - lastReadAt < DEBOUNCE_MS) return@scheduleWithFixedDelay
                lastStudentId = card.studentId
                lastReadAt = now
                val payload = Arguments.createMap().apply {
                    putString("idm", card.idm)
                    putString("studentId", card.studentId)
                    putString("rawHex", card.rawHex)
                    putString("systemCode", card.systemCode)
                    putString("serviceCode", card.serviceCode)
                    putDouble("timestamp", now.toDouble())
                }
                sendEvent("onCard", payload)
            } catch (error: Exception) {
                emitReader("error", error.message ?: "poll failed")
            }
        }, 0, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun stopPollingLocked() {
        polling.set(false)
        pollTask?.cancel(true)
        pollTask = null
    }

    private fun emitReader(status: String, message: String) {
        val payload = Arguments.createMap().apply {
            putString("status", status)
            putString("message", message)
            putDouble("timestamp", System.currentTimeMillis().toDouble())
        }
        sendEvent("onReader", payload)
    }

    private fun sendEvent(name: String, payload: com.facebook.react.bridge.WritableMap) {
        if (!reactContext.hasActiveReactInstance()) return
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, payload)
    }

    private fun extraDevice(intent: Intent): UsbDevice? {
        return if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }
    }

    companion object {
        private const val ACTION_USB_PERMISSION = "jp.lab.studentcardreader.USB_PERMISSION"
        private const val POLL_INTERVAL_MS = 250L
        private const val DEBOUNCE_MS = 2500L
    }
}
