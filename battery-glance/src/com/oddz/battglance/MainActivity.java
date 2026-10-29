package com.oddz.battglance;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

public final class MainActivity extends Activity {
    private SharedPreferences sp;
    private PillView preview;
    private TextView status;
    private LinearLayout setupCard;

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
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceiver(batteryRx, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        refreshSetup();
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

        // Setup card (hidden once the service is running).
        setupCard = card();
        setupCard.addView(heading("Turn it on"));
        setupCard.addView(text("Accessibility is the only way an app can draw on top of the status bar, "
                + "so the badge can sit exactly over Samsung's icon.", 14, muted()), margins(0, dp(6), 0, dp(8)));
        setupCard.addView(button("Open Accessibility → Installed apps → Battery Glance", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            }
        }));
        setupCard.addView(text("Switch greyed out? App info → ⋮ (top right) → Allow restricted settings, then try again.",
                14, muted()), margins(0, dp(10), 0, dp(8)));
        setupCard.addView(button("Open App info", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName())));
            }
        }));
        root.addView(setupCard, margins(0, dp(8), 0, dp(12)));

        // Stock icon must stay on so SystemUI keeps its slot and spacing.
        LinearLayout stock = card();
        stock.addView(heading("Keep Samsung's battery icon ON"));
        stock.addView(text("The badge covers it, so wifi and signal stay exactly where they belong. "
                + "If you turned it off: Good Lock → QuickStar → Indicator icons → Battery on. "
                + "Tip: turning off \"Show battery percentage\" makes the stock icon smaller and easier to cover.",
                14, muted()), margins(0, dp(6), 0, 0));
        root.addView(stock, margins(0, 0, 0, dp(12)));

        // Appearance.
        LinearLayout look = card();
        look.addView(heading("Badge"));
        look.addView(toggle("Show badge", Prefs.ENABLED, true, null));
        look.addView(slider("Height", Prefs.SIZE, 40, 100, Prefs.DEF_SIZE));
        look.addView(slider("Width (widen until the stock icon is fully covered)", Prefs.WIDTH, 100, 300,
                Prefs.DEF_WIDTH));
        int autoMargin = Math.round(BadgeService.systemUiEndPadding(this) / getResources().getDisplayMetrics().density);
        look.addView(slider("Distance from right edge", Prefs.RIGHT_MARGIN, 0, 48, autoMargin));
        look.addView(slider("Vertical nudge", Prefs.Y_NUDGE, -12, 12, 0));
        look.addView(toggle("Hide in fullscreen apps", Prefs.HIDE_FULLSCREEN, true, null));
        root.addView(look);

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
        setupCard.setVisibility(serviceEnabled() ? View.GONE : View.VISIBLE);
    }

    private boolean serviceEnabled() {
        String enabled = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        String me = getPackageName() + "/" + BadgeService.class.getName();
        String meShort = getPackageName() + "/.BadgeService";
        for (String s : enabled.split(":")) {
            if (s.equalsIgnoreCase(me) || s.equalsIgnoreCase(meShort)) return true;
        }
        return false;
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
