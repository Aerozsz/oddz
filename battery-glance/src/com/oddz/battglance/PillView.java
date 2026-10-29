package com.oddz.battglance;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.view.View;

/** Rounded colour pill with a bold level number, plus a bolt while charging. */
final class PillView extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bolt = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Path boltPath = new Path();
    private Battery battery = new Battery(0, false, false);
    private int heightPx;
    private int minWidthPx;

    PillView(Context c, int heightPx) {
        super(c);
        Typeface tf = Typeface.create("sans-serif-condensed", Typeface.BOLD);
        text.setTypeface(Typeface.create(tf, Typeface.BOLD));
        text.setTextAlign(Paint.Align.CENTER);
        text.setFakeBoldText(true);
        bolt.setStyle(Paint.Style.FILL);
        setHeightPx(heightPx);
    }

    void setHeightPx(int h) {
        heightPx = Math.max(8, h);
        text.setTextSize(heightPx * 0.86f);
        requestLayout();
        invalidate();
    }

    /** Lets the badge be widened to fully cover the stock icon underneath it. */
    void setMinWidthPx(int w) {
        minWidthPx = w;
        requestLayout();
    }

    void setBattery(Battery b) {
        if (b.equalsTo(battery)) return;
        boolean widthChanged = (b.level == 100) != (battery.level == 100)
                || (b.level < 10) != (battery.level < 10)
                || b.charging != battery.charging;
        battery = b;
        if (widthChanged) requestLayout();
        invalidate();
    }

    private float boltWidth() {
        return battery.charging ? heightPx * 0.5f : 0f;
    }

    @Override
    protected void onMeasure(int wSpec, int hSpec) {
        float pad = heightPx * 0.32f;
        float textW = text.measureText(String.valueOf(battery.level));
        int w = (int) Math.ceil(pad * 2 + textW + boltWidth());
        w = Math.max(w, Math.max(minWidthPx, (int) (heightPx * 1.5f)));
        setMeasuredDimension(w, heightPx);
    }

    @Override
    protected void onDraw(Canvas c) {
        int w = getWidth(), h = getHeight();
        fill.setColor(battery.color());
        rect.set(0, 0, w, h);
        float r = h / 2f;
        c.drawRoundRect(rect, r, r, fill);

        String s = String.valueOf(battery.level);
        text.setColor(battery.textColor());
        Paint.FontMetrics fm = text.getFontMetrics();
        float baseline = h / 2f - (fm.ascent + fm.descent) / 2f;
        float bw = boltWidth();
        float cx = w / 2f + bw / 2f;
        c.drawText(s, cx, baseline, text);

        if (bw > 0) {
            float textW = text.measureText(s);
            float right = cx - textW / 2f - h * 0.04f;
            float left = right - bw * 0.82f;
            float top = h * 0.16f, bottom = h * 0.84f, mid = h * 0.52f;
            float bwid = right - left;
            boltPath.reset();
            boltPath.moveTo(left + bwid * 0.62f, top);
            boltPath.lineTo(left, mid + h * 0.02f);
            boltPath.lineTo(left + bwid * 0.48f, mid + h * 0.02f);
            boltPath.lineTo(left + bwid * 0.36f, bottom);
            boltPath.lineTo(right, mid - h * 0.06f);
            boltPath.lineTo(left + bwid * 0.54f, mid - h * 0.06f);
            boltPath.close();
            bolt.setColor(battery.textColor());
            c.drawPath(boltPath, bolt);
        }
    }
}
