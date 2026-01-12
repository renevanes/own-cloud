import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 50; // Process 50 files per batch
const MAX_BATCH_TIME_MS = 45000; // 45 seconds max per batch to leave buffer

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

// Check if item is a file or folder
async function getItemInfo(provider: string, accessToken: string, itemId: string, supabase?: any, userId?: string): Promise<{ isFile: boolean; name: string; size: number; mimeType: string }> {
  if (provider === "local") {
    const { data, error } = await supabase.storage.from("user-files").list(`${userId}/${itemId}`);
    if (error) {
      const pathParts = itemId.split("/");
      const fileName = pathParts[pathParts.length - 1];
      return { isFile: true, name: fileName, size: 0, mimeType: "application/octet-stream" };
    }
    const pathParts = itemId.split("/");
    const folderName = pathParts[pathParts.length - 1] || "Root";
    return { isFile: false, name: folderName, size: 0, mimeType: "application/octet-stream" };
  } else if (provider === "onedrive") {
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${itemId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`OneDrive item info error: ${response.status}`);
    const item = await response.json();
    return { isFile: !item.folder, name: item.name, size: item.size || 0, mimeType: item.file?.mimeType || "application/octet-stream" };
  } else {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${itemId}?fields=id,name,mimeType,size`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Drive item info error: ${response.status}`);
    const item = await response.json();
    return { isFile: item.mimeType !== "application/vnd.google-apps.folder", name: item.name, size: parseInt(item.size) || 0, mimeType: item.mimeType || "application/octet-stream" };
  }
}

// List files from a folder
async function listFiles(provider: string, accessToken: string, folderId: string | null, supabase?: any, userId?: string): Promise<any[]> {
  if (provider === "local") {
    const path = folderId ? `${userId}/${folderId}` : userId;
    const { data, error } = await supabase.storage.from("user-files").list(path);
    if (error) {
      console.error("Local storage list error:", error);
      return [];
    }
    return (data || []).map((item: any) => ({
      id: folderId ? `${folderId}/${item.name}` : item.name,
      name: item.name,
      type: item.metadata ? "file" : "folder",
      size: item.metadata?.size || 0,
      mimeType: item.metadata?.mimetype || "application/octet-stream",
    }));
  } else if (provider === "onedrive") {
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
      downloadUrl: item["@microsoft.graph.downloadUrl"],
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
async function downloadFile(provider: string, accessToken: string, fileId: string, supabase?: any, userId?: string): Promise<{ content: ArrayBuffer; mimeType: string }> {
  if (provider === "local") {
    const { data, error } = await supabase.storage.from("user-files").download(`${userId}/${fileId}`);
    if (error) throw new Error(`Local storage download error: ${error.message}`);
    return { content: await data.arrayBuffer(), mimeType: data.type || "application/octet-stream" };
  } else if (provider === "onedrive") {
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

// Sanitize file name for local storage
function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[↗↙↔←→↑↓]/g, '')
    .replace(/[❤️💕💗💓💖💘💝💞💟🩷🧡💛💚💙💜🖤🤍🤎]/gu, '')
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[()[\]{}]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim();
}

// Upload file to provider
async function uploadFile(provider: string, accessToken: string, parentFolderId: string | null, fileName: string, content: ArrayBuffer, mimeType: string, supabase?: any, userId?: string): Promise<string> {
  if (provider === "local") {
    const sanitizedFileName = sanitizeFileName(fileName);
    let path: string;
    if (parentFolderId) {
      path = parentFolderId.includes('/') ? `${parentFolderId}/${sanitizedFileName}` : `${parentFolderId}/${sanitizedFileName}`;
    } else {
      path = `${userId}/${sanitizedFileName}`;
    }
    
    path = path.split('/').map((segment, index) => {
      if (index === 0 && segment === userId) return segment;
      return sanitizeFileName(segment) || segment;
    }).join('/');
    
    console.log(`Uploading to local storage: ${path}`);
    
    const { data, error } = await supabase.storage.from("user-files").upload(path, content, {
      contentType: mimeType,
      upsert: true,
    });
    if (error) throw new Error(`Local storage upload error: ${error.message}`);
    return data.path;
  } else if (provider === "onedrive") {
    const parentPath = parentFolderId ? `/me/drive/items/${parentFolderId}` : "/me/drive/root";
    const response = await fetch(`https://graph.microsoft.com/v1.0${parentPath}:/${encodeURIComponent(fileName)}:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      body: content,
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("OneDrive upload failed:", response.status, errorText);
      throw new Error(`OneDrive upload error: ${response.status} - ${errorText}`);
    }
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
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Google Drive upload failed:", response.status, errorText);
      throw new Error(`Google Drive upload error: ${response.status} - ${errorText}`);
    }
    const result = await response.json();
    return result.id;
  }
}

// Create folder in cloud provider
async function createFolder(provider: string, accessToken: string, parentFolderId: string | null, folderName: string): Promise<string> {
  if (provider === "onedrive") {
    const parentPath = parentFolderId ? `/me/drive/items/${parentFolderId}` : "/me/drive/root";
    const response = await fetch(`https://graph.microsoft.com/v1.0${parentPath}/children`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace"
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OneDrive create folder error: ${response.status} - ${errorText}`);
    }
    const result = await response.json();
    return result.id;
  } else if (provider === "google_drive") {
    const query = `name='${folderName}' and '${parentFolderId || 'root'}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
      }
    }
    
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
      const errorText = await response.text();
      throw new Error(`Google Drive create folder error: ${response.status} - ${errorText}`);
    }
    const result = await response.json();
    return result.id;
  }
  throw new Error(`Unsupported provider for folder creation: ${provider}`);
}

// Track active sync jobs for shutdown handling
let activeSyncJobId: string | null = null;
let isShuttingDown = false;

// Handle shutdown - mark running jobs as interrupted
addEventListener('beforeunload', async (ev) => {
  console.log('Function shutdown, reason:', (ev as any).detail?.reason);
  isShuttingDown = true;
  if (activeSyncJobId) {
    console.log(`Marking job ${activeSyncJobId} as interrupted due to shutdown`);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    await supabase.from("sync_jobs").update({
      status: "failed",
      error_message: "Job interrupted - edge function shutdown. Files synced so far are preserved.",
      completed_at: new Date().toISOString(),
    }).eq("id", activeSyncJobId).eq("status", "running");
  }
});

// Continue sync by invoking this function again using service role
async function continueSyncInBackground(
  syncFolderId: string,
  jobId: string,
  startIndex: number,
  userId: string
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  
  console.log(`Scheduling continuation for job ${jobId} from index ${startIndex}`);
  
  // Invoke this function again with continuation parameters using service role key
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/sync-files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        syncFolderId,
        action: "continue",
        jobId,
        startIndex,
        userId, // Pass userId explicitly for service role calls
      }),
    });
    
    if (!response.ok) {
      console.error("Failed to schedule continuation:", await response.text());
    } else {
      console.log(`Continuation scheduled successfully for index ${startIndex}`);
    }
  } catch (error) {
    console.error("Error scheduling continuation:", error);
  }
}

// Background sync function - processes a batch of files
async function performSyncBatch(
  supabase: any,
  userId: string,
  syncFolder: any,
  syncJobId: string,
  syncFolderId: string,
  sourceToken: string,
  targetToken: string,
  startIndex: number
) {
  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit
  const batchStartTime = Date.now();
  const MAX_LISTING_TIME_MS = 240000; // 4 minutes max for file listing before we need to save and continue
  
  try {
    console.log(`Batch sync started for job ${syncJobId} from index ${startIndex}`);
    activeSyncJobId = syncJobId;

    // Check if we have a cached file list from a previous batch
    const { data: jobData } = await supabase
      .from("sync_jobs")
      .select("file_list")
      .eq("id", syncJobId)
      .single();
    
    let filesToSync: { file: any; targetFolder: string | null; relativePath: string }[] = [];
    
    // If we have a cached file list, use it directly
    if (jobData?.file_list && Array.isArray(jobData.file_list) && jobData.file_list.length > 0) {
      filesToSync = jobData.file_list;
      console.log(`Using cached file list with ${filesToSync.length} files`);
    } else {
      // Need to collect files - this is expensive for large folders
      console.log("No cached file list, collecting files from source...");
      
      // Recursive function to collect all files from a folder and its subfolders
      // with time-based checkpointing
      let listingTimedOut = false;
      const listingStartTime = Date.now();
      
      async function collectFilesRecursively(
        provider: string, 
        token: string, 
        folderId: string | null, 
        targetFolderId: string | null,
        relativePath: string = ""
      ): Promise<{ file: any; targetFolder: string | null; relativePath: string }[]> {
        // Check if we're running out of time for listing
        if (Date.now() - listingStartTime > MAX_LISTING_TIME_MS) {
          listingTimedOut = true;
          console.log("Listing time limit approaching, will save partial list");
        }
        
        const items = await listFiles(provider, token, folderId, supabase, userId);
        let allFiles: { file: any; targetFolder: string | null; relativePath: string }[] = [];
        
        for (const item of items) {
          if (listingTimedOut) break;
          
          if (item.type === "file") {
            allFiles.push({ file: item, targetFolder: targetFolderId, relativePath });
          } else if (item.type === "folder") {
            console.log(`Found subfolder: ${item.name}, recursing...`);
            
            let newTargetFolderId = targetFolderId;
            const newRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
            
            if (syncFolder.target_provider !== "local") {
              try {
                newTargetFolderId = await createFolder(syncFolder.target_provider, targetToken, targetFolderId, item.name);
                console.log(`Created target folder: ${item.name}, id: ${newTargetFolderId}`);
              } catch (e) {
                console.log(`Folder ${item.name} may already exist, continuing...`);
                const existingItems = await listFiles(syncFolder.target_provider, targetToken, targetFolderId, supabase, userId);
                const existingFolder = existingItems.find(f => f.name === item.name && f.type === "folder");
                if (existingFolder) {
                  newTargetFolderId = existingFolder.id;
                }
              }
            } else {
              newTargetFolderId = targetFolderId ? `${targetFolderId}/${item.name}` : item.name;
            }
            
            const subFiles = await collectFilesRecursively(provider, token, item.id, newTargetFolderId, newRelativePath);
            allFiles = allFiles.concat(subFiles);
          }
        }
        
        return allFiles;
      }

      // Check if source is a file or folder
      const sourceInfo = await getItemInfo(syncFolder.source_provider, sourceToken, syncFolder.source_folder_id, supabase, userId);
      console.log(`Source item: ${sourceInfo.name}, isFile: ${sourceInfo.isFile}`);

      if (sourceInfo.isFile) {
        filesToSync = [{
          file: {
            id: syncFolder.source_folder_id,
            name: sourceInfo.name,
            type: "file",
            size: sourceInfo.size,
            mimeType: sourceInfo.mimeType,
          },
          targetFolder: syncFolder.target_folder_id,
          relativePath: "",
        }];
        console.log(`Source is a file, syncing single file: ${sourceInfo.name}`);
      } else {
        filesToSync = await collectFilesRecursively(
          syncFolder.source_provider, 
          sourceToken, 
          syncFolder.source_folder_id, 
          syncFolder.target_folder_id
        );
        console.log(`Source is a folder, found ${filesToSync.length} total files to sync`);
      }

      // Cache the file list for future batches
      console.log(`Caching file list with ${filesToSync.length} files for future batches`);
      await supabase.from("sync_jobs").update({
        file_list: filesToSync,
        files_total: filesToSync.length,
        batch_size: BATCH_SIZE,
      }).eq("id", syncJobId);
    }

    // Get current progress
    const { data: currentJob } = await supabase
      .from("sync_jobs")
      .select("files_synced, status")
      .eq("id", syncJobId)
      .single();

    if (currentJob?.status === "cancelled" || currentJob?.status === "failed") {
      console.log(`Job ${currentJob?.status}, stopping sync`);
      activeSyncJobId = null;
      return;
    }

    let filesSynced = currentJob?.files_synced || 0;
    let filesSkipped = 0;

    // Log large files that will be skipped (only on first batch)
    if (startIndex === 0) {
      const largeFiles = filesToSync.filter(f => f.file.size > MAX_FILE_SIZE);
      if (largeFiles.length > 0) {
        console.log(`Warning: ${largeFiles.length} files exceed 100MB limit and will be skipped`);
        for (const { file, relativePath } of largeFiles) {
          await supabase.from("sync_logs").insert({
            user_id: userId,
            sync_folder_id: syncFolderId,
            sync_job_id: syncJobId,
            status: "skipped",
            action: "copy",
            source_file_name: file.name,
            source_file_id: file.id,
            file_size: file.size,
            error_message: `File exceeds 100MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
            completed_at: new Date().toISOString(),
          });
          filesSkipped++;
        }
      }
    }

    // Filter out large files and get batch to process
    const processableFiles = filesToSync.filter(f => f.file.size <= MAX_FILE_SIZE);
    const endIndex = Math.min(startIndex + BATCH_SIZE, processableFiles.length);
    const batchFiles = processableFiles.slice(startIndex, endIndex);
    
    console.log(`Processing batch: files ${startIndex} to ${endIndex - 1} of ${processableFiles.length}`);

    for (const { file, targetFolder, relativePath } of batchFiles) {
      // Check if shutdown is in progress or job was cancelled/failed
      if (isShuttingDown) {
        console.log("Shutdown detected, stopping sync gracefully");
        activeSyncJobId = null;
        return;
      }

      // Check time limit
      if (Date.now() - batchStartTime > MAX_BATCH_TIME_MS) {
        console.log(`Batch time limit reached, scheduling continuation from index ${startIndex + (filesSynced - (currentJob?.files_synced || 0))}`);
        
        // Update resume index
        const currentIndex = startIndex + (filesSynced - (currentJob?.files_synced || 0));
        await supabase.from("sync_jobs").update({
          resume_from_index: currentIndex,
        }).eq("id", syncJobId);
        
        // Schedule continuation
        await continueSyncInBackground(syncFolderId, syncJobId, currentIndex, userId);
        activeSyncJobId = null;
        return;
      }

      // Re-check job status periodically
      const { data: jobStatus } = await supabase
        .from("sync_jobs")
        .select("status")
        .eq("id", syncJobId)
        .single();
      
      if (jobStatus?.status === "cancelled" || jobStatus?.status === "failed") {
        console.log(`Job ${jobStatus?.status}, stopping sync`);
        activeSyncJobId = null;
        return;
      }

      try {
        console.log(`Syncing file: ${relativePath ? `${relativePath}/` : ''}${file.name}`);
        
        const { data: logData } = await supabase.from("sync_logs").insert({
          user_id: userId,
          sync_folder_id: syncFolderId,
          sync_job_id: syncJobId,
          status: "started",
          action: "copy",
          source_file_name: file.name,
          source_file_id: file.id,
          file_size: file.size,
        }).select().single();
        
        // Download from source
        const { content, mimeType } = await downloadFile(syncFolder.source_provider, sourceToken, file.id, supabase, userId);
        console.log(`Downloaded ${file.name}, size: ${content.byteLength} bytes`);
        
        // Upload to target
        const targetFileId = await uploadFile(
          syncFolder.target_provider,
          targetToken,
          targetFolder,
          file.name,
          content,
          mimeType,
          supabase,
          userId
        );
        console.log(`Uploaded ${file.name} to target, id: ${targetFileId}`);
        
        // Update log
        if (logData) {
          await supabase.from("sync_logs").update({
            status: "completed",
            target_file_name: file.name,
            target_file_id: targetFileId,
            completed_at: new Date().toISOString(),
          }).eq("id", logData.id);
        }
        
        filesSynced++;

        // Update job progress after each file
        await supabase.from("sync_jobs").update({
          files_synced: filesSynced,
        }).eq("id", syncJobId);
        
      } catch (fileError) {
        console.error(`Failed to sync file ${file.name}:`, fileError);
        
        await supabase.from("sync_logs").insert({
          user_id: userId,
          sync_folder_id: syncFolderId,
          sync_job_id: syncJobId,
          status: "failed",
          action: "copy",
          source_file_name: file.name,
          source_file_id: file.id,
          error_message: fileError instanceof Error ? fileError.message : "Unknown error",
          completed_at: new Date().toISOString(),
        });
      }
    }

    // Check if there are more files to process
    if (endIndex < processableFiles.length) {
      console.log(`Batch complete. Scheduling next batch from index ${endIndex}`);
      
      // Update resume index
      await supabase.from("sync_jobs").update({
        resume_from_index: endIndex,
      }).eq("id", syncJobId);
      
      // Schedule next batch
      await continueSyncInBackground(syncFolderId, syncJobId, endIndex, userId);
      activeSyncJobId = null;
      return;
    }

    // All files processed - finalize job
    const totalProcessable = processableFiles.length;
    const allSucceeded = filesSynced === totalProcessable && filesSkipped === 0;
    const hasSkipped = filesSkipped > 0;
    
    let errorMessage = null;
    if (filesSkipped > 0 && filesSynced < totalProcessable) {
      errorMessage = `${filesSkipped} files skipped (>100MB), ${totalProcessable - filesSynced} files failed`;
    } else if (filesSkipped > 0) {
      errorMessage = `${filesSkipped} files skipped (exceeded 100MB limit)`;
    } else if (filesSynced < totalProcessable) {
      errorMessage = `${totalProcessable - filesSynced} files failed`;
    }

    await supabase.from("sync_jobs").update({
      status: allSucceeded ? "completed" : (hasSkipped && filesSynced === totalProcessable) ? "completed" : "failed",
      files_synced: filesSynced,
      files_total: filesToSync.length,
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
      resume_from_index: 0,
      file_list: null, // Clear cached file list on completion
    }).eq("id", syncJobId);

    // Update sync folder last_synced_at
    await supabase.from("sync_folders").update({
      last_synced_at: new Date().toISOString(),
    }).eq("id", syncFolderId);

    console.log(`Sync completed: ${filesSynced}/${totalProcessable} files synced, ${filesSkipped} skipped`);
    activeSyncJobId = null;

  } catch (error) {
    console.error("Batch sync error:", error);
    await supabase.from("sync_jobs").update({
      status: "failed",
      error_message: error instanceof Error ? error.message : "Unknown error",
      completed_at: new Date().toISOString(),
    }).eq("id", syncJobId);
    activeSyncJobId = null;
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

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { syncFolderId, action, jobId, startIndex, userId: bodyUserId } = body;
    
    // Check if this is a service role call (for continuation) or a user call
    const isServiceRoleCall = token === supabaseKey;
    
    let userId: string;
    
    if (isServiceRoleCall && bodyUserId) {
      // Service role call with explicit userId (for continuation)
      userId = bodyUserId;
      console.log(`Service role continuation call for user ${userId}`);
    } else {
      // Regular user call - validate JWT
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      userId = user.id;
    }
    
    console.log(`Received request: action=${action}, jobId=${jobId}, syncFolderId=${syncFolderId}, startIndex=${startIndex}, userId=${userId}`);
    
    // Handle stop action
    if (action === "stop" && jobId) {
      console.log(`Stopping sync job ${jobId} for user ${userId}`);
      
      const { data: updatedJob, error: stopError } = await supabase
        .from("sync_jobs")
        .update({
          status: "cancelled",
          error_message: "Cancelled by user",
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("user_id", userId)
        .select()
        .single();
      
      if (stopError) {
        console.error("Error stopping job:", stopError);
        return new Response(JSON.stringify({ error: "Failed to stop job", details: stopError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      if (activeSyncJobId === jobId) {
        activeSyncJobId = null;
      }
      
      console.log(`Job ${jobId} cancelled successfully`, updatedJob);
      return new Response(JSON.stringify({ success: true, message: "Job cancelled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    
    // Handle continuation action
    if (action === "continue" && jobId && typeof startIndex === "number") {
      console.log(`Continuing sync job ${jobId} from index ${startIndex}`);
      
      // Get existing job
      const { data: existingJob, error: jobFetchError } = await supabase
        .from("sync_jobs")
        .select("*, sync_folders(*)")
        .eq("id", jobId)
        .eq("user_id", userId)
        .single();
      
      if (jobFetchError || !existingJob) {
        return new Response(JSON.stringify({ error: "Job not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      if (existingJob.status !== "running") {
        return new Response(JSON.stringify({ error: "Job is not running" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      const syncFolder = existingJob.sync_folders;
      
      // Get accounts
      const { data: accounts } = await supabase
        .from("connected_accounts")
        .select("*")
        .eq("user_id", userId);

      const isSourceLocal = syncFolder.source_provider === "local";
      const isTargetLocal = syncFolder.target_provider === "local";

      let sourceToken = "";
      let targetToken = "";

      if (!isSourceLocal) {
        const sourceAccount = syncFolder.source_account_id 
          ? accounts?.find((a: any) => a.id === syncFolder.source_account_id)
          : accounts?.find((a: any) => a.provider === syncFolder.source_provider);
        
        if (!sourceAccount) {
          return new Response(JSON.stringify({ error: "Source account not found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        sourceToken = await getValidAccessToken(supabase, sourceAccount, encryptionKey);
      }

      if (!isTargetLocal) {
        const targetAccount = syncFolder.target_account_id
          ? accounts?.find((a: any) => a.id === syncFolder.target_account_id)
          : accounts?.find((a: any) => a.provider === syncFolder.target_provider);
        
        if (!targetAccount) {
          return new Response(JSON.stringify({ error: "Target account not found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        targetToken = await getValidAccessToken(supabase, targetAccount, encryptionKey);
      }

      // Run the batch sync in background
      const syncTask = performSyncBatch(
        supabase, 
        userId, 
        syncFolder, 
        jobId, 
        syncFolderId, 
        sourceToken, 
        targetToken,
        startIndex
      );

      (globalThis as any).EdgeRuntime?.waitUntil?.(syncTask);

      return new Response(
        JSON.stringify({ 
          success: true, 
          jobId: jobId,
          message: `Continuing sync from index ${startIndex}`
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    console.log(`Starting sync for user ${userId}, folder ${syncFolderId}, action: ${action || 'sync'}`);

    // Get sync folder configuration
    const { data: syncFolder, error: syncError } = await supabase
      .from("sync_folders")
      .select("*")
      .eq("id", syncFolderId)
      .eq("user_id", userId)
      .maybeSingle();

    if (syncError || !syncFolder) {
      return new Response(JSON.stringify({ error: "Sync folder not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Get accounts
    const { data: accounts } = await supabase
      .from("connected_accounts")
      .select("*")
      .eq("user_id", userId);

    const isSourceLocal = syncFolder.source_provider === "local";
    const isTargetLocal = syncFolder.target_provider === "local";

    let sourceAccount = null;
    let targetAccount = null;
    let sourceToken = "";
    let targetToken = "";

    if (!isSourceLocal) {
      sourceAccount = syncFolder.source_account_id 
        ? accounts?.find((a: any) => a.id === syncFolder.source_account_id)
        : accounts?.find((a: any) => a.provider === syncFolder.source_provider);
      
      if (!sourceAccount) {
        return new Response(JSON.stringify({ error: "Source account not found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      sourceToken = await getValidAccessToken(supabase, sourceAccount, encryptionKey);
    }

    if (!isTargetLocal) {
      targetAccount = syncFolder.target_account_id
        ? accounts?.find((a: any) => a.id === syncFolder.target_account_id)
        : accounts?.find((a: any) => a.provider === syncFolder.target_provider);
      
      if (!targetAccount) {
        return new Response(JSON.stringify({ error: "Target account not found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      targetToken = await getValidAccessToken(supabase, targetAccount, encryptionKey);
    }

    // Create sync job
    const { data: syncJob, error: jobError } = await supabase
      .from("sync_jobs")
      .insert({
        user_id: userId,
        sync_folder_id: syncFolderId,
        status: "running",
        started_at: new Date().toISOString(),
        resume_from_index: 0,
        batch_size: BATCH_SIZE,
      })
      .select()
      .single();

    if (jobError) {
      console.error("Failed to create sync job:", jobError);
      return new Response(JSON.stringify({ error: "Failed to create sync job" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const syncJobId = syncJob.id;

    // Run the first batch sync in background
    const syncTask = performSyncBatch(
      supabase, 
      userId, 
      syncFolder, 
      syncJobId, 
      syncFolderId, 
      sourceToken, 
      targetToken,
      0 // Start from index 0
    );

    (globalThis as any).EdgeRuntime?.waitUntil?.(syncTask);

    return new Response(
      JSON.stringify({ 
        success: true, 
        jobId: syncJobId,
        message: "Sync started in background (batch processing enabled)"
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
