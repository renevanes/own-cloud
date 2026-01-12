import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  console.log("oauth-connect: Request received", {
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
      console.error("oauth-connect: Missing Authorization header");
      return new Response(
        JSON.stringify({ error: "Unauthorized - missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify the JWT token and get the authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    
    if (authError || !user) {
      console.error("JWT verification failed:", authError?.message);
      return new Response(
        JSON.stringify({ error: "Unauthorized - invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Authenticated user for oauth-connect:", user.id);

    const { provider, redirectUri, permissionLevel = "read_write", service } = await req.json();

    // Input validation: strict provider allowlist
    const allowedProviders = ["microsoft", "google"];
    if (!provider || !allowedProviders.includes(provider)) {
      return new Response(
        JSON.stringify({ error: "Invalid provider" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Input validation: permission level
    const allowedPermissions = ["read_only", "read_write"];
    if (!allowedPermissions.includes(permissionLevel)) {
      return new Response(
        JSON.stringify({ error: "Invalid permission level" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Input validation: redirectUri is required and must be valid URL
    if (!redirectUri) {
      return new Response(
        JSON.stringify({ error: "Missing redirectUri parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate redirectUri is a properly formatted URL with allowed protocols
    try {
      const parsedUri = new URL(redirectUri);
      const allowedProtocols = ["http:", "https:"];
      
      if (!allowedProtocols.includes(parsedUri.protocol)) {
        console.error("Invalid protocol in redirect URI:", parsedUri.protocol);
        return new Response(
          JSON.stringify({ error: "Invalid redirect URI protocol" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      // Validate the path is the expected OAuth callback path
      if (!parsedUri.pathname.includes("/oauth/callback")) {
        console.error("Invalid redirect path:", parsedUri.pathname);
        return new Response(
          JSON.stringify({ error: "Invalid redirect URI path - must be /oauth/callback" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      console.log("Validated redirectUri:", { origin: parsedUri.origin, pathname: parsedUri.pathname });
    } catch (urlError) {
      console.error("Failed to parse redirect URI:", urlError);
      return new Response(
        JSON.stringify({ error: "Invalid redirect URI format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (provider === "microsoft") {
      // Get client ID from user settings, fallback to env var
      const msSettings = await getAppSettings(supabase, user.id, ["MICROSOFT_CLIENT_ID"]);
      const clientId = msSettings.MICROSOFT_CLIENT_ID || Deno.env.get("MICROSOFT_CLIENT_ID");
      
      console.log("Microsoft OAuth - clientId exists:", !!clientId, "source:", msSettings.MICROSOFT_CLIENT_ID ? "db" : "env", "permissionLevel:", permissionLevel);
      if (!clientId) {
        console.error("MICROSOFT_CLIENT_ID not found");
        return new Response(
          JSON.stringify({ error: "Microsoft OAuth not configured. Please add credentials in Settings → Credentials." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Build scopes based on permission level
      const baseScopes = [
        "openid",
        "profile",
        "email",
        "offline_access",
        "User.Read",
      ];
      
      const fileScopes = permissionLevel === "read_only"
        ? ["Files.Read", "Files.Read.All"]
        : ["Files.Read", "Files.Read.All", "Files.ReadWrite", "Files.ReadWrite.All"];
      
      const scopes = [...baseScopes, ...fileScopes].join(" ");

      const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("response_mode", "query");
      // Encode permission level in state
      authUrl.searchParams.set("state", `microsoft:${permissionLevel}`);

      return new Response(
        JSON.stringify({ authUrl: authUrl.toString() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (provider === "google") {
      // Get client ID from user settings, fallback to env var
      const googleSettings = await getAppSettings(supabase, user.id, ["GOOGLE_CLIENT_ID"]);
      const clientId = googleSettings.GOOGLE_CLIENT_ID || Deno.env.get("GOOGLE_CLIENT_ID");
      
      console.log("Google OAuth - clientId exists:", !!clientId, "source:", googleSettings.GOOGLE_CLIENT_ID ? "db" : "env", "permissionLevel:", permissionLevel);
      if (!clientId) {
        console.error("GOOGLE_CLIENT_ID not found");
        return new Response(
          JSON.stringify({ error: "Google OAuth not configured. Please add credentials in Settings → Credentials." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Build scopes based on permission level and service
      const baseScopes = [
        "openid",
        "email",
        "profile",
      ];
      
      let additionalScopes: string[] = [];
      
      if (service === "gmail") {
        // Gmail scopes
        additionalScopes = [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.labels",
        ];
      } else {
        // Drive scopes
        additionalScopes = permissionLevel === "read_only"
          ? ["https://www.googleapis.com/auth/drive.readonly"]
          : ["https://www.googleapis.com/auth/drive"];
      }
      
      const scopes = [...baseScopes, ...additionalScopes].join(" ");

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "select_account consent");
      // Encode permission level and service in state
      authUrl.searchParams.set("state", `google:${permissionLevel}:${service || "drive"}`);

      return new Response(
        JSON.stringify({ authUrl: authUrl.toString() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid provider" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});