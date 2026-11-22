package com.asanoha.nohapay.alerts

/**
 * A quick first check on the phone, so only likely credit alerts leave it. The server reads each
 * alert properly and decides; this only keeps chats, OTPs and debits on the phone.
 */
object Filter {
    private val credit = Regex("""\b(credited|received|deposited|has been added|cr\.?)\b""", RegexOption.IGNORE_CASE)
    private val money = Regex("""(rs\.?|inr|₹)\s*[0-9]""", RegexOption.IGNORE_CASE)
    private val skip = Regex("""\b(otp|one time password|verification code|debited|spent|withdrawn)\b""", RegexOption.IGNORE_CASE)

    fun looksLikeCredit(text: String): Boolean =
        text.length in 10..2000 && credit.containsMatchIn(text) && money.containsMatchIn(text) && !skip.containsMatchIn(text)
}
