package jp.lab.studentcardreader.pasori

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
            val command = ByteArray(16)
            command[0] = 0x10
            command[1] = 0x06
            System.arraycopy(idm, 0, command, 2, 8)
            command[10] = 0x01
            command[11] = (serviceCode and 0xFF).toByte()
            command[12] = ((serviceCode shr 8) and 0xFF).toByte()
            command[13] = 0x01
            command[14] = 0x80.toByte()
            command[15] = blockNumber.toByte()
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
