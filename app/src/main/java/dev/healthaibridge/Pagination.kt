package dev.healthaibridge

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

data class RecordPage<T>(val records: List<T>, val nextToken: String?)
data class PageRead<T>(val records: List<T>, val pages: Int, val error: Exception?)

// Fail visibly while retaining successful pages, including errors on a later page.
// Null AND empty terminal tokens occur across Health Connect provider versions.
suspend fun <T> readAllPages(fetch: suspend (String?) -> RecordPage<T>): PageRead<T> {
    val records = mutableListOf<T>()
    val seenTokens = mutableSetOf<String>()
    var token: String? = null
    var pages = 0
    return try {
        do {
            currentCoroutineContext().ensureActive()
            val response = fetch(token)
            records.addAll(response.records)
            pages++
            token = response.nextToken?.takeIf { it.isNotEmpty() }
            check(token == null || seenTokens.add(token)) { "Health Connect 重复返回分页 token，请稍后重试" }
        } while (token != null)
        PageRead(records.toList(), pages, null)
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: Exception) { PageRead(records.toList(), pages, error) }
}
