package com.oddz.battglance;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;

/** Keeps the colour pill on top of the status bar and the numeric notification icon current. */
public final class BatteryService extends Service {
    private static final int NOTIF_ID = 1;
    private static final String CH_VISIBLE = "level_icon";
    private static final String CH_QUIET = "level_quiet";

    private WindowManager wm;
    private PillView pill;
    private WindowManager.LayoutParams lp;
    private boolean pillAttached;
    private boolean statusBarSeen;
    private boolean statusBarHidden;
    private Battery battery;
    private String lastNotifKey;

    private final BroadcastReceiver batteryRx = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            Battery b = Battery.from(i);
            if (b.equalsTo(battery)) return;
            battery = b;
            render();
        }
    };

    private final SharedPreferences.OnSharedPreferenceChangeListener prefRx =
            new SharedPreferences.OnSharedPreferenceChangeListener() {
                @Override
                public void onSharedPreferenceChanged(SharedPreferences sp, String key) {
                    if (Prefs.ENABLED.equals(key) && !sp.getBoolean(key, true)) {
                        stopSelf();
                        return;
                    }
                    applyLayout();
                    lastNotifKey = null;
                    render();
                }
            };

    static void start(Context c) {
        Intent i = new Intent(c, BatteryService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (RuntimeException ignored) {
            // Background-start restriction; the next app open or boot will start it.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, BatteryService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        createChannels();
        battery = Battery.read(this);
        startForeground(NOTIF_ID, buildNotification());
        registerReceiver(batteryRx, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        Prefs.get(this).registerOnSharedPreferenceChangeListener(prefRx);
        ensurePill();
        render();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Re-sent by the activity after the overlay permission is granted.
        ensurePill();
        render();
        return START_STICKY;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyLayout();
    }

    @Override
    public void onDestroy() {
        Prefs.get(this).unregisterOnSharedPreferenceChangeListener(prefRx);
        try {
            unregisterReceiver(batteryRx);
        } catch (IllegalArgumentException ignored) {
        }
        removePill();
        super.onDestroy();
    }

    // ---- overlay ------------------------------------------------------------------------------

    private void ensurePill() {
        if (pillAttached || !Settings.canDrawOverlays(this)) return;
        pill = new PillView(this, pillHeight());
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.END;
        lp.setTitle("BatteryGlance");
        if (Build.VERSION.SDK_INT >= 30) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            lp.setFitInsetsTypes(0);
        } else if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            pill.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    boolean visible = insets.isVisible(WindowInsets.Type.statusBars());
                    if (visible) statusBarSeen = true;
                    // Only trust "hidden" once the status bar has been reported visible at least once.
                    boolean hidden = statusBarSeen && !visible;
                    if (hidden != statusBarHidden) {
                        statusBarHidden = hidden;
                        updatePillVisibility();
                    }
                    return insets;
                }
            });
        }
        applyLayout();
        try {
            wm.addView(pill, lp);
            pillAttached = true;
        } catch (RuntimeException e) {
            pill = null;
        }
    }

    private void removePill() {
        if (pillAttached && pill != null) {
            try {
                wm.removeViewImmediate(pill);
            } catch (RuntimeException ignored) {
            }
        }
        pillAttached = false;
        pill = null;
    }

    private int statusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        int h = id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        return h > 0 ? h : dp(24);
    }

    private int pillHeight() {
        int size = Prefs.get(this).getInt(Prefs.SIZE, Prefs.DEF_SIZE);
        return Math.round(statusBarHeight() * size / 100f);
    }

    private void applyLayout() {
        if (pill == null || lp == null) return;
        SharedPreferences sp = Prefs.get(this);
        int h = pillHeight();
        pill.setHeightPx(h);
        lp.x = dp(sp.getInt(Prefs.END_MARGIN, Prefs.DEF_END_MARGIN));
        lp.y = Math.max(0, (statusBarHeight() - h) / 2 + dp(sp.getInt(Prefs.Y_NUDGE, 0)));
        updatePillVisibility();
        if (pillAttached) {
            try {
                wm.updateViewLayout(pill, lp);
            } catch (RuntimeException ignored) {
            }
        }
    }

    private void updatePillVisibility() {
        if (pill == null) return;
        boolean hide = statusBarHidden && Prefs.get(this).getBoolean(Prefs.HIDE_FULLSCREEN, true);
        pill.setVisibility(hide ? View.INVISIBLE : View.VISIBLE);
    }

    // ---- notification -------------------------------------------------------------------------

    private void createChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel visible = new NotificationChannel(CH_VISIBLE,
                "Battery number in status bar", NotificationManager.IMPORTANCE_LOW);
        visible.setShowBadge(false);
        visible.setSound(null, null);
        visible.enableVibration(false);
        NotificationChannel quiet = new NotificationChannel(CH_QUIET,
                "Battery (no status bar icon)", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        nm.createNotificationChannel(visible);
        nm.createNotificationChannel(quiet);
    }

    private void render() {
        if (pill != null) pill.setBattery(battery);
        String key = battery.level + "|" + battery.charging + "|" + battery.full;
        if (key.equals(lastNotifKey)) return;
        lastNotifKey = key;
        getSystemService(NotificationManager.class).notify(NOTIF_ID, buildNotification());
    }

    private Notification buildNotification() {
        boolean icon = Prefs.get(this).getBoolean(Prefs.NOTIF_ICON, true);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        StringBuilder title = new StringBuilder().append(battery.level).append("% · ").append(battery.label());
        String text = null;
        BatteryManager bm = getSystemService(BatteryManager.class);
        if (battery.charging && !battery.full && Build.VERSION.SDK_INT >= 28 && bm != null) {
            long ms = bm.computeChargeTimeRemaining();
            if (ms > 0) text = "Full in " + formatDuration(ms);
        }

        Notification.Builder b = new Notification.Builder(this, icon ? CH_VISIBLE : CH_QUIET)
                .setSmallIcon(numberIcon(battery.level))
                .setContentTitle(title)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setColor(battery.color())
                .setCategory(Notification.CATEGORY_STATUS)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        if (text != null) b.setContentText(text);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }

    private static String formatDuration(long ms) {
        long min = Math.max(1, ms / 60000);
        if (min < 60) return min + " min";
        return (min / 60) + " h " + (min % 60) + " min";
    }

    /** Status-bar icons are tinted monochrome by SystemUI, so the icon is just the digits. */
    private Icon numberIcon(int level) {
        int size = 96;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(0xFFFFFFFF);
        p.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        p.setFakeBoldText(true);
        p.setTextAlign(Paint.Align.CENTER);
        String s = String.valueOf(level);
        float ts = size * 0.92f;
        p.setTextSize(ts);
        float w = p.measureText(s);
        if (w > size * 0.98f) {
            ts = ts * size * 0.98f / w;
            p.setTextSize(ts);
        }
        Paint.FontMetrics fm = p.getFontMetrics();
        float baseline = size / 2f - (fm.ascent + fm.descent) / 2f;
        c.drawText(s, size / 2f, baseline, p);
        return Icon.createWithBitmap(bmp);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
