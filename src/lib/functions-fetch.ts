/**
 * Direct fetch wrapper for Supabase Edge Functions.
 * Bypasses supabase.functions.invoke to get full control over headers
 * and capture complete error responses from the gateway.
 */

interface InvokeFunctionOptions {
  body?: Record<string, unknown>;
  accessToken: string;
}

interface InvokeFunctionResult<T = unknown> {
  data: T | null;
  error: Error | null;
}

export async function invokeFunction<T = unknown>(
  functionName: string,
  options: InvokeFunctionOptions
): Promise<InvokeFunctionResult<T>> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl) {
    return { data: null, error: new Error("Missing VITE_SUPABASE_URL") };
  }
  if (!apiKey) {
    return { data: null, error: new Error("Missing VITE_SUPABASE_PUBLISHABLE_KEY") };
  }
  if (!options.accessToken) {
    return { data: null, error: new Error("Missing access token") };
  }

  const url = `${supabaseUrl}/functions/v1/${functionName}`;

  // Log what we're about to send (no secrets)
  console.log(`${functionName}: invoking`, {
    url,
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey.length,
    hasAccessToken: !!options.accessToken,
    accessTokenLength: options.accessToken.length,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": apiKey,
        "Authorization": `Bearer ${options.accessToken}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const responseText = await response.text();

    if (!response.ok) {
      // Log full gateway error for debugging
      console.error(`${functionName}: gateway error`, {
        status: response.status,
        statusText: response.statusText,
        responseBody: responseText,
      });
      return {
        data: null,
        error: new Error(`${functionName} failed (${response.status}): ${responseText}`),
      };
    }

    // Try to parse as JSON
    let data: T;
    try {
      data = JSON.parse(responseText);
    } catch {
      // If not JSON, return as-is in a wrapper
      data = { raw: responseText } as T;
    }

    return { data, error: null };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`${functionName}: network error`, error.message);
    return { data: null, error };
  }
}
