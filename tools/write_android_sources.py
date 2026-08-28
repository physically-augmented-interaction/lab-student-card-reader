from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"


def write(rel: str, content: str) -> None:
    path = APP / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print("wrote", path.relative_to(ROOT), path.stat().st_size)


PASORI = r'''package jp.lab.studentcardreader.pasori

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbManager
import java.nio.ByteBuffer
import java.nio.ByteOrder

class PasoriS380Client(
    private val usbManager: UsbManager,
) {
    data class CardRead(
        val idm: String,
        val studentId: String,
        val rawHex: String,
        val systemCode: String,
        val serviceCode: String,
    )

    class ReaderException(message: String) : Exception(message)

    private var connection: UsbDeviceConnection? = null
    private var inEndpoint: UsbEndpoint? = null
    private var outEndpoint: UsbEndpoint? = null

    @Volatile
    var initialized = false
        private set

    fun open(device: UsbDevice) {
        close()
        val usbInterface = device.getInterface(0)
        val opened = usbManager.openDevice(device) ?: throw ReaderException("USB open failed")
        if (!opened.claimInterface(usbInterface, true)) {
            opened.close()
            throw ReaderException("USB claimInterface failed")
        }
        var foundIn: UsbEndpoint? = null
        var foundOut: UsbEndpoint? = null
        for (index in 0 until usbInterface.endpointCount) {
            val endpoint = usbInterface.getEndpoint(index)
            if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
            if (endpoint.direction == UsbConstants.USB_DIR_IN) foundIn = endpoint
            if (endpoint.direction == UsbConstants.USB_DIR_OUT) foundOut = endpoint
        }
        if (foundIn == null || foundOut == null) {
            opened.releaseInterface(usbInterface)
            opened.close()
            throw ReaderException("USB bulk endpoints not found")
        }
        connection = opened
        inEndpoint = foundIn
        outEndpoint = foundOut
        initializeChipset()
        initialized = true
    }

    fun close() {
        initialized = false
        try {
            if (connection != null) {
                runCatching { sendCommand(CMD_SWITCH_RF, byteArrayOf(0x00)) }
                runCatching { sendRaw(ACK) }
            }
        } finally {
            connection?.close()
            connection = null
            inEndpoint = null
            outEndpoint = null
        }
    }

    fun pollCard(): CardRead? {
        if (!initialized) throw ReaderException("reader is not initialized")
        prepareTypeF()
        val polling = inCommRf(felicaPolling(SYSTEM_CODE), timeoutMs = 110) ?: return null
        if (polling.size < 18 || (polling[0].toInt() and 0xFF) < 18 || polling[1] != 0x01.toByte()) {
            return null
        }
        val idm = polling.copyOfRange(2, 10)
        val read = inCommRf(felicaReadWithoutEncryption(idm, SERVICE_CODE, 0), timeoutMs = 110)
            ?: return null
        val block = parseReadWithoutEncryption(read) ?: return null
        val studentId = extractStudentId(block) ?: return null
        return CardRead(
            idm = hex(idm),
            studentId = studentId,
            rawHex = hex(block),
            systemCode = "%04X".format(SYSTEM_CODE),
            serviceCode = "%04X".format(SERVICE_CODE),
        )
    }

    private fun initializeChipset() {
        sendRaw(ACK)
        drainInput()
        sendCommand(CMD_SET_COMMAND_TYPE, byteArrayOf(0x01))
        sendCommand(CMD_SWITCH_RF, byteArrayOf(0x00))
        sendCommand(CMD_SWITCH_RF, byteArrayOf(0x00))
    }

    private fun prepareTypeF() {
        sendCommand(CMD_IN_SET_RF, byteArrayOf(0x01, 0x01, 0x0F, 0x01))
        sendCommand(CMD_IN_SET_PROTOCOL, IN_SET_PROTOCOL_DEFAULTS)
        sendCommand(CMD_IN_SET_PROTOCOL, byteArrayOf(0x00, 0x18))
    }

    private fun inCommRf(data: ByteArray, timeoutMs: Int): ByteArray? {
        val timeout = ((timeoutMs + 1) * 10).coerceAtMost(0xFFFF)
        val payload = ByteBuffer.allocate(2 + data.size)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putShort(timeout.toShort())
            .put(data)
            .array()
        val response = sendCommand(CMD_IN_COMM_RF, payload)
        if (response.size < 5) return null
        val status = ByteBuffer.wrap(response, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
        if (status != 0) return null
        return response.copyOfRange(5, response.size)
    }

    private fun sendCommand(commandCode: Int, data: ByteArray): ByteArray {
        val command = ByteArray(2 + data.size)
        command[0] = 0xD6.toByte()
        command[1] = commandCode.toByte()
        System.arraycopy(data, 0, command, 2, data.size)
        sendRaw(buildFrame(command))
        val ack = receiveRaw(ACK.size)
        if (!ack.contentEquals(ACK)) {
            throw ReaderException("expected ACK, got " + hex(ack))
        }
        val raw = receiveRaw(MAX_PACKET)
        val payload = extractPayload(raw)
        if (payload.size < 2 || payload[0] != 0xD7.toByte() || payload[1] != (commandCode + 1).toByte()) {
            throw ReaderException("unexpected response " + hex(payload))
        }
        return payload.copyOfRange(2, payload.size)
    }

    private fun sendRaw(data: ByteArray) {
        val conn = connection ?: throw ReaderException("USB connection closed")
        val endpoint = outEndpoint ?: throw ReaderException("USB OUT endpoint missing")
        val written = conn.bulkTransfer(endpoint, data, data.size, TRANSFER_TIMEOUT_MS)
        if (written != data.size) {
            throw ReaderException("USB write failed: " + written + " / " + data.size)
        }
    }

    private fun receiveRaw(maxLength: Int): ByteArray {
        val conn = connection ?: throw ReaderException("USB connection closed")
        val endpoint = inEndpoint ?: throw ReaderException("USB IN endpoint missing")
        val buffer = ByteArray(maxLength)
        val read = conn.bulkTransfer(endpoint, buffer, buffer.size, TRANSFER_TIMEOUT_MS)
        if (read <= 0) {
            throw ReaderException("USB read timeout")
        }
        return buffer.copyOf(read)
    }

    private fun drainInput() {
        val conn = connection ?: return
        val endpoint = inEndpoint ?: return
        val buffer = ByteArray(64)
        while (conn.bulkTransfer(endpoint, buffer, buffer.size, 20) > 0) {
            // leftover frames from the previous session
        }
    }

    companion object {
        const val VENDOR_ID = 0x054C
        val PRODUCT_IDS = intArrayOf(0x06C1, 0x06C3)
        const val SYSTEM_CODE = 0x8277
        const val SERVICE_CODE = 0x010B

        private const val CMD_IN_SET_RF = 0x00
        private const val CMD_IN_SET_PROTOCOL = 0x02
        private const val CMD_IN_COMM_RF = 0x04
        private const val CMD_SWITCH_RF = 0x06
        private const val CMD_SET_COMMAND_TYPE = 0x2A
        private const val TRANSFER_TIMEOUT_MS = 250
        private const val MAX_PACKET = 290

        private val ACK = byteArrayOf(0x00, 0x00, 0xFF.toByte(), 0x00, 0xFF.toByte(), 0x00)
        private val IN_SET_PROTOCOL_DEFAULTS = byteArrayOf(
            0x00, 0x18, 0x01, 0x01, 0x02, 0x01, 0x03, 0x00, 0x04, 0x00,
            0x05, 0x00, 0x06, 0x00, 0x07, 0x08, 0x08, 0x00, 0x09, 0x00,
            0x0A, 0x00, 0x0B, 0x00, 0x0C, 0x00, 0x0E, 0x04, 0x0F, 0x00,
            0x10, 0x00, 0x11, 0x00, 0x12, 0x00, 0x13, 0x06,
        )

        fun isSupported(device: UsbDevice): Boolean {
            return device.vendorId == VENDOR_ID && device.productId in PRODUCT_IDS
        }

        fun extractStudentId(block: ByteArray): String? {
            if (block.size < 10) return null
            val ascii = block.decodeToString()
            val studentId = ascii.substring(3, 10)
            if (!studentId.matches(Regex("[A-Z0-9]{7}"))) return null
            return studentId
        }

        fun hex(data: ByteArray): String {
            return data.joinToString("") { "%02X".format(it.toInt() and 0xFF) }
        }

        private fun checksum(data: ByteArray): Byte {
            var sum = 0
            for (value in data) {
                sum += value.toInt() and 0xFF
            }
            return ((0x100 - (sum and 0xFF)) and 0xFF).toByte()
        }

        private fun buildFrame(command: ByteArray): ByteArray {
            val length = command.size
            val lengthBytes = byteArrayOf((length and 0xFF).toByte(), ((length shr 8) and 0xFF).toByte())
            val frame = ByteArray(8 + length + 2)
            frame[0] = 0x00
            frame[1] = 0x00
            frame[2] = 0xFF.toByte()
            frame[3] = 0xFF.toByte()
            frame[4] = 0xFF.toByte()
            frame[5] = lengthBytes[0]
            frame[6] = lengthBytes[1]
            frame[7] = checksum(lengthBytes)
            System.arraycopy(command, 0, frame, 8, length)
            frame[8 + length] = checksum(command)
            frame[9 + length] = 0x00
            return frame
        }

        private fun extractPayload(frame: ByteArray): ByteArray {
            if (frame.size < 10 || frame[0] != 0x00.toByte() || frame[1] != 0x00.toByte() || frame[2] != 0xFF.toByte()) {
                throw ReaderException("invalid frame header " + hex(frame))
            }
            if (frame[3] != 0xFF.toByte() || frame[4] != 0xFF.toByte()) {
                throw ReaderException("invalid extended frame " + hex(frame))
            }
            val length = (frame[5].toInt() and 0xFF) or ((frame[6].toInt() and 0xFF) shl 8)
            if (frame.size < 8 + length) {
                throw ReaderException("short frame " + hex(frame))
            }
            return frame.copyOfRange(8, 8 + length)
        }

        private fun felicaPolling(systemCode: Int): ByteArray {
            return byteArrayOf(
                0x06,
                0x00,
                ((systemCode shr 8) and 0xFF).toByte(),
                (systemCode and 0xFF).toByte(),
                0x01,
                0x00,
            )
        }

        private fun felicaReadWithoutEncryption(idm: ByteArray, serviceCode: Int, blockNumber: Int): ByteArray {
            val command = ByteArray(1 + 8 + 1 + 2 + 1 + 2)
            command[0] = 0x06
            System.arraycopy(idm, 0, command, 1, 8)
            command[9] = 0x01
            command[10] = (serviceCode and 0xFF).toByte()
            command[11] = ((serviceCode shr 8) and 0xFF).toByte()
            command[12] = 0x01
            command[13] = 0x80.toByte()
            command[14] = blockNumber.toByte()
            return command
        }

        private fun parseReadWithoutEncryption(response: ByteArray): ByteArray? {
            if (response.size < 13) return null
            val length = response[0].toInt() and 0xFF
            if (length > response.size || response[1] != 0x07.toByte()) return null
            if (response[10] != 0x00.toByte() || response[11] != 0x00.toByte()) return null
            val blockCount = response[12].toInt() and 0xFF
            val start = 13
            val end = start + (blockCount * 16)
            if (response.size < end) return null
            return response.copyOfRange(start, start + 16)
        }
    }
}
'''


MODULE = r'''package jp.lab.studentcardreader.pasori

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
'''


PACKAGE = r'''package jp.lab.studentcardreader.pasori

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class PasoriPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(PasoriModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
'''


NATIVE_TS = r'''import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type ReaderStatus =
  | 'attached'
  | 'detached'
  | 'permission-required'
  | 'permission-denied'
  | 'stopped'
  | 'error';

export type CardEvent = {
  idm: string;
  studentId: string;
  rawHex: string;
  systemCode: string;
  serviceCode: string;
  timestamp: number;
};

export type ReaderEvent = {
  status: ReaderStatus;
  message: string;
  timestamp: number;
};

type PasoriNative = {
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const native = NativeModules.PasoriModule as PasoriNative | undefined;
const emitter = native ? new NativeEventEmitter(native as never) : null;

export const Pasori = {
  isAvailable(): boolean {
    return Platform.OS === 'android' && native != null;
  },

  start(): Promise<boolean> {
    if (!native) {
      return Promise.reject(new Error('PasoriModule is only available on Android'));
    }
    return native.start();
  },

  stop(): Promise<boolean> {
    if (!native) {
      return Promise.resolve(false);
    }
    return native.stop();
  },

  onCard(listener: (event: CardEvent) => void) {
    if (!emitter) {
      return { remove() {} };
    }
    return emitter.addListener('onCard', listener);
  },

  onReader(listener: (event: ReaderEvent) => void) {
    if (!emitter) {
      return { remove() {} };
    }
    return emitter.addListener('onReader', listener);
  },
};
'''


APP_TSX = r'''import { useEffect, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Pasori, type CardEvent, type ReaderEvent } from './src/native/Pasori';

function statusLabel(event: ReaderEvent | null): string {
  if (!Pasori.isAvailable()) {
    return 'Android USB Host 専用です';
  }
  if (!event) {
    return 'リーダーを待っています';
  }
  switch (event.status) {
    case 'attached':
      return 'RC-S380 接続済み。学生証をタッチしてください';
    case 'detached':
      return 'RC-S380 が未接続です';
    case 'permission-required':
      return 'USB 権限を許可してください';
    case 'permission-denied':
      return 'USB 権限が拒否されました';
    case 'error':
      return event.message;
    case 'stopped':
      return '読み取りを停止しました';
    default:
      return event.message;
  }
}

function App() {
  const [reader, setReader] = useState<ReaderEvent | null>(null);
  const [card, setCard] = useState<CardEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cardSub = Pasori.onCard(event => {
      setCard(event);
      setError(null);
    });
    const readerSub = Pasori.onReader(event => {
      setReader(event);
      if (event.status === 'error' || event.status === 'permission-denied') {
        setError(event.message);
      }
    });
    Pasori.start().catch(err => {
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cardSub.remove();
      readerSub.remove();
      Pasori.stop().catch(() => {});
    };
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.container}>
          <Text style={styles.kicker}>Lab Student Card Reader</Text>
          <Text style={styles.status}>{statusLabel(reader)}</Text>
          <View style={styles.cardBox}>
            <Text style={styles.cardLabel}>学籍番号</Text>
            <Text style={styles.studentId}>{card?.studentId ?? '--------'}</Text>
            <Text style={styles.meta}>IDm {card?.idm ?? '-'}</Text>
            <Text style={styles.meta}>
              {card ? card.systemCode + ' / ' + card.serviceCode : '8277 / 010B'}
            </Text>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            style={styles.button}
            onPress={() => {
              setError(null);
              Pasori.start().catch(err => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }}>
            <Text style={styles.buttonText}>再接続</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#101418',
  },
  container: {
    flex: 1,
    paddingHorizontal: 32,
    paddingVertical: 24,
    justifyContent: 'center',
    gap: 18,
  },
  kicker: {
    color: '#8BE9B0',
    fontSize: 18,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  status: {
    color: '#F4F7F5',
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '600',
  },
  cardBox: {
    backgroundColor: '#1B2420',
    borderRadius: 24,
    padding: 28,
    gap: 8,
  },
  cardLabel: {
    color: '#9BB0A4',
    fontSize: 18,
  },
  studentId: {
    color: '#FFFFFF',
    fontSize: 64,
    fontWeight: '700',
    letterSpacing: 2,
  },
  meta: {
    color: '#9BB0A4',
    fontSize: 16,
  },
  error: {
    color: '#FF8A80',
    fontSize: 16,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: '#2F6F4E',
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
});

export default App;
'''


TEST = r'''import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders waiting screen', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
'''


def main() -> None:
    write(
        "android/app/src/main/java/jp/lab/studentcardreader/pasori/PasoriS380Client.kt",
        PASORI,
    )
    write(
        "android/app/src/main/java/jp/lab/studentcardreader/pasori/PasoriModule.kt",
        MODULE,
    )
    write(
        "android/app/src/main/java/jp/lab/studentcardreader/pasori/PasoriPackage.kt",
        PACKAGE,
    )
    write("src/native/Pasori.ts", NATIVE_TS)
    write("App.tsx", APP_TSX)
    write("__tests__/App.test.tsx", TEST)


if __name__ == "__main__":
    main()
