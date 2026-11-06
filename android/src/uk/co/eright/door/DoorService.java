package uk.co.eright.door;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

/**
 * The watcher. Rules (fire safety: an over-count is safe, an under-count never is):
 *  - IN: the phone ARRIVES on a network where the register answers with this person's key. Only on the arrival,
 *    never on a restart or while it stays connected, so a sign-out at the door screen is never undone.
 *  - Before the key is sent anywhere, the server must answer (keyless) with the company name saved at setup, so a
 *    home router that happens to use the office address never receives the key.
 *  - OUT: off the office network AND more than 150 m from the office location the phone learned itself, beyond the
 *    fix's own error margin. Unsure, no fix, office not learned yet, or register unreachable = stay signed in.
 *    Gives up after 4 hours so nobody is signed out by surprise the next morning.
 *  - Roll call: live stream from the register; a full-screen alarm with "I'M SAFE" if this person is on its register.
 */
public class DoorService extends Service {
    static final String TAG = "eRIGHTDoor";   // decisions only: never the key, never coordinates
    static final String CH_WATCH = "watch", CH_ROLL = "rollcall", CH_INFO = "info";
    static final int N_WATCH = 1, N_ROLL = 2, N_INFO = 3;
    static final String ACTION_REFRESH = "uk.co.eright.door.REFRESH";
    static final long PROBE_MS = 5 * 60_000L;
    static final long AWAY_FIRST_MS = 2 * 60_000L, AWAY_EVERY_MS = 5 * 60_000L, AWAY_GIVE_UP_MS = 4 * 3600_000L;
    static final long CONTINUOUS_MS = 15 * 60_000L;
    static final double RADIUS_M = 150;
    static final long POLL_MS = 60_000L;   // back-up for the live stream: a roll call is never more than a minute late

    private HandlerThread thread;
    private Handler h;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback cb;
    private final Set<Network> wifi = new HashSet<>();
    private volatile Network officeNet;
    private volatile boolean atOffice;
    private long awaySince;
    private boolean pendingIn;
    private volatile boolean running;
    private Thread sse;
    private volatile HttpURLConnection sseConn;
    private volatile String sseBase = "";

    static void start(Context c) {
        if (Prefs.configured(c)) c.startForegroundService(new Intent(c, DoorService.class));
    }
    static void refresh(Context c) {
        if (Prefs.configured(c)) c.startForegroundService(new Intent(c, DoorService.class).setAction(ACTION_REFRESH));
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        createChannels(this);
        startFg(Prefs.get(this, "watch").isEmpty() ? "Starting…" : Prefs.get(this, "watch"));
        thread = new HandlerThread("door");
        thread.start();
        h = new Handler(thread.getLooper());
        long now = System.currentTimeMillis();
        atOffice = Prefs.getBool(this, "atOffice") && now - Prefs.getLong(this, "atOfficeAt") < CONTINUOUS_MS;
        awaySince = Prefs.getLong(this, "awaySince");
        cm = getSystemService(ConnectivityManager.class);
        cb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(final Network n) { h.post(() -> { wifi.add(n); probe(n); }); }
            @Override public void onLost(final Network n) { h.post(() -> { wifi.remove(n); if (n.equals(officeNet)) leftOffice(); }); }
        };
        cm.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), cb);
        running = true;
        sse = new Thread(this::sseLoop, "door-sse");
        sse.start();
        h.postDelayed(tick, 4000);
        h.postDelayed(poll, POLL_MS);
        if (!atOffice && awaySince > 0) h.postDelayed(awayCheck, 30_000);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!Prefs.configured(this)) { stopSelf(); return START_NOT_STICKY; }
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) h.post(this::refreshNow);
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        try { cm.unregisterNetworkCallback(cb); } catch (Exception ignored) { }
        HttpURLConnection c = sseConn;
        if (c != null) c.disconnect();
        thread.quitSafely();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ office detection
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!Prefs.configured(DoorService.this)) { stopSelf(); return; }
            if (wifi.isEmpty()) { if (atOffice) leftOffice(); }
            else for (Network n : new ArrayList<>(wifi)) probe(n);
            h.postDelayed(this, PROBE_MS);
        }
    };

    private void probe(Network n) {
        if (!Prefs.configured(this)) return;
        String server = Prefs.server(this);
        try {
            // 1. keyless: is this really our register? (the key is never sent to an impostor at the same address)
            JSONObject who = Api.call(server, "GET", "/api/me", "", null, n);
            String company = Prefs.get(this, "company");
            if (!company.isEmpty() && !company.equals(who.optString("companyName"))) { if (n.equals(officeNet)) leftOffice(); return; }
            // 2. with the key
            JSONObject me = Api.call(server, "GET", "/api/me", Prefs.key(this), null, n);
            // Through the public name (signin.eright.co.uk) the register answers from anywhere, e.g. home Wi-Fi: that is
            // not the office. Only an answer the register itself marks as not-from-outside counts as being here.
            if (me.optBoolean("public")) {
                Log.i(TAG, "probe: register answered on " + n + " but from outside, so not the office");
                if (n.equals(officeNet)) leftOffice();
                return;
            }
            JSONObject person = me.optJSONObject("person");
            if (person == null) {
                Prefs.put(this, "problem", "This phone's key is no longer valid (a new I'm SAFE link was issued). Open the new link on this phone to set the app up again.");
                updateWatch("Needs setting up again");
                if (n.equals(officeNet)) leftOffice();
                return;
            }
            Prefs.put(this, "problem", "");
            Log.i(TAG, "probe: office register answered on " + n + ", arrived=" + !atOffice);
            onOffice(n, me);
        } catch (Exception e) {
            Log.i(TAG, "probe: no office register on " + n + " (" + e.getClass().getSimpleName() + ")");
            if (n.equals(officeNet)) leftOffice();
        }
    }

    private void onOffice(Network n, JSONObject me) {
        boolean arrived = !atOffice;
        atOffice = true;
        officeNet = n;
        awaySince = 0;
        h.removeCallbacks(awayCheck);
        Prefs.putBool(this, "atOffice", true);
        Prefs.putLong(this, "atOfficeAt", System.currentTimeMillis());
        Prefs.putLong(this, "awaySince", 0);
        Prefs.put(this, "outsideUrl", me.isNull("outsideUrl") ? "" : me.optString("outsideUrl", ""));
        JSONObject p = me.optJSONObject("person");
        boolean signedIn = p.optBoolean("signedIn");
        String since = p.isNull("since") ? "" : p.optString("since", "");
        if (arrived) pendingIn = !signedIn;
        if (pendingIn && !signedIn) {
            try {
                JSONObject body = new JSONObject().put("direction", "in").put("reason", "wifi-joined");
                JSONObject r = Api.call(Prefs.server(this), "POST", "/api/me/sign", Prefs.key(this), body, n);
                pendingIn = false;
                signedIn = r.optBoolean("signedIn");
                since = r.isNull("since") ? "" : r.optString("since", "");
                Log.i(TAG, "sign in (wifi-joined): changed=" + r.optBoolean("changed"));
                if (r.optBoolean("changed")) info("✓ Signed IN at " + Api.hhmm(since), "You joined the office Wi-Fi. Have a good day!");
            } catch (Exception e) { /* tried again on the next probe while pendingIn */ }
        } else pendingIn = false;
        Prefs.putBool(this, "signedIn", signedIn);
        Prefs.put(this, "since", since);
        updateWatch(signedIn ? "At the office · signed in since " + Api.hhmm(since) : "At the office · signed out");
        learnOffice();
        handleRollcall(me);
        if (arrived) kickStream();
    }

    private void leftOffice() {
        if (!atOffice) return;
        atOffice = false;
        officeNet = null;
        pendingIn = false;
        awaySince = System.currentTimeMillis();
        Log.i(TAG, "left the office network; signedIn=" + Prefs.getBool(this, "signedIn"));
        Prefs.putBool(this, "atOffice", false);
        Prefs.putLong(this, "awaySince", awaySince);
        updateWatch(Prefs.getBool(this, "signedIn") ? "Off the office Wi-Fi · checking distance" : "Away from the office");
        h.removeCallbacks(awayCheck);
        if (Prefs.getBool(this, "signedIn")) h.postDelayed(awayCheck, AWAY_FIRST_MS);
        kickStream();
    }

    // ------------------------------------------------------------------ away: sign out only when clearly gone
    private final Runnable awayCheck = new Runnable() {
        @Override public void run() {
            if (atOffice || awaySince == 0) return;
            if (System.currentTimeMillis() - awaySince > AWAY_GIVE_UP_MS) {
                awaySince = 0;
                Prefs.putLong(DoorService.this, "awaySince", 0);
                updateWatch("Away · still signed in on the register (sign out at the door or in the app)");
                return;
            }
            if (!Prefs.officeKnown(DoorService.this)) {
                updateWatch("Away · office location not learned yet, so not signing out automatically");
                return;
            }
            fix(loc -> afterFix(loc));
        }
    };

    private void afterFix(Location loc) {
        if (atOffice || awaySince == 0) return;
        if (loc == null) { updateWatch("Off the office Wi-Fi · no location fix yet"); h.postDelayed(awayCheck, AWAY_EVERY_MS); return; }
        float[] d = new float[1];
        Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), Prefs.officeLat(this), Prefs.officeLon(this), d);
        float sure = d[0] - loc.getAccuracy() - Prefs.officeAcc(this);
        Log.i(TAG, "away check: " + Math.round(d[0]) + " m from office, fix " + loc.getProvider() + " ±" + Math.round(loc.getAccuracy()) + " m, sure=" + Math.round(sure) + " m (needs > " + Math.round(RADIUS_M) + ")");
        if (sure > RADIUS_M) { signOutAway(); return; }
        updateWatch("Off the office Wi-Fi · " + Math.round(d[0]) + " m from the office");
        h.postDelayed(awayCheck, AWAY_EVERY_MS);
    }

    private void signOutAway() {
        JSONObject body;
        try { body = new JSONObject().put("direction", "out").put("reason", "left-area"); } catch (Exception e) { return; }
        for (String base : bases()) {
            try {
                JSONObject r = Api.call(base, "POST", "/api/me/sign", Prefs.key(this), body, null);
                Log.i(TAG, "sign out (left-area) via " + base + ": changed=" + r.optBoolean("changed"));
                awaySince = 0;
                Prefs.putLong(this, "awaySince", 0);
                Prefs.putBool(this, "signedIn", false);
                Prefs.put(this, "since", "");
                if (r.optBoolean("changed")) info("✓ Signed OUT at " + Api.now(), "You left the office. Safe journey!");
                updateWatch("Away · signed out");
                return;
            } catch (Api.HttpError e) {
                if (e.status == 401 || e.status == 403) continue;
            } catch (Exception ignored) { }
        }
        updateWatch(Prefs.outsideUrl(this).isEmpty()
                ? "Away · can't reach the register off the office Wi-Fi (works once signin.eright.co.uk is live)"
                : "Away · register not reachable right now, will try again");
        h.postDelayed(awayCheck, AWAY_EVERY_MS);
    }

    /** Where the register can be reached from here: the office address, then the https public name if there is one. */
    private ArrayList<String> bases() {
        ArrayList<String> b = new ArrayList<>();
        b.add(Prefs.server(this));
        String out = Prefs.outsideUrl(this);
        if (out.startsWith("https://") && !out.equals(Prefs.server(this))) b.add(out);
        return b;
    }

    // ------------------------------------------------------------------ location (stays on the phone)
    interface Fix { void got(Location loc); }

    /**
     * Ask every usable provider at once (GPS, network, fused) and keep the most accurate fresh answer: phones differ a
     * lot (a moto g13's framework "fused" provider answers ±100 m indoors while its GPS has ±10 m and network ±18 m).
     */
    private void fix(final Fix done) {
        boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!fine && !coarse) { done.got(null); return; }
        final LocationManager lm = getSystemService(LocationManager.class);
        final ArrayList<String> providers = new ArrayList<>();
        if (fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) providers.add(LocationManager.GPS_PROVIDER);
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) providers.add(LocationManager.NETWORK_PROVIDER);
        if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER) && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) providers.add(LocationManager.FUSED_PROVIDER);
        if (providers.isEmpty()) { done.got(null); return; }
        final Location[] best = { null };
        final int[] pending = { providers.size() };
        final boolean[] answered = { false };
        final Runnable finish = () -> { if (answered[0]) return; answered[0] = true; done.got(best[0]); };
        final Fix collect = loc -> {
            long ageMs = loc == null ? Long.MAX_VALUE : (android.os.SystemClock.elapsedRealtimeNanos() - loc.getElapsedRealtimeNanos()) / 1_000_000L;
            if (loc != null && ageMs < 120_000 && (best[0] == null || loc.getAccuracy() < best[0].getAccuracy())) best[0] = loc;
            if (--pending[0] <= 0) finish.run();
        };
        h.postDelayed(finish, 40_000);
        for (final String provider : providers) {
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    lm.getCurrentLocation(provider, null, h::post, collect::got);
                } else {
                    lm.requestSingleUpdate(provider, new LocationListener() {
                        @Override public void onLocationChanged(Location loc) { collect.got(loc); }
                        @Override public void onStatusChanged(String p, int s, Bundle b) { }
                        @Override public void onProviderEnabled(String p) { }
                        @Override public void onProviderDisabled(String p) { collect.got(null); }
                    }, thread.getLooper());
                }
            } catch (SecurityException e) {
                collect.got(null);
            }
        }
    }

    private void learnOffice() {
        if (Prefs.officeN(this) >= 10) return;
        fix(loc -> { Log.i(TAG, "learn office: " + (loc == null ? "no fix" : loc.getProvider() + " ±" + Math.round(loc.getAccuracy()) + " m") + ", have " + Prefs.officeN(this)); if (loc != null && atOffice && loc.getAccuracy() <= 75) Prefs.addOfficeFix(this, loc.getLatitude(), loc.getLongitude(), loc.getAccuracy()); });
    }

    // ------------------------------------------------------------------ roll call
    private final Runnable poll = new Runnable() {
        @Override public void run() { refreshNow(0); h.postDelayed(this, POLL_MS); }
    };

    private void refreshNow() { refreshNow(0); }

    /** Ask the register for this person's state; on failure try again after 2 s and 5 s. */
    private void refreshNow(final int attempt) {
        Network net = atOffice ? officeNet : null;
        for (String base : atOffice ? java.util.Collections.singletonList(Prefs.server(this)) : bases()) {
            try {
                JSONObject me = Api.call(base, "GET", "/api/me", Prefs.key(this), null, net);
                JSONObject p = me.optJSONObject("person");
                if (p != null) {
                    boolean in = p.optBoolean("signedIn");
                    String since = p.isNull("since") ? "" : p.optString("since", "");
                    Prefs.putBool(this, "signedIn", in);
                    Prefs.put(this, "since", since);
                    if (atOffice) updateWatch(in ? "At the office · signed in since " + Api.hhmm(since) : "At the office · signed out");
                }
                handleRollcall(me);
                return;
            } catch (Exception e) {
                Log.i(TAG, "refresh failed (attempt " + (attempt + 1) + "): " + e.getClass().getSimpleName());
            }
        }
        if (attempt < 2) h.postDelayed(() -> refreshNow(attempt + 1), attempt == 0 ? 2000 : 5000);
    }

    private void handleRollcall(JSONObject me) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        JSONObject rc = me.optJSONObject("rollcall");
        if (rc == null) {
            if (!Prefs.get(this, "rcId").isEmpty()) { nm.cancel(N_ROLL); Prefs.put(this, "rcId", ""); Prefs.put(this, "rcMark", ""); }
            return;
        }
        String id = rc.optString("id");
        String mark = rc.isNull("mark") ? "" : rc.optString("mark", "");
        boolean onRegister = rc.optBoolean("onRegister");
        boolean drill = rc.optBoolean("drill");
        Prefs.put(this, "rcId", id);
        Prefs.put(this, "rcStarted", rc.optString("startedAt"));
        Prefs.putBool(this, "rcDrill", drill);
        Prefs.putBool(this, "rcOnRegister", onRegister);
        Prefs.put(this, "rcMark", mark);
        if ("safe".equals(mark)) { notifySafe(this, drill); return; }
        if (id.equals(Prefs.get(this, "rcAlerted"))) return;
        Prefs.put(this, "rcAlerted", id);
        Log.i(TAG, "roll call " + id + " onRegister=" + onRegister + " drill=" + drill);
        if (onRegister) alarm(this, drill, rc.optString("startedAt"), false);
        else {
            Notification.Builder b = new Notification.Builder(this, CH_ROLL)
                    .setSmallIcon(R.drawable.ic_notify).setCategory(Notification.CATEGORY_ALARM)
                    .setContentTitle(drill ? "Fire DRILL running" : "FIRE ROLL CALL running")
                    .setContentText("You were not signed in, so you are not on its register. If you are on site, tell the person running it.")
                    .setStyle(new Notification.BigTextStyle().bigText("You were not signed in, so you are not on its register. If you are on site, tell the person running it."))
                    .setContentIntent(openApp(this)).setAutoCancel(true);
            nm.notify(N_ROLL, b.build());
        }
    }

    static void alarm(Context c, boolean drill, String startedAt, boolean test) {
        Intent full = new Intent(c, AlarmActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("test", test);
        PendingIntent fullPi = PendingIntent.getActivity(c, test ? 11 : 10, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent safePi = PendingIntent.getBroadcast(c, 12, new Intent(c, SafeReceiver.class).putExtra("test", test), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = (test ? "TEST · " : "") + (drill ? "🟠 FIRE DRILL" : "🔥 FIRE ROLL CALL");
        String text = "Started " + Api.hhmm(startedAt) + ". Go to the assembly point, then tap I'M SAFE.";
        Notification.Builder b = new Notification.Builder(c, CH_ROLL)
                .setSmallIcon(R.drawable.ic_notify).setCategory(Notification.CATEGORY_ALARM)
                .setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
                .setColor(0xFFFF5566).setOngoing(!test).setAutoCancel(test)
                .setFullScreenIntent(fullPi, true).setContentIntent(fullPi)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(null, "I'M SAFE", safePi).build());
        c.getSystemService(NotificationManager.class).notify(N_ROLL, b.build());
    }

    static void notifySafe(Context c, boolean drill) {
        Notification.Builder b = new Notification.Builder(c, CH_INFO)
                .setSmallIcon(R.drawable.ic_notify).setContentTitle("✓ You are marked SAFE")
                .setContentText(drill ? "Fire drill · thank you" : "Fire roll call · thank you")
                .setContentIntent(openApp(c)).setOnlyAlertOnce(true);
        c.getSystemService(NotificationManager.class).notify(N_ROLL, b.build());
    }

    /** "I'M SAFE" from the alarm screen or the notification button. Returns a line to show the person. */
    static String markSafe(Context c) {
        String id = Prefs.get(c, "rcId");
        if (id.isEmpty()) return "No roll call is running.";
        JSONObject body;
        try { body = new JSONObject().put("status", "safe").put("via", "self").put("rollcallId", id); } catch (Exception e) { return "Could not send."; }
        ArrayList<String> bases = new ArrayList<>();
        bases.add(Prefs.server(c));
        String out = Prefs.outsideUrl(c);
        if (out.startsWith("https://")) bases.add(out);
        String last = "Could not reach the register. Tell the person running the roll call in person.";
        for (String base : bases) {
            try {
                Api.call(base, "POST", "/api/fire/mark", Prefs.key(c), body, null);
                Prefs.put(c, "rcMark", "safe");
                notifySafe(c, Prefs.getBool(c, "rcDrill"));
                return "✓ You are marked SAFE at " + Api.now() + ".";
            } catch (Api.HttpError e) {
                last = e.getMessage();
            } catch (Exception ignored) { }
        }
        return last;
    }

    // ------------------------------------------------------------------ live stream (instant roll-call alarm)
    private void kickStream() {
        HttpURLConnection c = sseConn;
        if (c != null) c.disconnect();
    }

    private final Runnable refreshRun = this::refreshNow;

    private void sseLoop() {
        long backoff = 3000;
        while (running) {
            String base = atOffice ? Prefs.server(this) : (Prefs.outsideUrl(this).startsWith("https://") ? Prefs.outsideUrl(this) : "");
            Network net = atOffice ? officeNet : null;
            if (base.isEmpty() || !Prefs.configured(this)) { sleep(20_000); continue; }
            try {
                HttpURLConnection c = Api.open(base, "/api/stream", Prefs.key(this), net, 60_000);
                c.setRequestProperty("Accept", "text/event-stream");
                sseConn = c;
                sseBase = base;
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                Log.i(TAG, "stream: connected to " + base + (net != null ? " on " + net : ""));
                h.post(refreshRun);
                backoff = 3000;
                String line;
                while (running && (line = r.readLine()) != null) {
                    if (line.startsWith("event: change")) { Log.i(TAG, "stream: change"); h.removeCallbacks(refreshRun); h.postDelayed(refreshRun, 250); }
                }
            } catch (Exception e) {
                Log.i(TAG, "stream: closed (" + e.getClass().getSimpleName() + ")");
            } finally {
                HttpURLConnection c = sseConn;
                if (c != null) c.disconnect();
                sseConn = null;
                sseBase = "";
            }
            sleep(backoff);
            backoff = Math.min(backoff * 2, 60_000);
        }
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    // ------------------------------------------------------------------ notifications
    static void createChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel watch = new NotificationChannel(CH_WATCH, "Office watch", NotificationManager.IMPORTANCE_LOW);
        watch.setDescription("Shows that the app is watching for the office Wi-Fi");
        watch.setShowBadge(false);
        NotificationChannel roll = new NotificationChannel(CH_ROLL, "Fire roll call", NotificationManager.IMPORTANCE_HIGH);
        roll.setDescription("The fire roll-call alarm");
        roll.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        roll.enableVibration(true);
        roll.setVibrationPattern(new long[] { 0, 600, 300, 600, 300, 1200 });
        roll.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        roll.setBypassDnd(true);
        NotificationChannel info = new NotificationChannel(CH_INFO, "Signed in / out", NotificationManager.IMPORTANCE_DEFAULT);
        info.setDescription("A note each time the app signs you in or out");
        nm.createNotificationChannel(watch);
        nm.createNotificationChannel(roll);
        nm.createNotificationChannel(info);
    }

    static PendingIntent openApp(Context c) {
        return PendingIntent.getActivity(c, 1, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification watchNotification(String text) {
        String name = Prefs.name(this);
        return new Notification.Builder(this, CH_WATCH)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("eRIGHT Door" + (name.isEmpty() ? "" : " · " + name))
                .setContentText(text)
                .setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
                .setContentIntent(openApp(this)).build();
    }

    private void startFg(String text) {
        Notification n = watchNotification(text);
        if (Build.VERSION.SDK_INT >= 34) startForeground(N_WATCH, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(N_WATCH, n);
    }

    private void updateWatch(String text) {
        Prefs.put(this, "watch", text);
        Prefs.putLong(this, "watchAt", System.currentTimeMillis());
        getSystemService(NotificationManager.class).notify(N_WATCH, watchNotification(text));
    }

    private void info(String title, String text) {
        Notification n = new Notification.Builder(this, CH_INFO)
                .setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setContentText(text)
                .setContentIntent(openApp(this)).setAutoCancel(true).build();
        getSystemService(NotificationManager.class).notify(N_INFO, n);
    }
}
