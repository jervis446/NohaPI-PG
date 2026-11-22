package com.asanoha.nohapay.alerts

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context

/** Tries again once the phone is online, if an alert couldn't be sent straight away. */
class RetryJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            val done = Sender.flush(this)
            jobFinished(params, !done)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true

    companion object {
        private const val ID = 4127

        fun schedule(context: Context) {
            val job = JobInfo.Builder(ID, ComponentName(context, RetryJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build()
            context.getSystemService(JobScheduler::class.java).schedule(job)
        }
    }
}
