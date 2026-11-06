package uk.co.eright.door;

import android.content.Context;
import android.content.SharedPreferences;

/** Everything the app remembers, in its private storage (never backed up: allowBackup=false). */
final class Prefs {
    private Prefs() { }

    static SharedPreferences of(Context c) { return c.getSharedPreferences("door", Context.MODE_PRIVATE); }

    static String server(Context c) { return of(c).getString("server", ""); }
    static String key(Context c) { return of(c).getString("key", ""); }
    static String name(Context c) { return of(c).getString("name", ""); }
    static String outsideUrl(Context c) { return of(c).getString("outsideUrl", ""); }
    static boolean configured(Context c) { return !server(c).isEmpty() && !key(c).isEmpty(); }

    static void setup(Context c, String server, String key, String name) {
        of(c).edit().putString("server", server).putString("key", key).putString("name", name).apply();
    }
    static void forget(Context c) { of(c).edit().clear().apply(); }

    // ---- learned office location (stays on the phone; never sent anywhere) ----
    static boolean officeKnown(Context c) { return of(c).getInt("officeN", 0) > 0; }
    static double officeLat(Context c) { return Double.longBitsToDouble(of(c).getLong("officeLat", 0)); }
    static double officeLon(Context c) { return Double.longBitsToDouble(of(c).getLong("officeLon", 0)); }
    static int officeN(Context c) { return of(c).getInt("officeN", 0); }
    static float officeAcc(Context c) { return of(c).getFloat("officeAcc", 0); }
    /** Running average of good fixes taken while on the office network (up to 10). */
    static void addOfficeFix(Context c, double lat, double lon, float acc) {
        int n = officeN(c);
        if (n >= 10) return;
        double la = n == 0 ? lat : (officeLat(c) * n + lat) / (n + 1);
        double lo = n == 0 ? lon : (officeLon(c) * n + lon) / (n + 1);
        float best = n == 0 ? acc : Math.min(officeAcc(c), acc);
        of(c).edit().putLong("officeLat", Double.doubleToRawLongBits(la)).putLong("officeLon", Double.doubleToRawLongBits(lo))
                .putInt("officeN", n + 1).putFloat("officeAcc", best).apply();
    }
    static void forgetOffice(Context c) { of(c).edit().remove("officeLat").remove("officeLon").remove("officeN").remove("officeAcc").apply(); }

    // ---- state the service shares with the screen ----
    static void put(Context c, String k, String v) { of(c).edit().putString(k, v).apply(); }
    static String get(Context c, String k) { return of(c).getString(k, ""); }
    static void putLong(Context c, String k, long v) { of(c).edit().putLong(k, v).apply(); }
    static long getLong(Context c, String k) { return of(c).getLong(k, 0); }
    static void putBool(Context c, String k, boolean v) { of(c).edit().putBoolean(k, v).apply(); }
    static boolean getBool(Context c, String k) { return of(c).getBoolean(k, false); }
}
