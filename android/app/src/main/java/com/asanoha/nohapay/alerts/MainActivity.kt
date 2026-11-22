package com.asanoha.nohapay.alerts

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/** One screen: pair with the server, allow notification access, and choose which apps to watch. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var root: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(20)
            setPadding(pad, pad, pad, pad)
        }
        setContentView(ScrollView(this).apply { addView(root) })
        handlePairLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairLink(intent)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(20), 0, dp(6))
    }

    private fun para(text: String) = TextView(this).apply {
        this.text = text
        textSize = 15f
        setPadding(0, 0, 0, dp(8))
    }

    private fun button(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        setOnClickListener { onClick() }
    }

    private fun hasNotificationAccess(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val me = ComponentName(this, AlertListener::class.java).flattenToString()
        return enabled.split(":").any { it == me }
    }

    private fun render() {
        root.removeAllViews()
        root.addView(TextView(this).apply {
            text = getString(R.string.app_name)
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
        })
        root.addView(para("Sends your bank's credit alerts to Noha Pay, so customers' UPI payments are confirmed without you checking each one."))

        val pairing = store.pairing
        root.addView(heading("1. Pair with your dashboard"))
        if (pairing == null) {
            root.addView(para("In the Noha Pay dashboard, open Alert sources and tap Pair a phone. Scan the code with this phone's camera, or paste the text here."))
            val input = EditText(this).apply { hint = "nohapay://pair?..." ; setSingleLine(false) }
            root.addView(input)
            root.addView(button("Pair") { pair(input.text.toString()) })
        } else {
            val name = store.merchantName ?: "your shop"
            root.addView(para("Paired with $name at ${pairing.server}."))
            val last = store.lastSent
            root.addView(para(if (last > 0) "Last alert sent ${DateUtils.getRelativeTimeSpanString(last)}." else "No alerts sent yet."))
            val waiting = store.queue().length()
            if (waiting > 0) {
                root.addView(para("$waiting alert(s) waiting to send."))
                root.addView(button("Send now") { Thread { Sender.flush(this); runOnUiThread { render() } }.start() })
            }
            root.addView(button("Unpair this phone") {
                AlertDialog.Builder(this)
                    .setMessage("Unpair? This phone will stop sending alerts until you pair it again.")
                    .setPositiveButton("Unpair") { _, _ -> store.pairing = null; render() }
                    .setNegativeButton("Cancel", null)
                    .show()
            })
        }

        root.addView(heading("2. Allow notification access"))
        if (hasNotificationAccess()) {
            root.addView(para("Allowed. The app only looks at notifications from the apps you tick below."))
        } else {
            root.addView(para("Android asks you to allow this once. It lets the app see notifications from the apps you choose below, nothing else is sent."))
            root.addView(button("Open settings") { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) })
        }

        root.addView(heading("3. Choose apps to watch"))
        root.addView(para("Tick your bank's app and your SMS app. Only notifications from these, that look like money coming in, are sent."))
        val watched = store.watched.toMutableSet()
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.packageName to it.loadLabel(packageManager).toString() }
            .distinctBy { it.first }
            .filter { it.first != packageName }
            .sortedWith(compareBy({ it.first !in watched }, { it.second.lowercase() }))
        for ((pkg, label) in apps) {
            root.addView(CheckBox(this).apply {
                text = label
                isChecked = pkg in watched
                setOnCheckedChangeListener { _, checked ->
                    if (checked) watched.add(pkg) else watched.remove(pkg)
                    store.watched = watched
                }
            })
        }
        root.addView(View(this).apply { minimumHeight = dp(24) })
        root.addView(TextView(this).apply {
            text = "Noha Pay never sees your bank password, OTPs or balance. Alerts are signed with a key only this phone has."
            textSize = 13f
            gravity = Gravity.START
        })
    }

    private fun handlePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "nohapay") return
        val code = data.toString()
        AlertDialog.Builder(this)
            .setMessage("Pair this phone with the Noha Pay server at ${data.getQueryParameter("server")}?")
            .setPositiveButton("Pair") { _, _ -> pair(code) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun pair(code: String) {
        val p = Store.parsePairing(code)
        if (p == null) {
            AlertDialog.Builder(this).setMessage("That pairing code isn't right. Copy it again from the dashboard.").setPositiveButton("OK", null).show()
            return
        }
        Thread {
            val result = runCatching { JSONObject(Sender.post(p, "/v1/device/ping", "{}")) }
            runOnUiThread {
                result.onSuccess {
                    store.pairing = p
                    store.merchantName = it.optString("merchant")
                    render()
                }.onFailure {
                    AlertDialog.Builder(this).setMessage("Couldn't pair: ${it.message}").setPositiveButton("OK", null).show()
                }
            }
        }.start()
    }
}
