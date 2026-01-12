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

// Refresh tokens
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

// List files from a folder
async function listFiles(provider: string, accessToken: string, folderId: string | null): Promise<any[]> {
  if (provider === "onedrive") {
    const endpoint = folderId 
      ? `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`
      : "https://graph.microsoft.com/v1.0/me/drive/root/children";
    
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`OneDrive list error: ${response.status}`);
    const data = await response.json();
    
    return (data.value || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      type: item.folder ? "folder" : "file",
      size: item.size,
      mimeType: item.file?.mimeType,
    }));
  } else {
    const parentId = folderId || "root";
    const query = `'${parentId}' in parents and trashed = false`;
    
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!response.ok) throw new Error(`Google Drive list error: ${response.status}`);
    const data = await response.json();
    
    return (data.files || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      type: item.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
      size: parseInt(item.size) || 0,
      mimeType: item.mimeType,
    }));
  }
}

// Download file content
async function downloadFile(provider: string, accessToken: string, fileId: string): Promise<{ content: ArrayBuffer; mimeType: string }> {
  if (provider === "onedrive") {
    const metaResponse = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResponse.ok) throw new Error(`OneDrive meta error: ${metaResponse.status}`);
    const meta = await metaResponse.json();
    
    const downloadUrl = meta["@microsoft.graph.downloadUrl"];
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`OneDrive download error: ${response.status}`);
    
    return { content: await response.arrayBuffer(), mimeType: meta.file?.mimeType || "application/octet-stream" };
  } else {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Drive download error: ${response.status}`);
    
    return { content: await response.arrayBuffer(), mimeType: response.headers.get("content-type") || "application/octet-stream" };
  }
}

// Upload file to provider
async function uploadFile(provider: string, accessToken: string, parentFolderId: string | null, fileName: string, content: ArrayBuffer, mimeType: string): Promise<string> {
  if (provider === "onedrive") {
    const parentPath = parentFolderId ? `/me/drive/items/${parentFolderId}` : "/me/drive/root";
    const response = await fetch(`https://graph.microsoft.com/v1.0${parentPath}:/${encodeURIComponent(fileName)}:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      body: content,
    });
    if (!response.ok) throw new Error(`OneDrive upload error: ${response.status}`);
    const result = await response.json();
    return result.id;
  } else {
    const boundary = "boundary_" + Date.now();
    const metadata = JSON.stringify({
      name: fileName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    });
    
    const body = new Uint8Array(await new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      new Uint8Array(content),
      `\r\n--${boundary}--`,
    ]).arrayBuffer());
    
    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!response.ok) throw new Error(`Google Drive upload error: ${response.status}`);
    const result = await response.json();
    return result.id;
  }
}

// Sync a single folder
async function syncFolder(supabase: any, syncFolder: any, accounts: any[], encryptionKey: string): Promise<{ success: boolean; filesSynced: number; totalFiles: number; error?: string }> {
  try {
    const sourceAccount = accounts.find((a: any) => a.provider === syncFolder.source_provider);
    const targetAccount = accounts.find((a: any) => a.provider === syncFolder.target_provider);

    if (!sourceAccount || !targetAccount) {
      return { success: false, filesSynced: 0, totalFiles: 0, error: "Missing accounts" };
    }

    const sourceToken = await getValidAccessToken(supabase, sourceAccount, encryptionKey);
    const targetToken = await getValidAccessToken(supabase, targetAccount, encryptionKey);

    // Create sync job
    const { data: syncJob } = await supabase
      .from("sync_jobs")
      .insert({
        user_id: syncFolder.user_id,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    // List files from source
    const sourceFiles = await listFiles(syncFolder.source_provider, sourceToken, syncFolder.source_folder_id);
    const filesToSync = sourceFiles.filter((f: any) => f.type === "file");

    console.log(`Scheduled sync: Found ${filesToSync.length} files to sync for folder ${syncFolder.id}`);

    let filesSynced = 0;

    for (const file of filesToSync) {
      try {
        const { content, mimeType } = await downloadFile(syncFolder.source_provider, sourceToken, file.id);
        await uploadFile(syncFolder.target_provider, targetToken, syncFolder.target_folder_id, file.name, content, mimeType);
        
        await supabase.from("sync_logs").insert({
          user_id: syncFolder.user_id,
          sync_folder_id: syncFolder.id,
          status: "completed",
          action: "copy",
          source_file_name: file.name,
          source_file_id: file.id,
          target_file_name: file.name,
          file_size: file.size,
          completed_at: new Date().toISOString(),
        });
        
        filesSynced++;
      } catch (fileError) {
        console.error(`Failed to sync file ${file.name}:`, fileError);
        await supabase.from("sync_logs").insert({
          user_id: syncFolder.user_id,
          sync_folder_id: syncFolder.id,
          status: "failed",
          action: "copy",
          source_file_name: file.name,
          source_file_id: file.id,
          error_message: fileError instanceof Error ? fileError.message : "Unknown error",
          completed_at: new Date().toISOString(),
        });
      }
    }

    // Update sync job
    if (syncJob) {
      await supabase.from("sync_jobs").update({
        status: "completed",
        files_synced: filesSynced,
        files_total: filesToSync.length,
        completed_at: new Date().toISOString(),
      }).eq("id", syncJob.id);
    }

    // Update last_synced_at and calculate next_sync_at
    const now = new Date();
    let nextSyncAt: Date | null = null;
    
    if (syncFolder.sync_schedule) {
      switch (syncFolder.sync_schedule) {
        case "hourly":
          nextSyncAt = new Date(now.getTime() + 60 * 60 * 1000);
          break;
        case "every_6_hours":
          nextSyncAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
          break;
        case "daily":
          nextSyncAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          break;
        case "weekly":
          nextSyncAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          break;
      }
    }

    await supabase.from("sync_folders").update({
      last_synced_at: now.toISOString(),
      next_sync_at: nextSyncAt?.toISOString() || null,
    }).eq("id", syncFolder.id);

    return { success: true, filesSynced, totalFiles: filesToSync.length };
  } catch (error) {
    console.error(`Error syncing folder ${syncFolder.id}:`, error);
    return { success: false, filesSynced: 0, totalFiles: 0, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log("Scheduled sync: Starting scheduled sync check...");

    // Find all sync folders that are due for sync
    const now = new Date().toISOString();
    const { data: dueFolders, error: foldersError } = await supabase
      .from("sync_folders")
      .select("*")
      .eq("sync_enabled", true)
      .not("sync_schedule", "is", null)
      .or(`next_sync_at.is.null,next_sync_at.lte.${now}`);

    if (foldersError) {
      console.error("Error fetching due folders:", foldersError);
      throw foldersError;
    }

    console.log(`Scheduled sync: Found ${dueFolders?.length || 0} folders due for sync`);

    if (!dueFolders || dueFolders.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No folders due for sync", foldersProcessed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Group folders by user_id
    const userFolders = new Map<string, any[]>();
    for (const folder of dueFolders) {
      if (!userFolders.has(folder.user_id)) {
        userFolders.set(folder.user_id, []);
      }
      userFolders.get(folder.user_id)!.push(folder);
    }

    const results: { folderId: string; success: boolean; filesSynced: number; totalFiles: number; error?: string }[] = [];

    // Process each user's folders
    for (const [userId, folders] of userFolders) {
      // Get user's connected accounts
      const { data: accounts, error: accountsError } = await supabase
        .from("connected_accounts")
        .select("*")
        .eq("user_id", userId);

      if (accountsError || !accounts || accounts.length < 2) {
        console.log(`Scheduled sync: User ${userId} doesn't have both accounts connected, skipping`);
        continue;
      }

      for (const folder of folders) {
        const result = await syncFolder(supabase, folder, accounts, encryptionKey);
        results.push({
          folderId: folder.id,
          ...result,
        });
      }
    }

    console.log(`Scheduled sync: Completed. Processed ${results.length} folders.`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        foldersProcessed: results.length,
        results 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Scheduled sync error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
