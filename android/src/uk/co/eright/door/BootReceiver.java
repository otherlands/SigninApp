package uk.co.eright.door;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart or an app update, start watching again (only if the phone has been set up). */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent intent) {
        DoorService.start(c);
    }
}
