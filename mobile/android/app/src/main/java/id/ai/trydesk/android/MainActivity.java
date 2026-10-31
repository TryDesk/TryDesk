package id.ai.trydesk.android;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TdScreenPlugin.class);   // full screen + landscape during a session (mobile.js)
        registerPlugin(TdLanPlugin.class);      // connect by IP on the same network (mobile-shim.js lan*)
        super.onCreate(savedInstanceState);
    }
}
