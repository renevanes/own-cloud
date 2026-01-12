import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Convert Uint8Array to base64 string
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Encrypt a token using AES-GCM with the encryption key
async function encryptToken(token: string, encryptionKey: string): Promise<string> {
  if (!token) return token;
  
  const encoder = new TextEncoder();
  const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));
  
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  
  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const encryptedData = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoder.encode(token)
  );
  
  // Combine IV and encrypted data, then base64 encode
  const combined = new Uint8Array(iv.length + new Uint8Array(encryptedData).length);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);
  
  return "enc:" + uint8ArrayToBase64(combined);
}

// Helper function to get app settings from database
async function getAppSettings(supabase: any, userId: string, keys: string[]): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("setting_key, setting_value")
    .eq("user_id", userId)
    .in("setting_key", keys);

  if (error) {
    console.error("Error fetching app settings:", error);
    return {};
  }

  const settings: Record<string, string> = {};
  data?.forEach((item: { setting_key: string; setting_value: string }) => {
    settings[item.setting_key] = item.setting_value;
  });
  return settings;
}

serve(async (req) => {
  // Log request metadata (safe, no secrets)
  const authHeader = req.headers.get("Authorization");
  const apikeyHeader = req.headers.get("apikey");
  console.log("oauth-callback: Request received", {
    method: req.method,
    hasAuthorization: !!authHeader,
    authStartsWithBearer: authHeader?.startsWith("Bearer "),
    authLength: authHeader?.length,
    hasApiKey: !!apikeyHeader,
  });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify JWT and get authenticated user
    if (!authHeader) {
      console.error("oauth-callback: Missing Authorization header");
      return new Response(
        JSON.stringify({ error: "Unauthorized - missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY");
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Validate encryption key is configured
    if (!encryptionKey) {
      console.error("TOKEN_ENCRYPTION_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Server configuration error - encryption key missing" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the JWT token and get the authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    
    if (authError || !user) {
      console.error("JWT verification failed:", authError?.message);
      return new Response(
        JSON.stringify({ error: "Unauthorized - invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use server-verified user ID, NOT client-supplied
    const userId = user.id;
    console.log("Authenticated user:", userId);

    // Parse request body - userId is intentionally NOT extracted from here
    const { code, provider, redirectUri, permissionLevel = "read_write", service } = await req.json();

    if (!code || !provider || !redirectUri) {
      return new Response(
        JSON.stringify({ error: "Missing required parameters: code, provider, redirectUri" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Input validation: strict provider allowlist
    const allowedProviders = ["microsoft", "google"];
    if (!allowedProviders.includes(provider)) {
      return new Response(
        JSON.stringify({ error: "Invalid provider" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Input validation: permission level
    const allowedPermissions = ["read_only", "read_write"];
    const validPermissionLevel = allowedPermissions.includes(permissionLevel) ? permissionLevel : "read_write";

    // Input validation: code length limit (OAuth codes are typically under 2048 chars)
    if (code.length > 2048) {
      return new Response(
        JSON.stringify({ error: "Invalid authorization code" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get APP_URL from user settings, fallback to env var
    const appSettings = await getAppSettings(supabase, userId, ["APP_URL"]);
    const allowedOrigin = appSettings.APP_URL || Deno.env.get("APP_URL") || "http://localhost:5173";
    
    try {
      const parsedUri = new URL(redirectUri);
      const parsedOrigin = new URL(allowedOrigin);
      if (parsedUri.origin !== parsedOrigin.origin) {
        return new Response(
          JSON.stringify({ error: "Invalid redirect URI. Please configure APP_URL in Settings → Credentials." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid redirect URI format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let tokenData: any;
    let userInfo: any;

    if (provider === "microsoft") {
      // Get credentials from user settings, fallback to env vars
      const msSettings = await getAppSettings(supabase, userId, ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]);
      const clientId = msSettings.MICROSOFT_CLIENT_ID || Deno.env.get("MICROSOFT_CLIENT_ID")!;
      const clientSecret = msSettings.MICROSOFT_CLIENT_SECRET || Deno.env.get("MICROSOFT_CLIENT_SECRET")!;

      if (!clientId || !clientSecret) {
        return new Response(
          JSON.stringify({ error: "Microsoft OAuth credentials not configured. Please add them in Settings → Credentials." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Exchange code for tokens
      const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      tokenData = await tokenResponse.json();
      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      // Get user info from Microsoft Graph
      const graphResponse = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      userInfo = await graphResponse.json();
      console.log("Microsoft user info:", JSON.stringify(userInfo, null, 2));
      
      // Handle error response from Graph API
      if (userInfo.error) {
        console.error("Microsoft Graph API error:", userInfo.error);
        // Try to continue without user info, we can still store the tokens
        userInfo = { displayName: null, mail: null, userPrincipalName: null };
      }

      // Get OneDrive storage info
      let storageUsed = null;
      let storageTotal = null;
      try {
        const driveResponse = await fetch("https://graph.microsoft.com/v1.0/me/drive", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const driveData = await driveResponse.json();
        if (driveData.quota) {
          storageUsed = driveData.quota.used;
          storageTotal = driveData.quota.total;
        }
      } catch (e) {
        console.error("Failed to get drive info:", e);
      }

      // Encrypt tokens before storing
      const encryptedAccessToken = await encryptToken(tokenData.access_token, encryptionKey);
      const encryptedRefreshToken = tokenData.refresh_token 
        ? await encryptToken(tokenData.refresh_token, encryptionKey)
        : null;

      console.log("Tokens encrypted successfully for Microsoft account");

      // Save to database using server-verified userId with encrypted tokens
      const { error: dbError } = await supabase
        .from("connected_accounts")
        .upsert({
          user_id: userId,
          provider: "onedrive",
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
          account_email: userInfo.mail || userInfo.userPrincipalName,
          account_name: userInfo.displayName,
          storage_used: storageUsed,
          storage_total: storageTotal,
          permission_level: validPermissionLevel,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,provider,account_email" });

      if (dbError) throw dbError;
    }

    if (provider === "google") {
      // Get credentials from user settings, fallback to env vars
      const googleSettings = await getAppSettings(supabase, userId, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
      const clientId = googleSettings.GOOGLE_CLIENT_ID || Deno.env.get("GOOGLE_CLIENT_ID")!;
      const clientSecret = googleSettings.GOOGLE_CLIENT_SECRET || Deno.env.get("GOOGLE_CLIENT_SECRET")!;

      if (!clientId || !clientSecret) {
        return new Response(
          JSON.stringify({ error: "Google OAuth credentials not configured. Please add them in Settings → Credentials." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Exchange code for tokens
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenText = await tokenResponse.text();
      let tokenJson: any;
      try {
        tokenJson = JSON.parse(tokenText);
      } catch {
        tokenJson = { raw: tokenText };
      }

      if (!tokenResponse.ok) {
        console.error("Google token exchange failed", {
          status: tokenResponse.status,
          body: tokenJson,
        });
        throw new Error(
          tokenJson?.error_description || tokenJson?.error || `Token exchange failed (${tokenResponse.status})`
        );
      }

      tokenData = tokenJson;

      // Get user info
      const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      const userText = await userResponse.text();
      let userJson: any;
      try {
        userJson = JSON.parse(userText);
      } catch {
        userJson = { raw: userText };
      }

      if (!userResponse.ok) {
        console.error("Google userinfo failed", { status: userResponse.status, body: userJson });
        throw new Error(`Failed to fetch Google user info (${userResponse.status})`);
      }

      userInfo = userJson;

      // Get Drive storage info
      let storageUsed = null;
      let storageTotal = null;
      try {
        const aboutResponse = await fetch(
          "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          }
        );

        if (!aboutResponse.ok) {
          const aboutText = await aboutResponse.text();
          console.error("Google Drive about() failed", {
            status: aboutResponse.status,
            body: aboutText,
          });
        } else {
          const aboutData = await aboutResponse.json();
          if (aboutData.storageQuota) {
            storageUsed = parseInt(aboutData.storageQuota.usage);
            storageTotal = parseInt(aboutData.storageQuota.limit);
          }
        }
      } catch (e) {
        console.error("Failed to get drive info:", e);
      }

      // Encrypt tokens before storing
      const encryptedAccessToken = await encryptToken(tokenData.access_token, encryptionKey);
      const encryptedRefreshToken = tokenData.refresh_token 
        ? await encryptToken(tokenData.refresh_token, encryptionKey)
        : null;

      console.log("Tokens encrypted successfully for Google account, service:", service);

      // Determine provider based on service
      const providerName = service === "gmail" ? "gmail" : "google_drive";

      // Save to database using server-verified userId with encrypted tokens
      const { error: dbError } = await supabase
        .from("connected_accounts")
        .upsert({
          user_id: userId,
          provider: providerName,
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          token_expires_at: tokenData.expires_in 
            ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() 
            : null,
          account_email: userInfo.email,
          account_name: userInfo.name,
          storage_used: service === "gmail" ? null : storageUsed,
          storage_total: service === "gmail" ? null : storageTotal,
          permission_level: validPermissionLevel,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,provider,account_email" });

      if (dbError) throw dbError;
    }

    return new Response(
      JSON.stringify({ success: true, provider }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("OAuth callback error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
