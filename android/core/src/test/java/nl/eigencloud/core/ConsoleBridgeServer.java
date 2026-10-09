package nl.eigencloud.core;

import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.util.Map;

/**
 * Hulpmiddel voor browsertests van de telefoonconsole (geen onderdeel van test.sh): serveert de app-assets
 * (www-map) en zet POST /bridge door naar {@link ConsoleApi}, zoals de JavaScript-brug in de app doet.
 *   java … ConsoleBridgeServer <www-map> <poort> <kluis.json>   (MOTO_URL optioneel voor een nep-Hetzner niet nodig)
 */
public class ConsoleBridgeServer {
    public static void main(String[] args) throws Exception {
        File www = new File(args[0]);
        Catalog cat;
        try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { cat = Catalog.load(in); }
        ConsoleApi api = new ConsoleApi(new File(args[2]), cat, url -> System.out.println("cloudReady " + url));
        api.biometric = Json.obj("available", true, "enrolled", false, "auto", false);
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.parseInt(args[1])), 0);
        s.createContext("/", ex -> {
            byte[] out;
            String type;
            int status = 200;
            String path = ex.getRequestURI().getPath();
            if ("POST".equals(ex.getRequestMethod()) && path.equals("/bridge")) {
                Map<String, Object> b = Json.parseObject(Bytes.utf8(Bytes.readAll(ex.getRequestBody())));
                ConsoleApi.Reply r = api.handle(Json.str(b, "method"), Json.str(b, "path"), Json.str(b, "body"));
                out = Bytes.utf8(Json.stringify(Json.obj("status", (long) r.status, "body", r.body)));
                type = "application/json";
            } else {
                File f = new File(www, path.equals("/") ? "index.html" : path.substring(1));
                if (!f.getCanonicalPath().startsWith(www.getCanonicalPath()) || !f.isFile()) { status = 404; out = new byte[0]; type = "text/plain"; }
                else {
                    out = Files.readAllBytes(f.toPath());
                    String n = f.getName();
                    type = n.endsWith(".html") ? "text/html; charset=utf-8" : n.endsWith(".js") ? "text/javascript" : n.endsWith(".css") ? "text/css"
                            : n.endsWith(".woff2") ? "font/woff2" : n.endsWith(".json") ? "application/json" : "application/octet-stream";
                }
            }
            ex.getResponseHeaders().set("content-type", type);
            ex.sendResponseHeaders(status, out.length == 0 ? -1 : out.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(out); }
        });
        s.start();
        System.out.println("bridge http://127.0.0.1:" + args[1]);
    }
}
