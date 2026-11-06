package uk.co.eright.door;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** The "I'M SAFE" button on the roll-call notification. */
public class SafeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        final Context c = ctx.getApplicationContext();
        if (intent.getBooleanExtra("test", false)) {
            c.getSystemService(NotificationManager.class).cancel(DoorService.N_ROLL);
            Toast.makeText(c, "Test only: nothing was sent. In a real roll call this marks you SAFE.", Toast.LENGTH_LONG).show();
            return;
        }
        final PendingResult pr = goAsync();
        new Thread(() -> {
            final String msg = DoorService.markSafe(c);
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> Toast.makeText(c, msg, Toast.LENGTH_LONG).show());
            pr.finish();
        }).start();
    }
}
