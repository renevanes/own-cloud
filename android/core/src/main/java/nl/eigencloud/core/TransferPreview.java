package nl.eigencloud.core;

import java.util.Arrays;
import java.util.Map;

/** Versioned preview contract shared with src/console/transferPreview.ts and golden fixtures. */
public final class TransferPreview {
    private TransferPreview() {}
    public static Map<String, Object> preview(Map<String, Object> o, boolean ready, long minutes) {
        String step = Json.str(o, "stap");
        String cutover = "terug".equals(step) ? "returning" : "teruggezet".equals(step) ? "source" : Json.listAt(o, "gedaan").contains("wekken") || "klaar".equals(step) ? "destination" : Arrays.asList("overzetten", "mislukt").contains(step) ? "moving" : "source";
        Number verified = Json.num(o, "kopie", "verified"), total = Json.num(o, "kopie", "objects"), done = Json.num(o, "kopie", "done");
        boolean complete = total != null && done != null && verified != null && done.longValue() == total.longValue() && verified.longValue() == total.longValue();
        return Json.obj("contractVersion", 1, "destination", Json.obj("name", o.get("naarNaam"), "monthly", Json.path(o, "bestelling", "monthly")), "estimatedOfflineMinutes", minutes, "ready", ready,
            "cutover", cutover, "integrity", Json.obj("method", "sha256", "objectsVerified", verified == null ? 0 : verified, "objectsTotal", total == null ? Json.path(o, "schatting", "objects") : total, "complete", complete));
    }
}
