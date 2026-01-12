import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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

  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoder.encode(token));

  const combined = new Uint8Array(iv.length + new Uint8Array(encryptedData).length);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);

  return "enc:" + uint8ArrayToBase64(combined);
}

async function refreshMicrosoftToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number } | null> {
  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("MICROSOFT_CLIENT_ID")!,
      client_secret: Deno.env.get("MICROSOFT_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return null;
  return response.json();
}

async function refreshGoogleToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return null;
  return response.json();
}

async function getValidAccessToken(supabase: any, account: any, encryptionKey: string): Promise<string> {
  let accessToken = await decryptToken(account.access_token, encryptionKey);
  const refreshToken = account.refresh_token ? await decryptToken(account.refresh_token, encryptionKey) : null;
  
  const tokenExpired = account.token_expires_at && new Date(account.token_expires_at) < new Date();
  
  if (tokenExpired && refreshToken) {
    console.log(`Refreshing ${account.provider} token...`);
    
    if (account.provider === "onedrive") {
      const newTokens = await refreshMicrosoftToken(refreshToken);
      if (newTokens) {
        accessToken = newTokens.access_token;
        await supabase.from("connected_accounts").update({
          access_token: await encryptToken(newTokens.access_token, encryptionKey),
          refresh_token: newTokens.refresh_token ? await encryptToken(newTokens.refresh_token, encryptionKey) : account.refresh_token,
          token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", account.id);
      }
    } else if (account.provider === "google_drive") {
      const newTokens = await refreshGoogleToken(refreshToken);
      if (newTokens) {
        accessToken = newTokens.access_token;
        await supabase.from("connected_accounts").update({
          access_token: await encryptToken(newTokens.access_token, encryptionKey),
          token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", account.id);
      }
    }
  }
  
  return accessToken;
}

// Delete a file
async function deleteFile(provider: string, accessToken: string, fileId: string): Promise<void> {
  if (provider === "onedrive") {
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`OneDrive delete error: ${response.status}`);
    }
  } else {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Google Drive delete error: ${response.status}`);
    }
  }
}

// Rename a file
async function renameFile(provider: string, accessToken: string, fileId: string, newName: string): Promise<void> {
  if (provider === "onedrive") {
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: newName }),
    });
    if (!response.ok) {
      throw new Error(`OneDrive rename error: ${response.status}`);
    }
  } else {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: newName }),
    });
    if (!response.ok) {
      throw new Error(`Google Drive rename error: ${response.status}`);
    }
  }
}

// Create a folder
async function createFolder(provider: string, accessToken: string, parentFolderId: string | null, folderName: string): Promise<string> {
  if (provider === "onedrive") {
    const parentPath = parentFolderId ? `/me/drive/items/${parentFolderId}/children` : "/me/drive/root/children";
    const response = await fetch(`https://graph.microsoft.com/v1.0${parentPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      }),
    });
    if (!response.ok) {
      throw new Error(`OneDrive create folder error: ${response.status}`);
    }
    const result = await response.json();
    return result.id;
  } else {
    const response = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: parentFolderId ? [parentFolderId] : undefined,
      }),
    });
    if (!response.ok) {
      throw new Error(`Google Drive create folder error: ${response.status}`);
    }
    const result = await response.json();
    return result.id;
  }
}

// Download a file and return base64 content
async function downloadFile(provider: string, accessToken: string, fileId: string): Promise<{ content: string; mimeType: string; name: string; size: number }> {
  if (provider === "onedrive") {
    const metaResponse = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResponse.ok) throw new Error(`OneDrive meta error: ${metaResponse.status}`);
    const meta = await metaResponse.json();
    
    const downloadUrl = meta["@microsoft.graph.downloadUrl"];
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`OneDrive download error: ${response.status}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
    
    return { 
      content: base64,
      mimeType: meta.file?.mimeType || "application/octet-stream",
      name: meta.name,
      size: meta.size || arrayBuffer.byteLength
    };
  } else {
    const metaResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResponse.ok) throw new Error(`Google Drive meta error: ${metaResponse.status}`);
    const meta = await metaResponse.json();

    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Drive download error: ${response.status}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
    
    return { 
      content: base64,
      mimeType: meta.mimeType || "application/octet-stream",
      name: meta.name,
      size: parseInt(meta.size) || arrayBuffer.byteLength
    };
  }
}

// Upload a file
async function uploadFile(provider: string, accessToken: string, parentFolderId: string | null, fileName: string, contentBase64: string, mimeType: string): Promise<{ id: string; name: string }> {
  const content = base64ToUint8Array(contentBase64);
  
  if (provider === "onedrive") {
    const parentPath = parentFolderId ? `/me/drive/items/${parentFolderId}` : "/me/drive/root";
    const response = await fetch(`https://graph.microsoft.com/v1.0${parentPath}:/${encodeURIComponent(fileName)}:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      body: new Blob([content as unknown as BlobPart], { type: mimeType }),
    });
    if (!response.ok) throw new Error(`OneDrive upload error: ${response.status}`);
    const result = await response.json();
    return { id: result.id, name: result.name };
  } else {
    // Google Drive requires multipart upload
    const boundary = "boundary_" + Date.now();
    const metadata = JSON.stringify({
      name: fileName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    });
    
    const textEncoder = new TextEncoder();
    const headerPart = textEncoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const footerPart = textEncoder.encode(`\r\n--${boundary}--`);
    
    const bodyArray = new Uint8Array(headerPart.length + content.length + footerPart.length);
    bodyArray.set(headerPart, 0);
    bodyArray.set(content, headerPart.length);
    bodyArray.set(footerPart, headerPart.length + content.length);
    
    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: new Blob([bodyArray as unknown as BlobPart]),
    });
    if (!response.ok) throw new Error(`Google Drive upload error: ${response.status}`);
    const result = await response.json();
    return { id: result.id, name: result.name };
  }
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

    const { operation, provider, fileId, newName, parentFolderId, folderName, fileContent, fileName, mimeType, accountId } = await req.json();
    
    console.log(`File operation: ${operation} on ${provider} for file ${fileId || fileName}`);

    // Get account (prefer explicit accountId; otherwise fall back to most recently added account)
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
      return new Response(JSON.stringify({ error: "Account not connected" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const accessToken = await getValidAccessToken(supabase, account, encryptionKey);

    let result: any = { success: true };

    switch (operation) {
      case "delete":
        await deleteFile(provider, accessToken, fileId);
        console.log(`Deleted file ${fileId} from ${provider}`);
        break;

      case "rename":
        if (!newName) {
          return new Response(JSON.stringify({ error: "New name required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await renameFile(provider, accessToken, fileId, newName);
        console.log(`Renamed file ${fileId} to ${newName} on ${provider}`);
        break;

      case "createFolder":
        if (!folderName) {
          return new Response(JSON.stringify({ error: "Folder name required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const folderId = await createFolder(provider, accessToken, parentFolderId, folderName);
        result = { success: true, folderId };
        console.log(`Created folder ${folderName} on ${provider}`);
        break;

      case "download":
        const fileData = await downloadFile(provider, accessToken, fileId);
        result = { success: true, name: fileData.name, mimeType: fileData.mimeType, content: fileData.content, size: fileData.size };
        console.log(`Downloaded file ${fileData.name} from ${provider}`);
        break;

      case "upload":
        if (!fileName || !fileContent || !mimeType) {
          return new Response(JSON.stringify({ error: "fileName, fileContent, and mimeType required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const uploadResult = await uploadFile(provider, accessToken, parentFolderId, fileName, fileContent, mimeType);
        result = { success: true, id: uploadResult.id, name: uploadResult.name };
        console.log(`Uploaded file ${fileName} to ${provider}`);
        break;

      default:
        return new Response(JSON.stringify({ error: "Invalid operation" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("File operation error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
