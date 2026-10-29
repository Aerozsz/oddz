package com.oddz.battglance;

import android.content.Context;
import android.content.SharedPreferences;

final class Prefs {
    static final String ENABLED = "enabled";
    static final String SIZE = "size";              // percent of status bar height, 40..100
    static final String WIDTH = "width";            // minimum width, percent of badge height
    static final String RIGHT_MARGIN = "right_margin"; // dp from the right edge, -1 = SystemUI padding
    static final String Y_NUDGE = "y_nudge";        // dp, -12..12
    static final String HIDE_FULLSCREEN = "hide_fullscreen";

    static final int DEF_SIZE = 72;
    static final int DEF_WIDTH = 170;

    static SharedPreferences get(Context c) {
        return c.getApplicationContext().getSharedPreferences("battglance", Context.MODE_PRIVATE);
    }
}
