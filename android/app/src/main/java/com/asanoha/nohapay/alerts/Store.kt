package com.asanoha.nohapay.alerts

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/** Pairing details, the apps to watch, and alerts waiting to be sent. Kept in app-private storage. */
class Store(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("noha_pay", Context.MODE_PRIVATE)

    data class Pairing(val server: String, val deviceId: String, val secret: String)

    var pairing: Pairing?
        get() {
            val server = prefs.getString("server", null) ?: return null
            val id = prefs.getString("device", null) ?: return null
            val secret = prefs.getString("secret", null) ?: return null
            return Pairing(server, id, secret)
        }
        set(value) {
            prefs.edit().apply {
                if (value == null) {
                    remove("server"); remove("device"); remove("secret"); remove("merchant"); remove("queue")
                } else {
                    putString("server", value.server); putString("device", value.deviceId); putString("secret", value.secret)
                }
            }.apply()
        }

    var merchantName: String?
        get() = prefs.getString("merchant", null)
        set(value) = prefs.edit().putString("merchant", value).apply()

    var lastSent: Long
        get() = prefs.getLong("last_sent", 0)
        set(value) = prefs.edit().putLong("last_sent", value).apply()

    var watched: Set<String>
        get() = prefs.getStringSet("watched", emptySet())!!.toSet()
        set(value) = prefs.edit().putStringSet("watched", value).apply()

    // Every caller makes its own Store, so the queue is guarded by one lock shared by all of them.
    fun enqueue(text: String, postedAt: Long) = synchronized(LOCK) {
        val queue = queue()
        queue.put(JSONObject().put("text", text).put("posted_at", postedAt))
        // Keep the newest 200 if the phone is offline for a long time.
        val trimmed = JSONArray()
        for (i in maxOf(0, queue.length() - 200) until queue.length()) trimmed.put(queue.get(i))
        prefs.edit().putString("queue", trimmed.toString()).commit()
    }

    fun queue(): JSONArray = synchronized(LOCK) { JSONArray(prefs.getString("queue", "[]")) }

    /** Removes the first [count] alerts after they were sent. */
    fun drop(count: Int) = synchronized(LOCK) {
        val queue = queue()
        val rest = JSONArray()
        for (i in count until queue.length()) rest.put(queue.get(i))
        prefs.edit().putString("queue", rest.toString()).commit()
    }

    companion object {
        private val LOCK = Any()

        /** Reads "nohapay://pair?server=...&device=...&secret=...". Null if anything is missing or unsafe. */
        fun parsePairing(code: String): Pairing? {
            val uri = runCatching { Uri.parse(code.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "nohapay" || uri.host != "pair") return null
            val server = uri.getQueryParameter("server")?.trimEnd('/') ?: return null
            val device = uri.getQueryParameter("device") ?: return null
            val secret = uri.getQueryParameter("secret") ?: return null
            val serverUri = Uri.parse(server)
            val local = serverUri.host in setOf("10.0.2.2", "localhost")
            if (serverUri.scheme != "https" && !(serverUri.scheme == "http" && local)) return null
            if (!device.matches(Regex("dev_[a-z0-9]{20}")) || secret.length < 32) return null
            return Pairing(server, device, secret)
        }
    }
}
