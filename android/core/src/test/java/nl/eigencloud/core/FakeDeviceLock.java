package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Nep-vingerafdruk voor tests (en ConsoleBridgeServer): een AES-sleutel in het geheugen speelt de Android Keystore.
 * Elke {@link #wrap} maakt een nieuwe "sleutel" (alias); {@link #invalidateAll} doet alsof er een vingerafdruk bijkwam.
 */
final class FakeDeviceLock implements DeviceLock {
    private final byte[] hardware = Bytes.random(32);
    private int generation;
    private final Set<String> invalid = new HashSet<>();
    final List<String> released = new ArrayList<>();
    volatile boolean available = true, pin = true, cancelNext;
    volatile String reason;
    volatile int prompts;
    volatile String lastVia, lastConfirm;

    @Override public Map<String, Object> status() {
        return Json.obj("available", available, "biometric", available, "pin", pin, "reason", available ? null : reason == null ? "geen-vinger" : reason);
    }

    @Override public synchronized boolean invalidated(Map<String, Object> wrapped) { return invalid.contains(Json.str(wrapped, "alias")); }

    /** Alsof er een vingerafdruk bijkwam: alle sleutels tot nu toe werken niet meer. */
    synchronized void invalidateAll() { for (int i = 1; i <= generation; i++) invalid.add("nep-" + i); }

    private void prompt() throws IOException {
        prompts++;
        if (!available) throw new Unavailable("Stel eerst een vingerafdruk in op deze telefoon, of kies een wachtwoordzin");
        if (cancelNext) { cancelNext = false; throw new Cancelled("Geannuleerd"); }
    }

    @Override public synchronized Map<String, Object> wrap(byte[] key) throws IOException {
        prompt();
        String alias = "nep-" + (++generation);
        return Json.obj("alias", alias, "key", Bytes.base64(EigenCrypto.seal(hardware, key, alias)), "pin", pin);
    }

    @Override public synchronized byte[] unwrap(Map<String, Object> wrapped, String via) throws IOException {
        String alias = Json.str(wrapped, "alias");
        if (invalid.contains(alias) || released.contains(alias)) throw new Invalidated("Er is een vingerafdruk bijgekomen of je schermvergrendeling is veranderd. Daardoor werkt de sleutel van je kluis niet meer.");
        lastVia = via;
        prompt();
        return EigenCrypto.open(hardware, Bytes.fromBase64(Json.str(wrapped, "key")), alias);
    }

    @Override public void confirm(String title) throws IOException {
        lastConfirm = title;
        prompt();
    }

    @Override public synchronized void release(Map<String, Object> wrapped) { released.add(Json.str(wrapped, "alias")); }
}
