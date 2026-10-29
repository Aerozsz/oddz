package com.oddz.battglance;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final String ADB_HIDE_CMD =
            "adb shell pm grant com.oddz.battglance android.permission.WRITE_SECURE_SETTINGS";

    private SharedPreferences sp;
    private PillView preview;
    private TextView status;
    private Button overlayBtn, notifBtn, batteryOptBtn;
    private LinearLayout setupCard;
    private LinearLayout posSlider;

    private final BroadcastReceiver batteryRx = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            Battery b = Battery.from(i);
            preview.setBattery(b);
            status.setText(b.level + "% · " + b.label());
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        if (dark()) setTheme(android.R.style.Theme_Material_NoActionBar);
        super.onCreate(state);
        sp = Prefs.get(this);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(bg());
            getWindow().setNavigationBarColor(bg());
        }
        setContentView(buildUi());
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceiver(batteryRx, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        refreshSetup();
        if (sp.getBoolean(Prefs.ENABLED, true)) BatteryService.start(this);
    }

    @Override
    protected void onPause() {
        unregisterReceiver(batteryRx);
        super.onPause();
    }

    // ---- UI -----------------------------------------------------------------------------------

    private boolean dark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    private int bg() {
        return dark() ? 0xFF0E1013 : 0xFFF4F5F7;
    }

    private int cardColor() {
        return dark() ? 0xFF1A1D22 : 0xFFFFFFFF;
    }

    private int fg() {
        return dark() ? 0xFFF2F3F5 : 0xFF111315;
    }

    private int muted() {
        return dark() ? 0xFF9AA0A8 : 0xFF5C636B;
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(bg());
        scroll.setFillViewport(true);
        LinearLayout root = vertical();
        root.setPadding(dp(16), dp(28), dp(16), dp(32));
        scroll.addView(root);

        // Hero: big live preview.
        FrameLayout hero = new FrameLayout(this);
        hero.setPadding(0, dp(12), 0, dp(4));
        preview = new PillView(this, dp(72));
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        hero.addView(preview, plp);
        root.addView(hero, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(104)));

        status = text("", 16, muted());
        status.setGravity(Gravity.CENTER);
        root.addView(status);

        root.addView(legend(), margins(0, dp(14), 0, dp(10)));

        // Setup card (only the items still missing).
        setupCard = card();
        setupCard.addView(heading("Finish setup"));
        overlayBtn = button("Allow showing over the status bar", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            }
        });
        notifBtn = button("Allow notifications", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            }
        });
        batteryOptBtn = button("Keep running in background", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + getPackageName())));
                } catch (RuntimeException e) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            }
        });
        setupCard.addView(overlayBtn, margins(0, dp(8), 0, 0));
        setupCard.addView(notifBtn, margins(0, dp(8), 0, 0));
        setupCard.addView(batteryOptBtn, margins(0, dp(8), 0, 0));
        root.addView(setupCard, margins(0, dp(8), 0, dp(12)));

        // Appearance.
        LinearLayout look = card();
        look.addView(heading("Status bar badge"));
        look.addView(toggle("Show badge", Prefs.ENABLED, true, new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton b, boolean on) {
                sp.edit().putBoolean(Prefs.ENABLED, on).apply();
                if (on) BatteryService.start(MainActivity.this);
                else BatteryService.stop(MainActivity.this);
            }
        }));
        look.addView(slider("Size", Prefs.SIZE, 40, 100, Prefs.DEF_SIZE));
        posSlider = slider("Position (left ↔ right)", Prefs.POS_X, 0, 1000, Placement.autoPermille(this));
        look.addView(posSlider);
        look.addView(button("Auto-place next to camera", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                sp.edit().remove(Prefs.POS_X).apply();
                ((SeekBar) posSlider.getChildAt(1)).setProgress(Placement.autoPermille(MainActivity.this));
            }
        }), margins(0, dp(8), 0, 0));
        look.addView(slider("Vertical nudge", Prefs.Y_NUDGE, -12, 12, 0));
        look.addView(toggle("Hide in fullscreen apps", Prefs.HIDE_FULLSCREEN, true, null));
        look.addView(toggle("Number in notification icons too", Prefs.NOTIF_ICON, true, null));
        root.addView(look, margins(0, 0, 0, dp(12)));

        // Hiding Samsung's icon.
        LinearLayout hide = card();
        hide.addView(heading("Hide Samsung's battery icon"));
        hide.addView(text("Good Lock → QuickStar → Indicator icons → turn off Battery.", 14, muted()),
                margins(0, dp(6), 0, dp(8)));
        hide.addView(button("Hide it directly", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setStockIconHidden(true);
            }
        }));
        hide.addView(button("Bring it back", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setStockIconHidden(false);
            }
        }), margins(0, dp(8), 0, 0));
        root.addView(hide);

        return scroll;
    }

    private View legend() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        int[][] bands = {
                {Battery.GREEN, 60}, {Battery.YELLOW, 30}, {Battery.ORANGE, 15}, {Battery.RED, 0}, {Battery.BLUE, -1}
        };
        String[] labels = {"60+", "30–59", "15–29", "<15", "⚡"};
        for (int i = 0; i < bands.length; i++) {
            TextView t = text(labels[i], 13, 0xFF000000);
            t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setGravity(Gravity.CENTER);
            t.setPadding(dp(10), dp(4), dp(10), dp(4));
            GradientDrawable d = new GradientDrawable();
            d.setColor(bands[i][0]);
            d.setCornerRadius(dp(100));
            t.setBackground(d);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMargins(dp(3), 0, dp(3), 0);
            row.addView(t, lp);
        }
        return row;
    }

    private void refreshSetup() {
        boolean overlay = Settings.canDrawOverlays(this);
        boolean notif = getSystemService(android.app.NotificationManager.class).areNotificationsEnabled();
        PowerManager pm = getSystemService(PowerManager.class);
        boolean unrestricted = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        overlayBtn.setVisibility(overlay ? View.GONE : View.VISIBLE);
        notifBtn.setVisibility(notif ? View.GONE : View.VISIBLE);
        batteryOptBtn.setVisibility(unrestricted ? View.GONE : View.VISIBLE);
        setupCard.setVisibility(overlay && notif && unrestricted ? View.GONE : View.VISIBLE);
    }

    private void setStockIconHidden(boolean hidden) {
        String key = "icon_blacklist";
        try {
            String cur = Settings.Secure.getString(getContentResolver(), key);
            java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
            if (!TextUtils.isEmpty(cur)) {
                for (String s : cur.split(",")) if (!s.trim().isEmpty()) set.add(s.trim());
            }
            if (hidden) set.add("battery");
            else set.remove("battery");
            Settings.Secure.putString(getContentResolver(), key, TextUtils.join(",", set));
            Toast.makeText(this, hidden ? "Samsung battery icon hidden" : "Samsung battery icon restored",
                    Toast.LENGTH_SHORT).show();
        } catch (SecurityException e) {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            cm.setPrimaryClip(ClipData.newPlainText("adb", ADB_HIDE_CMD));
            Toast.makeText(this, "Needs one-time ADB grant — command copied. Or use Good Lock.",
                    Toast.LENGTH_LONG).show();
        }
    }

    // ---- small view helpers -------------------------------------------------------------------

    private LinearLayout vertical() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private LinearLayout card() {
        LinearLayout l = vertical();
        l.setPadding(dp(16), dp(14), dp(16), dp(16));
        GradientDrawable d = new GradientDrawable();
        d.setColor(cardColor());
        d.setCornerRadius(dp(20));
        l.setBackground(d);
        return l;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private TextView heading(String s) {
        TextView t = text(s, 18, fg());
        t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTextColor(0xFF000000);
        GradientDrawable d = new GradientDrawable();
        d.setColor(Battery.BLUE);
        d.setCornerRadius(dp(14));
        b.setBackground(d);
        b.setMinHeight(dp(48));
        b.setOnClickListener(l);
        return b;
    }

    private View toggle(String label, final String key, boolean def,
                        final CompoundButton.OnCheckedChangeListener custom) {
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextSize(16);
        s.setTextColor(fg());
        s.setMinHeight(dp(48));
        s.setChecked(sp.getBoolean(key, def));
        s.setOnCheckedChangeListener(custom != null ? custom : new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton b, boolean on) {
                sp.edit().putBoolean(key, on).apply();
            }
        });
        LinearLayout wrap = vertical();
        wrap.setPadding(0, dp(6), 0, 0);
        wrap.addView(s);
        return wrap;
    }

    private LinearLayout slider(String label, final String key, final int min, int max, int def) {
        LinearLayout box = vertical();
        box.setPadding(0, dp(10), 0, 0);
        box.addView(text(label, 15, fg()));
        SeekBar bar = new SeekBar(this);
        bar.setMax(max - min);
        bar.setProgress(sp.getInt(key, def) - min);
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int p, boolean user) {
                if (user) sp.edit().putInt(key, p + min).apply();
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar s) {
            }
        });
        box.addView(bar, margins(0, dp(4), 0, 0));
        return box;
    }

    private LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(l, t, r, b);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
