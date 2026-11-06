package uk.co.eright.door;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** The register's own /fire page (marshal ticks work on the office network; read-only from outside). */
public class FireActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        WebView web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient());
        String out = Prefs.outsideUrl(this);
        String base = Prefs.getBool(this, "atOffice") || !out.startsWith("https://") ? Prefs.server(this) : out;
        web.loadUrl(base + "/fire");
        setContentView(web);
    }
}
