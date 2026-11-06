package uk.co.eright.door;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Tiny view helpers: the screens are built in code (no layout XML), in the register's colours. */
final class Ui {
    private Ui() { }

    static final int BG = 0xFF0A0D1A, CARD = 0xFF161C33, TEXT = 0xFFE8ECF6, MUTED = 0xFF8A93B0;
    static final int GREEN = 0xFF2ECC71, VIOLET = 0xFF7C5CFF, RED = 0xFFFF5566, AMBER = 0xFFF7B801;

    static int dp(Context c, int v) { return Math.round(v * c.getResources().getDisplayMetrics().density); }

    static TextView text(Context c, String s, int sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    static Button button(Context c, String s, int bg, int fg) {
        Button b = new Button(c);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(17);
        b.setTextColor(fg);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bg);
        d.setCornerRadius(dp(c, 16));
        b.setBackground(d);
        b.setPadding(dp(c, 16), dp(c, 14), dp(c, 16), dp(c, 14));
        b.setMinHeight(dp(c, 56));
        return b;
    }

    static LinearLayout card(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable d = new GradientDrawable();
        d.setColor(CARD);
        d.setCornerRadius(dp(c, 20));
        d.setStroke(dp(c, 1), 0x2E788CDC);
        l.setBackground(d);
        l.setPadding(dp(c, 18), dp(c, 16), dp(c, 18), dp(c, 16));
        return l;
    }

    static LinearLayout.LayoutParams fullWidth(Context c, int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(c, topDp);
        return lp;
    }
}
