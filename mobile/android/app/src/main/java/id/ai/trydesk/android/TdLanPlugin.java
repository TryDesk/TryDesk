package id.ai.trydesk.android;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// "Sambung lewat IP" on the phone: a plain TCP socket to a TryDesk PC on the same network, one JSON message per line
// (the same thing main.js does on the desktop). The WebView can't do this itself: the page is https and the PC's
// port is not, so the browser would block it as mixed content. This only carries lines; app.js speaks the protocol.
// Events: "lan" { id, kind: "line", line } and { id, kind: "close" }.
@CapacitorPlugin(name = "TdLan")
public class TdLanPlugin extends Plugin {
    private static final int MAX_LINE = 64 * 1024;
    private final Map<String, Socket> sockets = new ConcurrentHashMap<>();
    // One single-thread queue per socket for writes and the close, so messages leave in the order they were sent
    // (a "disconnect" followed by close must not lose the disconnect).
    private final Map<String, ExecutorService> writers = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newCachedThreadPool();

    @PluginMethod
    public void open(PluginCall call) {
        final String id = call.getString("id", "");
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 7171);
        io.execute(() -> {
            Socket old = sockets.remove(id);
            if (old != null) try { old.close(); } catch (Exception ignored) {}
            Socket s = new Socket();
            try {
                InetAddress addr = InetAddress.getByName(host);
                // Same rule as the desktop: only addresses on the local network.
                if (!isLocal(addr)) { call.reject("Hanya alamat jaringan lokal (LAN) yang bisa dipakai"); return; }
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                s.connect(new InetSocketAddress(addr, port), 6000);
            } catch (java.net.UnknownHostException e) {
                call.reject("Nama PC tidak ditemukan di jaringan"); return;
            } catch (java.net.ConnectException e) {
                call.reject("PC tujuan tidak menerima koneksi LAN (belum diaktifkan di Pengaturan, atau diblokir firewall)"); return;
            } catch (java.net.SocketTimeoutException e) {
                call.reject("Tidak ada TryDesk yang menjawab di alamat ini"); return;
            } catch (Exception e) {
                call.reject("Tidak bisa terhubung ke alamat ini"); return;
            }
            sockets.put(id, s);
            ExecutorService oldW = writers.put(id, Executors.newSingleThreadExecutor());
            if (oldW != null) oldW.shutdown();
            JSObject ok = new JSObject(); ok.put("ok", true); ok.put("id", id);
            call.resolve(ok);
            read(id, s);
        });
    }

    private void read(String id, Socket s) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder line = new StringBuilder();
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\n') {
                    JSObject ev = new JSObject(); ev.put("id", id); ev.put("kind", "line"); ev.put("line", line.toString());
                    notifyListeners("lan", ev);
                    line.setLength(0);
                } else if (line.length() < MAX_LINE) {
                    line.append((char) c);
                } else {
                    break;   // an endless line: drop the connection
                }
            }
        } catch (Exception ignored) {
        } finally {
            try { s.close(); } catch (Exception ignored) {}
            ExecutorService w = writers.get(id);
            if (sockets.remove(id, s)) {
                if (w != null && writers.remove(id, w)) w.shutdown();
                JSObject ev = new JSObject(); ev.put("id", id); ev.put("kind", "close");
                notifyListeners("lan", ev);
            }
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        final String id = call.getString("id", "");
        final Socket s = sockets.get(id);
        final ExecutorService w = writers.get(id);
        final String line = call.getString("line", "");
        if (s == null || w == null) { call.resolve(); return; }
        try {
            w.execute(() -> {
                try {
                    OutputStream out = s.getOutputStream();
                    synchronized (s) { out.write((line + "\n").getBytes(StandardCharsets.UTF_8)); out.flush(); }
                } catch (Exception e) { try { s.close(); } catch (Exception ignored) {} }
                call.resolve();
            });
        } catch (java.util.concurrent.RejectedExecutionException e) { call.resolve(); }   // the socket already closed
    }

    @PluginMethod
    public void close(PluginCall call) {
        final String id = call.getString("id", "");
        final Socket s = sockets.get(id);
        final ExecutorService w = writers.get(id);
        if (s != null) try { (w != null ? w : io).execute(() -> { try { s.shutdownOutput(); Thread.sleep(500); } catch (Exception ignored) {} try { s.close(); } catch (Exception ignored) {} }); } catch (java.util.concurrent.RejectedExecutionException e) { try { s.close(); } catch (Exception ignored) {} }
        call.resolve();
    }

    // 10/8, 172.16/12, 192.168/16, loopback, link-local, 100.64/10 (CGNAT VPNs), IPv6 ULA / link-local.
    private static boolean isLocal(InetAddress a) {
        if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress()) return true;
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) return (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64;
        if (a instanceof Inet6Address) return (b[0] & 0xfe) == 0xfc;
        return false;
    }
}
