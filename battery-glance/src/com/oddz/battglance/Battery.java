package com.oddz.battglance;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;

/** Battery snapshot plus the colour scale shared by the overlay, the preview and the notification. */
final class Battery {
    final int level;      // 0..100
    final boolean charging;
    final boolean full;

    Battery(int level, boolean charging, boolean full) {
        this.level = level;
        this.charging = charging;
        this.full = full;
    }

    static Battery from(Intent i) {
        if (i == null) return new Battery(0, false, false);
        int lvl = i.getIntExtra(BatteryManager.EXTRA_LEVEL, 0);
        int scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        int pct = scale > 0 ? Math.round(lvl * 100f / scale) : lvl;
        int status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        int plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
        boolean full = status == BatteryManager.BATTERY_STATUS_FULL;
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING || (full && plugged != 0);
        return new Battery(Math.max(0, Math.min(100, pct)), charging, full);
    }

    static Battery read(Context c) {
        return from(c.getApplicationContext().registerReceiver(null,
                new IntentFilter(Intent.ACTION_BATTERY_CHANGED)));
    }

    // Saturated, high-luminance fills so black digits stay at max contrast on every band.
    static final int GREEN = 0xFF34C759;
    static final int YELLOW = 0xFFFFD60A;
    static final int ORANGE = 0xFFFF9500;
    static final int RED = 0xFFFF453A;
    static final int BLUE = 0xFF40A9FF;

    int color() {
        if (charging) return BLUE;
        if (level >= 60) return GREEN;
        if (level >= 30) return YELLOW;
        if (level >= 15) return ORANGE;
        return RED;
    }

    int textColor() {
        return 0xFF000000;
    }

    String label() {
        if (full) return "Full";
        if (charging) return "Charging";
        if (level < 15) return "Critical";
        if (level < 30) return "Low";
        return "On battery";
    }

    boolean equalsTo(Battery o) {
        return o != null && o.level == level && o.charging == charging && o.full == full;
    }
}
