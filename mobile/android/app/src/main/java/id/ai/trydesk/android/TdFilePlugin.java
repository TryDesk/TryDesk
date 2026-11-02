package id.ai.trydesk.android;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

// Screenshots (.png) and session recordings (.webm) from the phone, the desktop's "Ambil screenshot" and
// "Rekam sesi". mobile-shim.js maps the desktop's file calls onto this: target() names where the file will land,
// open/write/close stream it into the app's cache, and close() moves it into the gallery: Pictures/TryDesk or
// Movies/TryDesk through MediaStore on Android 10+ (no storage permission needed), or the app's own Pictures /
// Movies folder on older phones. Only a bare file name with one of those two extensions is accepted.
@CapacitorPlugin(name = "TdFile")
public class TdFilePlugin extends Plugin {
    private static class Job { File file; OutputStream out; String name; boolean video; }
    private final Map<String, Job> jobs = new HashMap<>();

    // Partial files left by a recording the app was killed in the middle of.
    @Override
    public void load() {
        File[] old = new File(getContext().getCacheDir(), "exports").listFiles();
        if (old != null) for (File f : old) { //noinspection ResultOfMethodCallIgnored
            f.delete(); }
    }

    private static String safeName(String raw) {
        String s = raw == null ? "" : raw.replace('\\', '/');
        s = s.substring(s.lastIndexOf('/') + 1).replaceAll("[^A-Za-z0-9._-]", "_");
        if (s.length() > 120) s = s.substring(s.length() - 120);
        return (s.endsWith(".png") || s.endsWith(".webm")) && !s.startsWith(".") ? s : "";
    }

    private String shownDir(boolean video) {
        if (Build.VERSION.SDK_INT >= 29) return (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/TryDesk";
        File d = getContext().getExternalFilesDir(video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES);
        return d != null ? d.getAbsolutePath() : "";
    }

    @PluginMethod
    public void target(PluginCall call) {
        String name = safeName(call.getString("name", ""));
        if (name.isEmpty()) { call.reject("unsupported file"); return; }
        JSObject r = new JSObject();
        r.put("path", shownDir(name.endsWith(".webm")) + "/" + name);
        call.resolve(r);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String name = safeName(call.getString("path", ""));
        if (name.isEmpty()) { call.reject("unsupported file"); return; }
        try {
            File dir = new File(getContext().getCacheDir(), "exports");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no cache folder");
            Job j = new Job();
            j.name = name; j.video = name.endsWith(".webm");
            j.file = new File(dir, UUID.randomUUID().toString());
            j.out = new FileOutputStream(j.file);
            String id = UUID.randomUUID().toString();
            synchronized (jobs) { jobs.put(id, j); }
            JSObject r = new JSObject(); r.put("id", id); call.resolve(r);
        } catch (Exception e) { call.reject("could not create the file"); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        Job j; synchronized (jobs) { j = jobs.get(call.getString("id", "")); }
        if (j == null) { call.reject("unknown file"); return; }
        try { j.out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT)); call.resolve(); }
        catch (Exception e) { call.reject("write failed"); }
    }

    @PluginMethod
    public void close(PluginCall call) {
        Job j; synchronized (jobs) { j = jobs.remove(call.getString("id", "")); }
        if (j == null) { call.reject("unknown file"); return; }
        try { j.out.close(); } catch (Exception ignored) {}
        try {
            if (!Boolean.TRUE.equals(call.getBoolean("cancel", false))) publish(j);
            call.resolve();
        } catch (Exception e) { call.reject("could not save to the gallery"); }
        finally { //noinspection ResultOfMethodCallIgnored
            j.file.delete(); }
    }

    private void publish(Job j) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = getContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, j.name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, j.video ? "video/webm" : "image/png");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, shownDir(j.video));
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri coll = j.video ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                               : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri item = cr.insert(coll, v);
            if (item == null) throw new Exception("insert failed");
            try (InputStream in = new FileInputStream(j.file); OutputStream out = cr.openOutputStream(item)) {
                if (out == null) throw new Exception("no output");
                copy(in, out);
            } catch (Exception e) { cr.delete(item, null, null); throw e; }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, v, null, null);
        } else {
            File dir = new File(shownDir(j.video));
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no folder");
            File dest = new File(dir, j.name);
            try (InputStream in = new FileInputStream(j.file); OutputStream out = new FileOutputStream(dest)) { copy(in, out); }
            // Lets gallery apps that scan the app's own media folders find it (Android 7-9).
            MediaScannerConnection.scanFile(getContext(), new String[] { dest.getAbsolutePath() }, null, null);
        }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
}
