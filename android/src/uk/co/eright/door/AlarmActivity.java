package uk.co.eright.door;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full screen over the lock screen: the roll call is running, go out, tap I'M SAFE. */
public class AlarmActivity extends Activity {
    private TextView status;
    private Button safe;
    private boolean test;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        test = getIntent().getBooleanExtra("test", false);
        boolean drill = Prefs.getBool(this, "rcDrill");
        String started = Api.hhmm(Prefs.get(this, "rcStarted"));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(Ui.dp(this, 24), Ui.dp(this, 56), Ui.dp(this, 24), Ui.dp(this, 32));
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                drill ? new int[] { 0xFFB7791F, 0xFF3A2405 } : new int[] { 0xFFE0283F, 0xFF4A0912 });
        root.setBackground(bg);

        TextView kick = Ui.text(this, test ? "TEST — nothing is sent" : (drill ? "PRACTICE DRILL" : "THIS IS NOT A DRILL"), 14, 0xCCFFFFFF, true);
        kick.setLetterSpacing(0.2f);
        root.addView(kick);
        TextView title = Ui.text(this, drill ? "🟠 FIRE DRILL" : "🔥 FIRE ROLL CALL", 40, Color.WHITE, true);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, Ui.dp(this, 18), 0, Ui.dp(this, 8));
        root.addView(title);
        TextView what = Ui.text(this, (started.isEmpty() ? "" : "Started " + started + ". ") + "Leave by the nearest exit and go to the assembly point. Do not stop to sign out.", 19, Color.WHITE, false);
        what.setGravity(Gravity.CENTER);
        root.addView(what);

        safe = Ui.button(this, "I'M SAFE", 0xFF2ECC71, Color.WHITE);
        safe.setTextSize(34);
        safe.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 150));
        lp.topMargin = Ui.dp(this, 36);
        safe.setLayoutParams(lp);
        safe.setOnClickListener(v -> markSafe());
        root.addView(safe);

        status = Ui.text(this, "Tap when you are outside at the assembly point.", 17, 0xEEFFFFFF, false);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, Ui.dp(this, 16), 0, Ui.dp(this, 16));
        root.addView(status);

        Button fire = Ui.button(this, "Open the roll call (marshals)", 0x33FFFFFF, Color.WHITE);
        fire.setOnClickListener(v -> startActivity(new Intent(this, FireActivity.class)));
        root.addView(fire, Ui.fullWidth(this, 8));
        Button close = Ui.button(this, "Close", 0x22000000, 0xCCFFFFFF);
        close.setOnClickListener(v -> finish());
        root.addView(close, Ui.fullWidth(this, 8));
        setContentView(root);

        if ("safe".equals(Prefs.get(this, "rcMark")) && !test) showSafe("✓ You are already marked SAFE.");
    }

    private void markSafe() {
        safe.setEnabled(false);
        if (test) {
            getSystemService(NotificationManager.class).cancel(DoorService.N_ROLL);
            showSafe("Test only: nothing was sent. In a real roll call you would now be marked SAFE.");
            return;
        }
        status.setText("Sending…");
        new Thread(() -> {
            final String msg = DoorService.markSafe(this);
            runOnUiThread(() -> { if (msg.startsWith("✓")) showSafe(msg); else { status.setText(msg); safe.setEnabled(true); } });
        }).start();
    }

    private void showSafe(String msg) {
        safe.setEnabled(false);
        safe.setText("✓ SAFE");
        status.setText(msg);
    }
}
