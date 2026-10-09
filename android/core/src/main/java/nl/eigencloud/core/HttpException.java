package nl.eigencloud.core;

import java.io.IOException;

/** An HTTP request that returned an unexpected status. The message matches the TS error text. */
public class HttpException extends IOException {
    private static final long serialVersionUID = 1L;
    public final int status;
    public final String body;

    public HttpException(String message, int status, String body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
