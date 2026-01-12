import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Decrypt token using AES-GCM
async function decryptToken(encryptedToken: string, encryptionKey: string): Promise<string> {
  if (!encryptedToken || !encryptedToken.startsWith("enc:")) return encryptedToken;
  
  const base64Data = encryptedToken.slice(4);
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  const iv = bytes.slice(0, 12);
  const encryptedData = bytes.slice(12);
  
  const encoder = new TextEncoder();
  const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));
  
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  
  const decryptedData = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encryptedData
  );
  
  return new TextDecoder().decode(decryptedData);
}

// Refresh Microsoft access token
async function refreshMicrosoftToken(
  supabase: any,
  account: any,
  encryptionKey: string
): Promise<string> {
  const refreshToken = await decryptToken(account.refresh_token, encryptionKey);
  
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
  
  const data = await response.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  
  // Encrypt and save new token
  const encoder = new TextEncoder();
  const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedData = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoder.encode(data.access_token)
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(encryptedData).length);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);
  let binary = "";
  for (let i = 0; i < combined.length; i++) {
    binary += String.fromCharCode(combined[i]);
  }
  const encryptedAccessToken = "enc:" + btoa(binary);
  
  await supabase
    .from("connected_accounts")
    .update({
      access_token: encryptedAccessToken,
      token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);
  
  return data.access_token;
}

// Get valid access token (refresh if needed)
async function getValidAccessToken(
  supabase: any,
  account: any,
  encryptionKey: string
): Promise<string> {
  const expiresAt = new Date(account.token_expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
  
  if (expiresAt.getTime() - now.getTime() < bufferMs && account.refresh_token) {
    console.log("Token expired or expiring soon, refreshing...");
    return refreshMicrosoftToken(supabase, account, encryptionKey);
  }
  
  return decryptToken(account.access_token, encryptionKey);
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

    const { action, accountId, messageId, folderId, query, pageToken, maxResults = 20 } = await req.json();
    console.log("Outlook browse request:", { action, userId: user.id, accountId, messageId, folderId, query });

    // Get Outlook connected account - either by accountId or first available
    let accountQuery = supabase
      .from("connected_accounts")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider", "outlook");
    
    if (accountId) {
      accountQuery = accountQuery.eq("id", accountId);
    }
    
    const { data: accounts, error: accountError } = await accountQuery.limit(1);

    if (accountError || !accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({ error: "Outlook not connected. Please connect your Outlook account first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const account = accounts[0];
    const accessToken = await getValidAccessToken(supabase, account, encryptionKey);

    if (action === "list") {
      // List messages with optional folder filter
      let url = `https://graph.microsoft.com/v1.0/me/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview`;
      
      if (folderId) {
        url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview`;
      }
      
      if (query) {
        url += `&$search="${encodeURIComponent(query)}"`;
      }
      
      if (pageToken) {
        url = pageToken; // Microsoft uses full URL as next page token
      }

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Outlook API error:", errorData);
        throw new Error(errorData.error?.message || "Failed to fetch messages");
      }

      const data = await response.json();
      
      return new Response(
        JSON.stringify({ 
          messages: data.value || [],
          nextPageToken: data["@odata.nextLink"] || null
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "get") {
      // Get full message content
      if (!messageId) {
        return new Response(
          JSON.stringify({ error: "messageId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fetch message");
      }

      const message = await response.json();
      return new Response(
        JSON.stringify({ message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "folders") {
      // Get all mail folders
      const response = await fetch(
        "https://graph.microsoft.com/v1.0/me/mailFolders?$top=100",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fetch folders");
      }

      const data = await response.json();
      return new Response(
        JSON.stringify({ folders: data.value }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "attachment") {
      // Get attachment
      const { attachmentId } = await req.json();
      if (!messageId || !attachmentId) {
        return new Response(
          JSON.stringify({ error: "messageId and attachmentId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments/${attachmentId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fetch attachment");
      }

      const attachment = await response.json();
      return new Response(
        JSON.stringify({ attachment }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Outlook browse error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
