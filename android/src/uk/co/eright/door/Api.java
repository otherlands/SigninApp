package uk.co.eright.door;

import android.net.Network;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Talks to the register. Identity is the personal key in X-Safe-Key; the body never says who. */
final class Api {
    private Api() { }

    static final int TIMEOUT_MS = 6000;

    static final class HttpError extends Exception {
        final int status;
        HttpError(int status, String message) { super(message); this.status = status; }
    }

    static HttpURLConnection open(String base, String path, String key, Network net, int readTimeoutMs) throws Exception {
        URL url = new URL(base + path);
        HttpURLConnection c = (HttpURLConnection) (net != null ? net.openConnection(url) : url.openConnection());
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(readTimeoutMs);
        c.setUseCaches(false);
        c.setRequestProperty("X-Safe-Key", key);
        c.setRequestProperty("X-Device", ("phone:" + Build.MODEL).replaceAll("[^A-Za-z0-9 :._-]", ""));
        return c;
    }

    static JSONObject call(String base, String method, String path, String key, JSONObject body, Network net) throws Exception {
        HttpURLConnection c = open(base, path, key, net, TIMEOUT_MS);
        try {
            c.setRequestMethod(method);
            c.setRequestProperty("Accept", "application/json");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] b = body.toString().getBytes("UTF-8");
                OutputStream o = c.getOutputStream();
                o.write(b);
                o.close();
            }
            int code = c.getResponseCode();
            String text = read(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code >= 400) {
                String msg = "HTTP " + code;
                try { msg = new JSONObject(text).optString("error", msg); } catch (Exception ignored) { }
                throw new HttpError(code, msg);
            }
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            c.disconnect();
        }
    }

    static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    /** "2026-11-06T09:07:12.345Z" -> "09:07" in the phone's time zone. */
    static String hhmm(String iso) {
        if (iso == null || iso.isEmpty()) return "";
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.UK);
            in.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date d = in.parse(iso.substring(0, 19));
            return new SimpleDateFormat("HH:mm", Locale.UK).format(d);
        } catch (Exception e) {
            return "";
        }
    }

    static String now() { return new SimpleDateFormat("HH:mm", Locale.UK).format(new Date()); }
}
