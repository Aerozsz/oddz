package com.oddz.battglance;

import android.content.Context;
import android.graphics.Rect;
import android.os.Build;
import android.view.DisplayCutout;
import android.view.WindowManager;

/** Horizontal placement of the badge, stored as the pill's left edge in per-mille of screen width. */
final class Placement {
    /** Right edge of the top camera cutout as reported to the overlay window, -1 if unknown. */
    static volatile int knownCutoutRight = -1;

    private Placement() {
    }

    static int screenWidth(Context c) {
        WindowManager wm = c.getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30 && wm != null) {
            try {
                return wm.getCurrentWindowMetrics().getBounds().width();
            } catch (RuntimeException ignored) {
            }
        }
        return c.getResources().getDisplayMetrics().widthPixels;
    }

    /**
     * Default spot: just right of the front-camera cutout, which sits between the clock and
     * notification icons on the left and the system icons (wifi, signal) on the right.
     * Falls back to the horizontal centre when there is no top cutout.
     */
    static int autoPermille(Context c) {
        int width = screenWidth(c);
        if (width <= 0) return 500;
        int gap = Math.round(6 * c.getResources().getDisplayMetrics().density);
        if (knownCutoutRight > 0) return Math.min(1000, (knownCutoutRight + gap) * 1000 / width);
        WindowManager wm = c.getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30 && wm != null) {
            try {
                Integer right = topCutoutRight(
                        wm.getCurrentWindowMetrics().getWindowInsets().getDisplayCutout(), width);
                if (right != null) return Math.min(1000, (right + gap) * 1000 / width);
            } catch (RuntimeException ignored) {
            }
        }
        return 500;
    }

    static Integer topCutoutRight(DisplayCutout cut, int width) {
        if (cut != null) {
            for (Rect r : cut.getBoundingRects()) {
                if (r.top <= 0 && r.width() < width / 2) return r.right;
            }
        }
        return null;
    }

    static int permille(Context c) {
        int v = Prefs.get(c).getInt(Prefs.POS_X, -1);
        return v >= 0 ? v : autoPermille(c);
    }

    /** Left edge in px, clamped so the whole pill stays on screen. */
    static int leftPx(Context c, int pillWidth) {
        int width = screenWidth(c);
        int x = permille(c) * width / 1000;
        return Math.max(0, Math.min(x, width - pillWidth));
    }
}
