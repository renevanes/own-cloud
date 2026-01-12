import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Convert base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Decrypt a token using AES-GCM
async function decryptToken(encryptedToken: string, encryptionKey: string): Promise<string> {
  if (!encryptedToken || !encryptedToken.startsWith("enc:")) {
    return encryptedToken;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const combined = base64ToUint8Array(encryptedToken.slice(4));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decryptedData = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    data
  );

  return decoder.decode(decryptedData);
}

// Refresh Microsoft access token
async function refreshMicrosoftToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number } | null> {
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID")!;
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET")!;

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    console.error("Failed to refresh Microsoft token");
    return null;
  }

  return response.json();
}

// Refresh Google access token
async function refreshGoogleToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    console.error("Failed to refresh Google token");
    return null;
  }

  return response.json();
}

// Convert Uint8Array to base64 string
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Encrypt a token using AES-GCM
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

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedData = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoder.encode(token)
  );

  const combined = new Uint8Array(iv.length + new Uint8Array(encryptedData).length);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);

  return "enc:" + uint8ArrayToBase64(combined);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { provider, folderId, accountId } = await req.json();

    if (!provider || !["onedrive", "google_drive"].includes(provider)) {
      return new Response(
        JSON.stringify({ error: "Invalid provider" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normalize folder id: some clients may send "." for root
    const normalizedFolderId = (typeof folderId === "string" && folderId.trim() !== "" && folderId !== ".")
      ? folderId
      : null;

    // Get connected account - use specific accountId if provided, otherwise fallback to most recently added account
    let accountQuery = supabase
      .from("connected_accounts")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider", provider);

    if (accountId) {
      accountQuery = accountQuery.eq("id", accountId);
    } else {
      accountQuery = accountQuery.order("created_at", { ascending: false }).limit(1);
    }

    const { data: account, error: accountError } = await accountQuery.maybeSingle();

    if (accountError || !account) {
      console.error("Account not found:", { provider, accountId, error: accountError });
      return new Response(
        JSON.stringify({ error: "Account not connected" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    console.log(`Fetching files for account: ${account.account_email || account.id}`);

    let accessToken = await decryptToken(account.access_token, encryptionKey);
    const refreshToken = account.refresh_token 
      ? await decryptToken(account.refresh_token, encryptionKey) 
      : null;

    // Check if token is expired and refresh if needed
    const tokenExpired = account.token_expires_at && new Date(account.token_expires_at) < new Date();
    
    if (tokenExpired && refreshToken) {
      console.log(`Refreshing ${provider} token...`);
      
      if (provider === "onedrive") {
        const newTokens = await refreshMicrosoftToken(refreshToken);
        if (newTokens) {
          accessToken = newTokens.access_token;
          const encryptedAccess = await encryptToken(newTokens.access_token, encryptionKey);
          const encryptedRefresh = newTokens.refresh_token 
            ? await encryptToken(newTokens.refresh_token, encryptionKey)
            : account.refresh_token;
          
          await supabase.from("connected_accounts").update({
            access_token: encryptedAccess,
            refresh_token: encryptedRefresh,
            token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", account.id);
        }
      } else if (provider === "google_drive") {
        const newTokens = await refreshGoogleToken(refreshToken);
        if (newTokens) {
          accessToken = newTokens.access_token;
          const encryptedAccess = await encryptToken(newTokens.access_token, encryptionKey);
          
          await supabase.from("connected_accounts").update({
            access_token: encryptedAccess,
            token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", account.id);
        }
      }
    }

    let files: any[] = [];

    if (provider === "onedrive") {
      const endpoint = normalizedFolderId
        ? `https://graph.microsoft.com/v1.0/me/drive/items/${normalizedFolderId}/children`
        : "https://graph.microsoft.com/v1.0/me/drive/root/children";

      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("OneDrive API error:", errorText);
        throw new Error(`OneDrive API error: ${response.status}`);
      }

      const data = await response.json();
      files = (data.value || []).map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.folder ? "folder" : "file",
        size: item.size,
        mimeType: item.file?.mimeType,
        modifiedAt: item.lastModifiedDateTime,
        path: item.parentReference?.path?.replace("/drive/root:", "") || "/",
      }));
    } else if (provider === "google_drive") {
      const parentId = normalizedFolderId || "root";
      const query = `'${parentId}' in parents and trashed = false`;
      const fields = "files(id,name,mimeType,size,modifiedTime,parents)";
      
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&orderBy=folder,name`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Google Drive API error:", errorText);
        throw new Error(`Google Drive API error: ${response.status}`);
      }

      const data = await response.json();
      files = (data.files || []).map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
        size: parseInt(item.size) || 0,
        mimeType: item.mimeType,
        modifiedAt: item.modifiedTime,
        path: "/",
      }));
    }

    return new Response(
      JSON.stringify({ files }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Browse files error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
