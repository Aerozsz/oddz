package com.oddz.battglance;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (Prefs.get(c).getBoolean(Prefs.ENABLED, true)) {
            BatteryService.start(c);
        }
    }
}
