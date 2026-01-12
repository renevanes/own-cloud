import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Decrypt token
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function decryptToken(encryptedToken: string, encryptionKey: string): Promise<string> {
  if (!encryptedToken || !encryptedToken.startsWith("enc:")) return encryptedToken;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));

  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["decrypt"]);
  const combined = base64ToUint8Array(encryptedToken.slice(4));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decryptedData = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, data);
  return decoder.decode(decryptedData);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { provider, fileId, accountId } = await req.json();

    if (!provider || !fileId) {
      return new Response(JSON.stringify({ error: "Missing provider or fileId" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Get account - use specific accountId if provided, otherwise fall back to most recently added account
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
      return new Response(JSON.stringify({ error: "Account not connected" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const accessToken = await decryptToken(account.access_token, encryptionKey);

    let previewData: { url?: string; thumbnailUrl?: string; name?: string; mimeType?: string; size?: number } = {};

    if (provider === "onedrive") {
      // Get file metadata with thumbnail
      const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}?expand=thumbnails`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        throw new Error(`OneDrive error: ${response.status}`);
      }

      const data = await response.json();
      
      previewData = {
        url: data["@microsoft.graph.downloadUrl"],
        thumbnailUrl: data.thumbnails?.[0]?.large?.url || data.thumbnails?.[0]?.medium?.url,
        name: data.name,
        mimeType: data.file?.mimeType,
        size: data.size,
      };

    } else if (provider === "google_drive") {
      // Get file metadata
      const metaResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,thumbnailLink,webContentLink,webViewLink`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!metaResponse.ok) {
        throw new Error(`Google Drive error: ${metaResponse.status}`);
      }

      const data = await metaResponse.json();
      
      // For Google native formats, use webViewLink
      const isGoogleFormat = data.mimeType?.startsWith("application/vnd.google-apps");
      
      previewData = {
        url: isGoogleFormat ? data.webViewLink : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        thumbnailUrl: data.thumbnailLink?.replace("=s220", "=s400"),
        name: data.name,
        mimeType: data.mimeType,
        size: parseInt(data.size) || 0,
      };
    }

    return new Response(
      JSON.stringify(previewData),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("File preview error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
