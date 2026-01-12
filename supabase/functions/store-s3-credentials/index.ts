import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY");

  if (!encryptionKey) {
    console.error("TOKEN_ENCRYPTION_KEY not configured");
    return new Response(
      JSON.stringify({ error: "Server configuration error - encryption key missing" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Verify JWT and get user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      console.error("Auth error:", authError);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { accessKeyId, secretAccessKey, region, bucketName, accountName } = await req.json();

    // Validate required fields
    if (!accessKeyId || !secretAccessKey || !region || !bucketName) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Storing encrypted S3 credentials for user ${user.id}, bucket: ${bucketName}`);

    // Encrypt the credentials
    const encryptedAccessKey = await encryptToken(accessKeyId, encryptionKey);
    const encryptedSecretKey = await encryptToken(secretAccessKey, encryptionKey);

    // Store the encrypted credentials
    const { data, error } = await supabase
      .from("connected_accounts")
      .insert({
        user_id: user.id,
        provider: "aws_s3",
        access_token: encryptedAccessKey,
        refresh_token: encryptedSecretKey,
        account_name: accountName || bucketName,
        account_email: `${bucketName}@${region}`,
        account_id: `${bucketName}-${Date.now()}`,
        permission_level: "read_write",
      })
      .select()
      .single();

    if (error) {
      console.error("Database error:", error);
      throw error;
    }

    console.log(`S3 credentials stored successfully for account ${data.id}`);

    return new Response(
      JSON.stringify({ success: true, accountId: data.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Store S3 credentials error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
