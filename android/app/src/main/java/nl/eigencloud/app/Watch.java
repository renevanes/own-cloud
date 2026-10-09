package nl.eigencloud.app;

import android.app.Notification;
import android.content.Context;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.Json;

/**
 * Meldingen zonder Google-push: de app kijkt zelf elk kwartier (en bij openen) of er nieuwe mail is en of je
 * cloud gezond is. Daardoor kan een melding tot een kwartier later komen dan bij Gmail.
 */
final class Watch {
    private Watch() {}

    static void mail(Context c, CloudApi api) throws IOException {
        if (!Prefs.flag(c, Prefs.NOTIFY_MAIL)) return;
        Map<String, Object> f = Json.asMap(api.getJson("/api/mail/folders"));
        long unread = 0;
        for (Object x : Json.listAt(f, "folders")) if ("inbox".equals(Json.str(x, "folder"))) unread = Json.num(x, "unread") == null ? 0 : Json.num(x, "unread").longValue();
        long seenTop = Prefs.num(c, "mail.topId");
        List<Object> msgs = Json.asList(api.getJson("/api/mail/messages?folder=inbox&limit=10"));
        long top = seenTop;
        StringBuilder lines = new StringBuilder();
        int fresh = 0;
        String firstFrom = null, firstSubject = null;
        if (msgs != null) {
            for (Object m : msgs) {
                Number id = Json.num(m, "id");
                if (id == null) continue;
                top = Math.max(top, id.longValue());
                if (id.longValue() > seenTop && !Json.truthy(Json.path(m, "is_read"))) {
                    fresh++;
                    String name = Json.str(m, "from_name");
                    String from = name != null && !name.isEmpty() ? name : shortFrom(Json.str(m, "from_addr"));
                    String subject = Json.str(m, "subject");
                    if (firstFrom == null) { firstFrom = from; firstSubject = subject; }
                    if (fresh <= 5) lines.append(from).append(": ").append(subject == null ? "(geen onderwerp)" : subject).append('\n');
                }
            }
        }
        boolean firstRun = seenTop == 0;
        Prefs.setNum(c, "mail.topId", top);
        if (unread == 0) { Notify.cancel(c, Notify.ID_MAIL); return; }
        if (fresh == 0 || firstRun) return; // bij de eerste keer niet je hele inbox melden
        Notification n = Notify.builder(c, Notify.MAIL)
                .setContentTitle(fresh == 1 ? firstFrom : fresh + " nieuwe berichten")
                .setContentText(fresh == 1 ? firstSubject : unread + " ongelezen")
                .setStyle(new Notification.BigTextStyle().bigText(lines.toString().trim()))
                .setNumber((int) unread)
                .setContentIntent(Notify.openApp(c, "#mail", 1))
                .setAutoCancel(true)
                .build();
        Notify.show(c, Notify.ID_MAIL, n);
    }

    private static String shortFrom(String from) {
        if (from == null) return "Onbekend";
        int lt = from.indexOf('<');
        String name = lt > 0 ? from.substring(0, lt).trim().replaceAll("^\"|\"$", "") : from;
        return name.isEmpty() ? from : name;
    }

    static void health(Context c, CloudApi api) throws IOException {
        if (!Prefs.flag(c, Prefs.NOTIFY_HEALTH)) return;
        Map<String, Object> h = Json.asMap(api.getJson("/api/health"));
        String level = Json.str(h, "summary", "level");
        if (level == null) return;
        String before = Prefs.str(c, "health.level");
        Prefs.setStr(c, "health.level", level);
        if (level.equals(before)) return;
        if ("ok".equals(level)) { Notify.cancel(c, Notify.ID_STATUS); return; }
        if (!"fail".equals(level)) return; // aandachtspunten alleen in de app, geen melding
        String first = null;
        for (Object ch : Json.listAt(h, "checks")) if ("fail".equals(Json.str(ch, "status"))) { first = Json.str(ch, "title"); break; }
        Notification n = Notify.builder(c, Notify.STATUS)
                .setContentTitle("Er is iets mis met je cloud")
                .setContentText(first != null ? first : "Bekijk de gezondheid in de app")
                .setContentIntent(Notify.openApp(c, "#instellingen/gezondheid", 2))
                .setAutoCancel(true)
                .build();
        Notify.show(c, Notify.ID_STATUS, n);
    }
}
