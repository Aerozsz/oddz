package com.oddz.battglance;

import android.accessibilityservice.AccessibilityService;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

/**
 * Draws the badge in an accessibility overlay, which sits above the status bar. The stock
 * battery icon stays enabled underneath so SystemUI keeps reserving its slot at the far right
 * and wifi/signal icons lay out exactly as they normally would; the badge simply covers it.
 */
public final class BadgeService extends AccessibilityService {
    private WindowManager wm;
    private PillView pill;
    private WindowManager.LayoutParams lp;
    private boolean attached;
    private boolean statusBarWindowSeen;
    private final Rect bounds = new Rect();

    private final BroadcastReceiver batteryRx = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            if (pill != null) pill.setBattery(Battery.from(i));
        }
    };

    private final SharedPreferences.OnSharedPreferenceChangeListener prefRx =
            new SharedPreferences.OnSharedPreferenceChangeListener() {
                @Override
                public void onSharedPreferenceChanged(SharedPreferences sp, String key) {
                    applyLayout();
                    updateVisibility();
                }
            };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        pill = new PillView(this, 24);
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.RIGHT;
        lp.setTitle("BatteryGlance");
        if (Build.VERSION.SDK_INT >= 30) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            lp.setFitInsetsTypes(0);
        } else if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        pill.setBattery(Battery.from(registerReceiver(batteryRx,
                new IntentFilter(Intent.ACTION_BATTERY_CHANGED))));
        applyLayout();
        try {
            wm.addView(pill, lp);
            attached = true;
        } catch (RuntimeException e) {
            attached = false;
        }
        Prefs.get(this).registerOnSharedPreferenceChangeListener(prefRx);
        updateVisibility();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        updateVisibility();
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyLayout();
        updateVisibility();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        teardown();
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        teardown();
        super.onDestroy();
    }

    private void teardown() {
        Prefs.get(this).unregisterOnSharedPreferenceChangeListener(prefRx);
        try {
            unregisterReceiver(batteryRx);
        } catch (IllegalArgumentException ignored) {
        }
        if (attached && pill != null) {
            try {
                wm.removeViewImmediate(pill);
            } catch (RuntimeException ignored) {
            }
        }
        attached = false;
        pill = null;
    }

    // ---- layout -------------------------------------------------------------------------------

    private int statusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        int h = id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        return h > 0 ? h : dp(24);
    }

    /** SystemUI's own right padding, so the badge lines up with where the stock icon ends. */
    static int systemUiEndPadding(Context c) {
        try {
            Resources r = c.getPackageManager().getResourcesForApplication("com.android.systemui");
            for (String name : new String[]{"status_bar_padding_end", "status_bar_padding_end_default"}) {
                int id = r.getIdentifier(name, "dimen", "com.android.systemui");
                if (id != 0) return r.getDimensionPixelSize(id);
            }
        } catch (Exception ignored) {
        }
        return Math.round(8 * c.getResources().getDisplayMetrics().density);
    }

    private void applyLayout() {
        if (pill == null || lp == null) return;
        SharedPreferences sp = Prefs.get(this);
        int sbh = statusBarHeight();
        int h = Math.round(sbh * sp.getInt(Prefs.SIZE, Prefs.DEF_SIZE) / 100f);
        pill.setHeightPx(h);
        pill.setMinWidthPx(Math.round(h * sp.getInt(Prefs.WIDTH, Prefs.DEF_WIDTH) / 100f));
        int margin = sp.getInt(Prefs.RIGHT_MARGIN, -1);
        lp.x = margin >= 0 ? dp(margin) : systemUiEndPadding(this);
        lp.y = Math.max(0, (sbh - h) / 2 + dp(sp.getInt(Prefs.Y_NUDGE, 0)));
        if (attached) {
            try {
                wm.updateViewLayout(pill, lp);
            } catch (RuntimeException ignored) {
            }
        }
    }

    /**
     * The overlay is drawn above everything, so hide it whenever the stock icon it covers is not
     * where it normally is: notification shade / quick settings / lock screen pulled over the
     * screen, or the status bar hidden by a fullscreen app.
     */
    private void updateVisibility() {
        if (pill == null) return;
        SharedPreferences sp = Prefs.get(this);
        boolean show = sp.getBoolean(Prefs.ENABLED, true);
        if (show) {
            List<AccessibilityWindowInfo> windows;
            try {
                windows = getWindows();
            } catch (RuntimeException e) {
                windows = null;
            }
            if (windows != null) {
                int screenH = getResources().getDisplayMetrics().heightPixels;
                int sbh = statusBarHeight();
                boolean bigSystemWindow = false;
                boolean statusBarWindow = false;
                for (AccessibilityWindowInfo w : windows) {
                    if (w.getType() != AccessibilityWindowInfo.TYPE_SYSTEM) continue;
                    w.getBoundsInScreen(bounds);
                    if (bounds.top <= 0 && bounds.height() > screenH / 2) bigSystemWindow = true;
                    if (bounds.top <= 0 && bounds.height() > 0 && bounds.height() <= sbh * 2) {
                        statusBarWindow = true;
                    }
                }
                if (statusBarWindow) statusBarWindowSeen = true;
                if (bigSystemWindow) show = false;
                // Only treat a missing status bar as "fullscreen" once we know it is normally listed.
                if (statusBarWindowSeen && !statusBarWindow
                        && sp.getBoolean(Prefs.HIDE_FULLSCREEN, true)) {
                    show = false;
                }
            }
        }
        pill.setVisibility(show ? View.VISIBLE : View.INVISIBLE);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
