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

// Refresh Google access token
async function refreshGoogleToken(
  supabase: any,
  account: any,
  encryptionKey: string
): Promise<string> {
  const refreshToken = await decryptToken(account.refresh_token, encryptionKey);
  
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
    return refreshGoogleToken(supabase, account, encryptionKey);
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

    const { action, accountId, messageId, labelIds, query, pageToken, maxResults = 20 } = await req.json();
    console.log("Gmail browse request:", { action, userId: user.id, accountId, messageId, labelIds, query });

    // Get Gmail connected account - either by accountId or first available
    let accountQuery = supabase
      .from("connected_accounts")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider", "gmail");
    
    if (accountId) {
      accountQuery = accountQuery.eq("id", accountId);
    }
    
    const { data: accounts, error: accountError } = await accountQuery.limit(1);

    if (accountError || !accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({ error: "Gmail not connected. Please connect your Gmail account first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const account = accounts[0];
    const accessToken = await getValidAccessToken(supabase, account, encryptionKey);

    if (action === "list") {
      // List messages with optional label filter
      let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;
      if (labelIds && labelIds.length > 0) {
        url += `&labelIds=${labelIds.join(",")}`;
      }
      if (query) {
        url += `&q=${encodeURIComponent(query)}`;
      }
      if (pageToken) {
        url += `&pageToken=${pageToken}`;
      }

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Gmail API error:", errorData);
        throw new Error(errorData.error?.message || "Failed to fetch messages");
      }

      const data = await response.json();
      
      // Fetch message details for each message
      const messagesWithDetails = await Promise.all(
        (data.messages || []).map(async (msg: { id: string }) => {
          const detailResponse = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          return detailResponse.json();
        })
      );

      return new Response(
        JSON.stringify({ 
          messages: messagesWithDetails, 
          nextPageToken: data.nextPageToken,
          resultSizeEstimate: data.resultSizeEstimate 
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
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
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

    if (action === "labels") {
      // Get all labels
      const response = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fetch labels");
      }

      const data = await response.json();
      return new Response(
        JSON.stringify({ labels: data.labels }),
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
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
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
    console.error("Gmail browse error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
