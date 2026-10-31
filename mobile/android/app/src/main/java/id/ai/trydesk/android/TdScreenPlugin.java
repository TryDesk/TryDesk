package id.ai.trydesk.android;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Full screen while a remote PC is on screen: Android's status and navigation bars hidden (a swipe from the edge
// shows them for a moment) and the phone held in landscape, so the PC picture fills the display. Called from
// mobile.js with { immersive, orientation: "landscape" | "auto" }; both are undone when the session ends.
@CapacitorPlugin(name = "TdScreen")
public class TdScreenPlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        final boolean immersive = Boolean.TRUE.equals(call.getBoolean("immersive", false));
        final boolean landscape = "landscape".equals(call.getString("orientation", "auto"));
        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
            if (immersive) {
                bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                bars.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                bars.show(WindowInsetsCompat.Type.systemBars());
            }
            activity.setRequestedOrientation(landscape ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            call.resolve();
        });
    }
}
