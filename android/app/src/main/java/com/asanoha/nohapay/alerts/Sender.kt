package com.asanoha.nohapay.alerts

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Sends queued alerts to the Noha Pay server, signed with this phone's secret. */
object Sender {
    class Problem(message: String) : Exception(message)

    private fun sign(secret: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
        return mac.doFinal(message.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    /** POSTs [body] to [path]; returns the response body or throws [Problem]. */
    fun post(pairing: Store.Pairing, path: String, body: String): String {
        val ts = (System.currentTimeMillis() / 1000).toString()
        val conn = URL(pairing.server + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.doOutput = true
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Noha-Device", pairing.deviceId)
            conn.setRequestProperty("Noha-Timestamp", ts)
            conn.setRequestProperty("Noha-Signature", sign(pairing.secret, "$ts.$body"))
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val message = runCatching { JSONObject(text).getJSONObject("error").getString("message") }.getOrDefault("HTTP $code")
                throw Problem(message)
            }
            return text
        } finally {
            conn.disconnect()
        }
    }

    /** Sends everything queued, 20 at a time. Returns true when the queue is empty. */
    @Synchronized
    fun flush(context: Context): Boolean {
        val store = Store(context)
        val pairing = store.pairing ?: return true
        while (true) {
            val queue = store.queue()
            if (queue.length() == 0) return true
            val batch = JSONArray()
            for (i in 0 until minOf(20, queue.length())) batch.put(queue.get(i))
            try {
                post(pairing, "/v1/device/alerts", JSONObject().put("alerts", batch).toString())
            } catch (e: Exception) {
                return false
            }
            store.drop(batch.length())
            store.lastSent = System.currentTimeMillis()
        }
    }
}
