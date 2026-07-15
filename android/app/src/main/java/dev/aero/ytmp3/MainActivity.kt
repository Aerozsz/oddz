package dev.aero.ytmp3

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var input: EditText
    private lateinit var btnDownload: Button
    private lateinit var btnUpdate: Button
    private lateinit var progress: ProgressBar
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private var engineReady = false

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startDownload() else log("Storage permission denied.")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        input = findViewById(R.id.input)
        btnDownload = findViewById(R.id.btnDownload)
        btnUpdate = findViewById(R.id.btnUpdate)
        progress = findViewById(R.id.progress)
        logView = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)

        btnDownload.isEnabled = false
        btnUpdate.isEnabled = false
        btnDownload.setOnClickListener { ensurePermissionThenDownload() }
        btnUpdate.setOnClickListener { updateYtDlp() }

        log("Initializing download engine…")
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                YoutubeDL.getInstance().init(this@MainActivity)
                FFmpeg.getInstance().init(this@MainActivity)
            } catch (e: Exception) {
                Log.e("ytmp3", "init failed", e)
                withContext(Dispatchers.Main) { log("Engine init failed: ${e.message}") }
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
            log("Paste at least one link first.")
            return
        }
        val outDir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "yt-mp3",
        )
        outDir.mkdirs()

        setBusy(true)
        log("Downloading ${urls.size} link(s) to ${outDir.absolutePath}")

        lifecycleScope.launch(Dispatchers.IO) {
            for (url in urls) {
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
                        runOnUiThread {
                            progress.progress = pct.toInt().coerceIn(0, 100)
                            log(line.trim())
                        }
                    }
                    withContext(Dispatchers.Main) { log("Finished: $url") }
                } catch (e: Exception) {
                    Log.e("ytmp3", "download failed", e)
                    withContext(Dispatchers.Main) { log("FAILED: $url — ${e.message}") }
                }
            }
            // Make the new files visible to music players and file managers.
            val files = outDir.walkTopDown().filter { it.extension == "mp3" }
                .map { it.absolutePath }.toList()
            if (files.isNotEmpty()) {
                MediaScannerConnection.scanFile(this@MainActivity, files.toTypedArray(), null, null)
            }
            withContext(Dispatchers.Main) {
                log("All done. Files are in Download/yt-mp3.")
                setBusy(false)
            }
        }
    }

    private fun updateYtDlp() {
        setBusy(true)
        log("Updating yt-dlp…")
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val status = YoutubeDL.getInstance().updateYoutubeDL(this@MainActivity)
                withContext(Dispatchers.Main) { log("Update result: $status") }
            } catch (e: Exception) {
                Log.e("ytmp3", "update failed", e)
                withContext(Dispatchers.Main) { log("Update failed: ${e.message}") }
            }
            withContext(Dispatchers.Main) { setBusy(false) }
        }
    }

    private fun setBusy(busy: Boolean) {
        btnDownload.isEnabled = !busy && engineReady
        btnUpdate.isEnabled = !busy && engineReady
        progress.visibility = if (busy) ProgressBar.VISIBLE else ProgressBar.GONE
        if (busy) progress.progress = 0
    }

    private fun log(line: String) {
        if (line.isEmpty()) return
        logView.append(line + "\n")
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
