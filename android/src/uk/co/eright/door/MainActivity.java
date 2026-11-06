package uk.co.eright.door;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

/** Set-up (from the person's own "I'm SAFE" link) and the status screen. */
public class MainActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private LinearLayout root;
    private TextView msg;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        DoorService.createChannels(this);
        handleLink(getIntent());
        render();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleLink(intent);
    }

    @Override protected void onResume() {
        super.onResume();
        render();
        ui.postDelayed(tick, 2000);
        if (Prefs.configured(this)) DoorService.refresh(this);
    }

    @Override protected void onPause() {
        super.onPause();
        ui.removeCallbacks(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() { if (Prefs.configured(MainActivity.this)) render(); ui.postDelayed(this, 2000); }
    };

    // ------------------------------------------------------------------ setup
    private void handleLink(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !"eright-door".equals(u.getScheme())) return;
        setupFrom(u.getQueryParameter("server"), u.getQueryParameter("k"));
    }

    /** Accepts the "I'm SAFE" link itself: http://192.168.101.102:3000/safe#k=… */
    private void setupFromPasted(String text) {
        try {
            Uri u = Uri.parse(text.trim());
            String k = null;
            String frag = u.getFragment();
            if (frag != null) for (String part : frag.split("&")) if (part.startsWith("k=")) k = Uri.decode(part.substring(2));
            if (k == null) k = u.getQueryParameter("k");
            String server = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
            setupFrom(server, k);
        } catch (Exception e) {
            say("That does not look like your I'm SAFE link.");
        }
    }

    private void setupFrom(final String server, final String k) {
        if (server == null || k == null || k.length() < 16 || !(server.startsWith("http://") || server.startsWith("https://"))) { say("That setup link is incomplete. Open your I'm SAFE link again."); return; }
        say("Checking with the register…");
        new Thread(() -> {
            try {
                JSONObject me = Api.call(server, "GET", "/api/me", k, null, null);
                JSONObject p = me.optJSONObject("person");
                if (p == null) { ui.post(() -> say("The register does not know that key (a newer link may have been issued). Ask the admin for your current I'm SAFE link.")); return; }
                Prefs.setup(this, server, k, p.optString("name"));
                Prefs.put(this, "company", me.optString("companyName"));
                Prefs.put(this, "outsideUrl", me.isNull("outsideUrl") ? "" : me.optString("outsideUrl", ""));
                Prefs.putBool(this, "signedIn", p.optBoolean("signedIn"));
                Prefs.put(this, "problem", "");
                ui.post(() -> {
                    DoorService.start(this);
                    render();
                    say("Welcome, " + p.optString("name").split(" ")[0] + "! Now give the app the permissions below.");
                });
            } catch (Exception e) {
                ui.post(() -> say("Could not reach the register at " + server + ". Set the app up while on the office Wi-Fi."));
            }
        }).start();
    }

    // ------------------------------------------------------------------ screen
    private void render() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Ui.BG);
        scroll.setFillViewport(true);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(Ui.dp(this, 20), Ui.dp(this, 36), Ui.dp(this, 20), Ui.dp(this, 32));
        scroll.addView(root);

        TextView title = Ui.text(this, "eRIGHT Door", 30, Ui.TEXT, true);
        root.addView(title);
        String keep = msg == null ? "" : msg.getText().toString();
        msg = Ui.text(this, keep, 15, Ui.VIOLET, true);
        msg.setPadding(0, Ui.dp(this, 6), 0, Ui.dp(this, 6));
        root.addView(msg);

        if (!Prefs.configured(this)) renderSetup(); else renderStatus();
        setContentView(scroll);
    }

    private void renderSetup() {
        LinearLayout c = Ui.card(this);
        c.addView(Ui.text(this, "Set up this phone", 20, Ui.TEXT, true));
        TextView how = Ui.text(this, "1. Ask the admin for your personal \"I'm SAFE\" link (Admin → Staff → I'm SAFE link).\n"
                + "2. Open it on this phone while on the office Wi-Fi.\n"
                + "3. Tap \"📱 Set up the eRIGHT Door app\" on that page.\n\nOr paste the link here:", 15, Ui.MUTED, false);
        how.setPadding(0, Ui.dp(this, 8), 0, Ui.dp(this, 8));
        c.addView(how);
        final EditText link = new EditText(this);
        link.setHint("http://192.168.101.102:3000/safe#k=…");
        link.setTextColor(Ui.TEXT);
        link.setHintTextColor(Ui.MUTED);
        link.setSingleLine(true);
        c.addView(link);
        Button go = Ui.button(this, "Set up", Ui.VIOLET, 0xFFFFFFFF);
        go.setOnClickListener(v -> setupFromPasted(link.getText().toString()));
        c.addView(go, Ui.fullWidth(this, 10));
        root.addView(c, Ui.fullWidth(this, 12));
    }

    private void renderStatus() {
        // who + where
        LinearLayout s = Ui.card(this);
        s.addView(Ui.text(this, Prefs.name(this), 24, Ui.TEXT, true));
        boolean in = Prefs.getBool(this, "signedIn");
        String since = Api.hhmm(Prefs.get(this, "since"));
        s.addView(Ui.text(this, in ? "● Signed IN" + (since.isEmpty() ? "" : " since " + since) : "○ Signed out", 18, in ? Ui.GREEN : Ui.MUTED, true));
        String w = Prefs.get(this, "watch");
        TextView watch = Ui.text(this, w.isEmpty() ? "Starting…" : w, 15, Ui.TEXT, false);
        watch.setPadding(0, Ui.dp(this, 6), 0, 0);
        s.addView(watch);
        String problem = Prefs.get(this, "problem");
        if (!problem.isEmpty()) { TextView p = Ui.text(this, "⚠ " + problem, 15, Ui.AMBER, true); p.setPadding(0, Ui.dp(this, 8), 0, 0); s.addView(p); }
        root.addView(s, Ui.fullWidth(this, 12));

        // roll call running?
        if (!Prefs.get(this, "rcId").isEmpty()) {
            boolean safe = "safe".equals(Prefs.get(this, "rcMark"));
            Button rc = Ui.button(this, safe ? "✓ You are marked SAFE" : "🔥 ROLL CALL RUNNING — tap here", safe ? Ui.GREEN : Ui.RED, 0xFFFFFFFF);
            rc.setOnClickListener(v -> startActivity(new Intent(this, AlarmActivity.class)));
            root.addView(rc, Ui.fullWidth(this, 12));
        }

        // how it works for you
        LinearLayout o = Ui.card(this);
        o.addView(Ui.text(this, "Automatic", 18, Ui.TEXT, true));
        String office = Prefs.officeKnown(this)
                ? "✓ Office location learned (" + Prefs.officeN(this) + " fix" + (Prefs.officeN(this) == 1 ? "" : "es") + ", ±" + Math.round(Prefs.officeAcc(this)) + " m). It stays on this phone."
                : "… Office location not learned yet: it is learned automatically the next time you are on the office Wi-Fi with location on.";
        String out = Prefs.outsideUrl(this).isEmpty()
                ? "Off the office Wi-Fi the register can't be reached yet, so you stay signed in until you sign out at the door (the public address signin.eright.co.uk is not live yet)."
                : "Off the office Wi-Fi: " + Prefs.outsideUrl(this);
        TextView t = Ui.text(this, "• IN when this phone joins the office Wi-Fi\n• OUT when it has left the Wi-Fi AND is over 150 m from the office\n• Fire roll call: full-screen alarm with I'M SAFE\n\n" + office + "\n\n" + out, 14, Ui.MUTED, false);
        t.setPadding(0, Ui.dp(this, 6), 0, 0);
        o.addView(t);
        root.addView(o, Ui.fullWidth(this, 12));

        // permissions
        LinearLayout p = Ui.card(this);
        p.addView(Ui.text(this, "Permissions", 18, Ui.TEXT, true));
        boolean notif = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        boolean loc = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean bgLoc = checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean full = Build.VERSION.SDK_INT < 34 || getSystemService(NotificationManager.class).canUseFullScreenIntent();
        boolean battery = getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
        perm(p, notif, "Notifications", "for the roll-call alarm", () -> requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1));
        perm(p, loc && bgLoc, "Location: Allow all the time", loc ? "choose \"Allow all the time\" so the app can tell when you have left" : "precise, then \"Allow all the time\"",
                () -> { if (!loc) requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, 2);
                        else requestPermissions(new String[] { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, 3); });
        perm(p, full, "Full-screen alarm", "shows the roll call over the lock screen",
                () -> startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName()))));
        perm(p, battery, "Battery: Unrestricted", "so the phone does not put the app to sleep",
                () -> startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))));
        root.addView(p, Ui.fullWidth(this, 12));

        // actions
        Button signIn = Ui.button(this, "Sign in now", 0xFF1E5E3C, 0xFFFFFFFF);
        signIn.setOnClickListener(v -> manual("in"));
        Button signOut = Ui.button(this, "Sign out now", 0xFF3A2D6E, 0xFFFFFFFF);
        signOut.setOnClickListener(v -> manual("out"));
        Button fire = Ui.button(this, "Open the roll call", 0xFF2A1520, 0xFFFFB3BB);
        fire.setOnClickListener(v -> startActivity(new Intent(this, FireActivity.class)));
        Button test = Ui.button(this, "Test the alarm (nothing is sent)", 0xFF222842, Ui.TEXT);
        test.setOnClickListener(v -> DoorService.alarm(this, false, "", true));
        Button forget = Ui.button(this, "Remove this phone's set-up", 0x00000000, Ui.MUTED);
        forget.setOnClickListener(v -> new AlertDialog.Builder(this).setMessage("Remove the set-up from this phone? It stops signing you in and out.")
                .setPositiveButton("Remove", (d, i) -> { stopService(new Intent(this, DoorService.class)); Prefs.forget(this); render(); })
                .setNegativeButton("Cancel", null).show());
        root.addView(signIn, Ui.fullWidth(this, 16));
        root.addView(signOut, Ui.fullWidth(this, 8));
        root.addView(fire, Ui.fullWidth(this, 8));
        root.addView(test, Ui.fullWidth(this, 8));
        root.addView(forget, Ui.fullWidth(this, 8));
        TextView ver = Ui.text(this, "eRIGHT Door " + version() + " · " + Prefs.server(this), 12, Ui.MUTED, false);
        ver.setGravity(Gravity.CENTER);
        ver.setPadding(0, Ui.dp(this, 16), 0, 0);
        root.addView(ver);
    }

    private void perm(LinearLayout parent, boolean ok, String name, String why, Runnable fix) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, Ui.dp(this, 10), 0, 0);
        LinearLayout txt = new LinearLayout(this);
        txt.setOrientation(LinearLayout.VERTICAL);
        txt.addView(Ui.text(this, (ok ? "✓ " : "✗ ") + name, 16, ok ? Ui.GREEN : Ui.AMBER, true));
        txt.addView(Ui.text(this, why, 13, Ui.MUTED, false));
        row.addView(txt, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        if (!ok) {
            Button b = Ui.button(this, "Fix", Ui.VIOLET, 0xFFFFFFFF);
            b.setOnClickListener(v -> fix.run());
            row.addView(b);
        }
        parent.addView(row);
    }

    private void manual(final String direction) {
        say(direction.equals("in") ? "Signing in…" : "Signing out…");
        new Thread(() -> {
            String result = "Could not reach the register." + (direction.equals("in") ? " Signing in needs the office Wi-Fi." : "");
            java.util.ArrayList<String> bases = new java.util.ArrayList<>();
            bases.add(Prefs.server(this));
            if (Prefs.outsideUrl(this).startsWith("https://")) bases.add(Prefs.outsideUrl(this));
            for (String base : bases) {
                try {
                    JSONObject r = Api.call(base, "POST", "/api/me/sign", Prefs.key(this), new JSONObject().put("direction", direction).put("reason", "manual"), null);
                    Prefs.putBool(this, "signedIn", r.optBoolean("signedIn"));
                    Prefs.put(this, "since", r.isNull("since") ? "" : r.optString("since", ""));
                    result = r.optBoolean("changed") ? (direction.equals("in") ? "✓ Signed IN at " : "✓ Signed OUT at ") + Api.now() : (direction.equals("in") ? "You were already signed in." : "You were already signed out.");
                    break;
                } catch (Api.HttpError e) {
                    result = e.getMessage();
                } catch (Exception ignored) { }
            }
            final String m = result;
            ui.post(() -> { say(m); render(); });
        }).start();
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        render();
    }

    private void say(String s) { if (msg != null) msg.setText(s); }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
    }
}
