package dev.aero.ytmp3

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.card.MaterialCardView
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private enum class Status { WORKING, SUCCESS, WARNING, ERROR }

    private lateinit var input: EditText
    private lateinit var btnDownload: Button
    private lateinit var btnUpdate: Button
    private lateinit var progress: ProgressBar
    private lateinit var statusCard: MaterialCardView
    private lateinit var statusIcon: ImageView
    private lateinit var statusTitle: TextView
    private lateinit var statusSubtitle: TextView
    private lateinit var btnToggleDetails: Button
    private lateinit var detailsCard: View
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private var engineReady = false

    // Matches yt-dlp's per-item playlist marker, e.g. "Downloading item 3 of 105".
    private val itemRegex = Regex("""Downloading item (\d+) of (\d+)""")

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startDownload()
            else showStatus(Status.ERROR, "Permission needed",
                "Allow storage access so files can be saved.")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        input = findViewById(R.id.input)
        btnDownload = findViewById(R.id.btnDownload)
        btnUpdate = findViewById(R.id.btnUpdate)
        progress = findViewById(R.id.progress)
        statusCard = findViewById(R.id.statusCard)
        statusIcon = findViewById(R.id.statusIcon)
        statusTitle = findViewById(R.id.statusTitle)
        statusSubtitle = findViewById(R.id.statusSubtitle)
        btnToggleDetails = findViewById(R.id.btnToggleDetails)
        detailsCard = findViewById(R.id.detailsCard)
        logView = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)

        btnDownload.isEnabled = false
        btnUpdate.isEnabled = false
        btnDownload.setOnClickListener { ensurePermissionThenDownload() }
        btnUpdate.setOnClickListener { updateYtDlp() }
        btnToggleDetails.setOnClickListener { toggleDetails() }

        showStatus(Status.WORKING, "Getting ready…", "Setting up the downloader")
        log("Initializing download engine…")
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                YoutubeDL.getInstance().init(this@MainActivity)
                FFmpeg.getInstance().init(this@MainActivity)
            } catch (e: Exception) {
                Log.e("ytmp3", "init failed", e)
                withContext(Dispatchers.Main) {
                    log("Engine init failed: ${e.message}")
                    showStatus(Status.ERROR, "Couldn't start",
                        "The downloader failed to load. Reopen the app to retry.")
                    btnToggleDetails.visibility = View.VISIBLE
                }
                return@launch
            }
            // YouTube breaks old yt-dlp versions within weeks, so always try
            // to update to the latest stable on launch. Failure (e.g. offline)
            // is fine — we just run with the bundled version.
            withContext(Dispatchers.Main) { log("Checking for yt-dlp update…") }
            try {
                val status = YoutubeDL.getInstance().updateYoutubeDL(this@MainActivity)
                withContext(Dispatchers.Main) { log("yt-dlp update: $status") }
            } catch (e: Exception) {
                Log.w("ytmp3", "update failed", e)
                withContext(Dispatchers.Main) { log("yt-dlp update skipped: ${e.message}") }
            }
            engineReady = true
            withContext(Dispatchers.Main) {
                log("Engine ready.")
                statusCard.visibility = View.GONE
                btnDownload.isEnabled = true
                btnUpdate.isEnabled = true
                // CI test hook: launch with `-e test_url <url>` to auto-download.
                intent.getStringExtra("test_url")?.let {
                    input.setText(it)
                    ensurePermissionThenDownload()
                }
            }
        }
    }

    private fun ensurePermissionThenDownload() {
        // Android 11+ lets apps create files in public Download/ without any
        // permission; Android 10 and below need WRITE_EXTERNAL_STORAGE.
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
        ) {
            permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            return
        }
        startDownload()
    }

    private fun startDownload() {
        val urls = input.text.toString().lines().map { it.trim() }.filter { it.isNotEmpty() }
        if (urls.isEmpty()) {
            showStatus(Status.WARNING, "No links yet",
                "Paste a video or playlist link above, then tap Download.")
            return
        }
        val outDir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "yt-mp3",
        )
        outDir.mkdirs()

        setBusy(true)
        showStatus(Status.WORKING, "Starting…", "Preparing your download")
        log("Downloading ${urls.size} link(s) to ${outDir.absolutePath}")

        // Count only MP3s so playlists/thumbnails/temp files don't distort the tally.
        val before = mp3Paths(outDir)

        lifecycleScope.launch(Dispatchers.IO) {
            var failCount = 0
            var lastError: String? = null

            for ((linkIndex, url) in urls.withIndex()) {
                // Per-URL playlist position, reset for each link.
                var item = 0
                var itemTotal = 0
                try {
                    val request = YoutubeDLRequest(url).apply {
                        addOption("--extract-audio")
                        addOption("--audio-format", "mp3")
                        addOption("--audio-quality", "0")
                        addOption("--embed-thumbnail")
                        addOption("--embed-metadata")
                        addOption("--no-overwrites")
                        addOption("--windows-filenames")
                        // We run yt-dlp from a zip (not an official binary), so
                        // allow it to fetch the EJS challenge-solver scripts it
                        // needs for YouTube; without them most downloads 403.
                        addOption("--remote-components", "ejs:github")
                        addOption(
                            "-o",
                            outDir.absolutePath +
                                "/%(playlist_title|)s/%(playlist_index&{:02d} - |)s%(title)s.%(ext)s",
                        )
                    }
                    YoutubeDL.getInstance().execute(request) { pct, _, line ->
                        val trimmed = line.trim()
                        itemRegex.find(trimmed)?.let {
                            item = it.groupValues[1].toInt()
                            itemTotal = it.groupValues[2].toInt()
                        }
                        // Overall progress: spread each file's 0-100% across the
                        // playlist so the bar climbs smoothly to the end.
                        val overall = if (itemTotal > 0)
                            (((item - 1).coerceAtLeast(0) + pct / 100f) / itemTotal * 100f)
                        else pct
                        val linkLabel = if (urls.size > 1) "Link ${linkIndex + 1}/${urls.size} · " else ""
                        val fileLabel = if (itemTotal > 1) "File $item of $itemTotal" else "Downloading…"
                        val phase = friendlyPhase(trimmed, pct)
                        runOnUiThread {
                            progress.progress = overall.toInt().coerceIn(0, 100)
                            statusTitle.text = "$linkLabel$fileLabel"
                            if (phase != null) statusSubtitle.text = phase
                            log(trimmed)
                        }
                    }
                    withContext(Dispatchers.Main) { log("Finished: $url") }
                } catch (e: Exception) {
                    Log.e("ytmp3", "download failed", e)
                    failCount++
                    lastError = e.message
                    withContext(Dispatchers.Main) { log("FAILED: $url — ${e.message}") }
                }
            }

            val after = mp3Paths(outDir)
            val newFiles = (after - before).toList()
            if (newFiles.isNotEmpty()) {
                MediaScannerConnection.scanFile(this@MainActivity, newFiles.toTypedArray(), null, null)
            }

            withContext(Dispatchers.Main) {
                setBusy(false)
                reportOutcome(urls.size, failCount, newFiles.size, lastError)
            }
        }
    }

    private fun reportOutcome(total: Int, failCount: Int, newCount: Int, lastError: String?) {
        val saved = when (newCount) {
            0 -> "No new files"
            1 -> "1 MP3 saved to Downloads › yt-mp3"
            else -> "$newCount MP3s saved to Downloads › yt-mp3"
        }
        when {
            failCount == 0 ->
                showStatus(Status.SUCCESS, "Download complete", saved)
            failCount < total ->
                showStatus(Status.WARNING, "Finished with some errors",
                    "$saved · $failCount link${plural(failCount)} failed")
            else ->
                showStatus(Status.ERROR, "Download failed", friendlyReason(lastError))
        }
        log("All done. Files are in Download/yt-mp3.")
    }

    private fun updateYtDlp() {
        setBusy(true)
        showStatus(Status.WORKING, "Updating…", "Fetching the latest yt-dlp")
        log("Updating yt-dlp…")
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val status = YoutubeDL.getInstance().updateYoutubeDL(this@MainActivity)
                withContext(Dispatchers.Main) {
                    log("Update result: $status")
                    showStatus(Status.SUCCESS, "Up to date", "yt-dlp is ready to go.")
                }
            } catch (e: Exception) {
                Log.e("ytmp3", "update failed", e)
                withContext(Dispatchers.Main) {
                    log("Update failed: ${e.message}")
                    showStatus(Status.ERROR, "Update failed",
                        "Couldn't update right now — check your connection.")
                }
            }
            withContext(Dispatchers.Main) { setBusy(false) }
        }
    }

    /** Absolute paths of every MP3 currently under [dir]. */
    private fun mp3Paths(dir: File): Set<String> =
        dir.walkTopDown().filter { it.isFile && it.extension.equals("mp3", ignoreCase = true) }
            .map { it.absolutePath }.toSet()

    /** Maps a raw yt-dlp line to a short, non-technical phase, or null to ignore it. */
    private fun friendlyPhase(line: String, pct: Float): String? {
        val l = line.lowercase()
        return when {
            "[extractaudio]" in l -> "Converting to MP3…"
            "[embedthumbnail]" in l || "[metadata]" in l || "[thumbnailsconvertor]" in l ->
                "Adding cover art & tags…"
            "destination" in l -> "Fetching audio…"
            pct > 0f -> "Fetching audio… ${pct.toInt()}%"
            else -> null
        }
    }

    /** Turns a yt-dlp error into a one-line explanation an ordinary user can act on. */
    private fun friendlyReason(error: String?): String {
        val e = error?.lowercase() ?: ""
        return when {
            "not a bot" in e || "sign in to confirm" in e ->
                "YouTube blocked this download. Try again on Wi-Fi or mobile data."
            "403" in e || "unable to download" in e || "unable to connect" in e ->
                "Couldn't reach the video. Check your connection and try again."
            "unsupported url" in e || "is not a valid url" in e ->
                "That link isn't supported. Paste a video or playlist URL."
            "video unavailable" in e || "private" in e ->
                "That video is unavailable or private."
            else -> "Something went wrong. Tap Show details to see why."
        }
    }

    private fun plural(n: Int) = if (n == 1) "" else "s"

    private fun toggleDetails() {
        val show = detailsCard.visibility != View.VISIBLE
        detailsCard.visibility = if (show) View.VISIBLE else View.GONE
        btnToggleDetails.setText(if (show) R.string.hide_details else R.string.show_details)
    }

    private fun showStatus(state: Status, title: String, subtitle: String) {
        val bgRes: Int
        val fgRes: Int
        val iconRes: Int
        when (state) {
            Status.WORKING -> {
                bgRes = R.color.status_working_bg; fgRes = R.color.status_working_fg
                iconRes = R.drawable.ic_download
            }
            Status.SUCCESS -> {
                bgRes = R.color.status_success_bg; fgRes = R.color.status_success_fg
                iconRes = R.drawable.ic_check
            }
            Status.WARNING, Status.ERROR -> {
                bgRes = R.color.status_error_bg; fgRes = R.color.status_error_fg
                iconRes = R.drawable.ic_error
            }
        }
        val fg = ContextCompat.getColor(this, fgRes)
        statusCard.setCardBackgroundColor(ContextCompat.getColor(this, bgRes))
        statusIcon.setImageResource(iconRes)
        statusIcon.setColorFilter(fg)
        statusTitle.setTextColor(fg)
        statusSubtitle.setTextColor(fg)
        statusTitle.text = title
        statusSubtitle.text = subtitle
        statusSubtitle.visibility = if (subtitle.isBlank()) View.GONE else View.VISIBLE
        statusCard.visibility = View.VISIBLE
    }

    private fun setBusy(busy: Boolean) {
        btnDownload.isEnabled = !busy && engineReady
        btnUpdate.isEnabled = !busy && engineReady
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        if (busy) {
            progress.progress = 0
            // A run produces log output worth revealing on demand.
            btnToggleDetails.visibility = View.VISIBLE
        }
    }

    private fun log(line: String) {
        if (line.isEmpty()) return
        logView.append(line + "\n")
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
