package com.asanoha.nohapay.alerts

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Sees notifications only from the apps the merchant ticked, and passes on those that look like
 * money coming in. Everything else is ignored and never leaves the phone.
 */
class AlertListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val store = Store(this)
        if (store.pairing == null || sbn.packageName !in store.watched) return
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val body = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        val text = "$title\n$body".trim()
        if (!Filter.looksLikeCredit(text)) return
        // Apps often post the same notification again when they update it.
        synchronized(recent) {
            if (!recent.add(text)) return
            if (recent.size > 50) recent.remove(recent.first())
        }
        store.enqueue(text.take(2000), sbn.postTime)
        Thread {
            if (!Sender.flush(this)) RetryJob.schedule(this)
        }.start()
    }

    companion object {
        private val recent = LinkedHashSet<String>()
    }
}
