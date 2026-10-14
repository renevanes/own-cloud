package nl.eigencloud.core;

import java.io.IOException;
import java.util.Map;

/**
 * The phone's own lock for the vault key: a key in the secure hardware of the phone (Android Keystore) that only works
 * after the owner confirms with a fingerprint (or, from Android 11, the phone's PIN/pattern/password). The Java core
 * never sees that hardware key; it only stores the wrapped vault key ({@link #wrap}) in the vault file under
 * {@code "device"} and asks for it back ({@link #unwrap}). The desktop console has no DeviceLock.
 *
 * <p>Calls may block while the phone shows the fingerprint prompt: call them off the UI thread.
 */
public interface DeviceLock {
    /**
     * What this phone offers, for the screens: {@code {available, biometric, pin, reason}}. {@code available}: a vault
     * can be protected with the device key; {@code biometric}: a strong fingerprint/face is set up (null = unknown);
     * {@code pin}: the phone's PIN/pattern/password works as an alternative; {@code reason} when not available:
     * "android" (too old), "geen-slot" (no screen lock), "geen-vinger" (no fingerprint set up), "hardware".
     */
    Map<String, Object> status();

    /** True when the device key behind {@code wrapped} no longer works (fingerprints changed, key gone). No prompt. */
    boolean invalidated(Map<String, Object> wrapped);

    /**
     * Wraps the 32-byte vault key with a new device key; asks the owner to confirm. Returns what the vault stores
     * (JSON-safe values only). Throws {@link Cancelled}, {@link Unavailable}.
     */
    Map<String, Object> wrap(byte[] key) throws IOException;

    /**
     * Unwraps the vault key; asks for the fingerprint. {@code via} "pin" prefers the phone's PIN (when allowed).
     * Throws {@link Cancelled}, {@link Invalidated}, {@link Unavailable}.
     */
    byte[] unwrap(Map<String, Object> wrapped, String via) throws IOException;

    /** Asks the owner to confirm (fingerprint or PIN) before something sensitive, such as showing a password. */
    void confirm(String title) throws IOException;

    /** Removes device keys that the vault no longer uses (after a new wrap is saved). */
    default void release(Map<String, Object> oldWrapped) {}

    /** The owner stopped the prompt (or pressed the other button). */
    final class Cancelled extends IOException {
        private static final long serialVersionUID = 1L;

        public Cancelled(String message) { super(message); }
    }

    /** The device key does not work any more: a fingerprint was added, the screen lock was removed, or the key is gone. */
    final class Invalidated extends IOException {
        private static final long serialVersionUID = 1L;

        public Invalidated(String message) { super(message); }
    }

    /** This phone cannot do it now (old Android, no screen lock or fingerprint, app not in front). */
    final class Unavailable extends IOException {
        private static final long serialVersionUID = 1L;

        public Unavailable(String message) { super(message); }
    }
}
