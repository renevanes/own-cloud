import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "flac", "ogg", "aac", "wma", "webm", "opus"];
const MAX_FILES_PER_REQUEST = 2; // Process max 2 files per request to avoid timeout
const MAX_FILE_SIZE_MB = 20; // Skip files larger than 20MB to avoid timeout

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

// Token refresh functions
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

function isAudioFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return AUDIO_EXTENSIONS.includes(ext);
}

// List audio files from a folder (recursive)
async function listAudioFiles(provider: string, accessToken: string, folderId: string | null, supabase: any, userId: string): Promise<any[]> {
  const files: any[] = [];
  
  if (provider === "local") {
    const path = folderId ? `${userId}/${folderId}` : userId;
    const { data, error } = await supabase.storage.from("user-files").list(path);
    if (error) {
      console.error("Local storage list error:", error);
      return [];
    }
    for (const item of data || []) {
      if (item.metadata) {
        if (isAudioFile(item.name)) {
          files.push({
            id: folderId ? `${folderId}/${item.name}` : item.name,
            name: item.name,
            path: folderId ? `${folderId}/${item.name}` : item.name,
            size: item.metadata?.size || 0,
            provider: "local",
          });
        }
      } else {
        const subPath = folderId ? `${folderId}/${item.name}` : item.name;
        const subFiles = await listAudioFiles("local", accessToken, subPath, supabase, userId);
        files.push(...subFiles);
      }
    }
  } else if (provider === "onedrive") {
    const endpoint = folderId 
      ? `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`
      : "https://graph.microsoft.com/v1.0/me/drive/root/children";
    
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`OneDrive list error: ${response.status}`);
    const data = await response.json();
    
    for (const item of data.value || []) {
      if (item.folder) {
        const subFiles = await listAudioFiles("onedrive", accessToken, item.id, supabase, userId);
        files.push(...subFiles);
      } else if (isAudioFile(item.name)) {
        files.push({
          id: item.id,
          name: item.name,
          path: item.parentReference?.path ? `${item.parentReference.path}/${item.name}` : item.name,
          size: item.size,
          provider: "onedrive",
        });
      }
    }
  } else if (provider === "google_drive") {
    const parentId = folderId || "root";
    const query = `'${parentId}' in parents and trashed = false`;
    
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size,parents)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!response.ok) throw new Error(`Google Drive list error: ${response.status}`);
    const data = await response.json();
    
    for (const item of data.files || []) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        const subFiles = await listAudioFiles("google_drive", accessToken, item.id, supabase, userId);
        files.push(...subFiles);
      } else if (isAudioFile(item.name)) {
        files.push({
          id: item.id,
          name: item.name,
          path: item.name,
          size: parseInt(item.size) || 0,
          provider: "google_drive",
        });
      }
    }
  }
  
  return files;
}

// Download audio file
async function downloadAudioFile(provider: string, accessToken: string, fileId: string, supabase: any, userId: string): Promise<{ content: ArrayBuffer; mimeType: string }> {
  if (provider === "local") {
    const { data, error } = await supabase.storage.from("user-files").download(`${userId}/${fileId}`);
    if (error) throw new Error(`Local storage download error: ${error.message}`);
    return { content: await data.arrayBuffer(), mimeType: data.type || "audio/mpeg" };
  } else if (provider === "onedrive") {
    const metaResponse = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaResponse.ok) throw new Error(`OneDrive meta error: ${metaResponse.status}`);
    const meta = await metaResponse.json();
    
    const downloadUrl = meta["@microsoft.graph.downloadUrl"];
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`OneDrive download error: ${response.status}`);
    
    return { content: await response.arrayBuffer(), mimeType: meta.file?.mimeType || "audio/mpeg" };
  } else {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Drive download error: ${response.status}`);
    
    return { content: await response.arrayBuffer(), mimeType: response.headers.get("content-type") || "audio/mpeg" };
  }
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(audioContent: ArrayBuffer, mimeType: string): Promise<{ text: string; segments: any[] }> {
  const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openAIApiKey) throw new Error('OPENAI_API_KEY is not configured');

  const extension = mimeType?.includes('m4a') ? 'm4a' :
                    mimeType?.includes('mp4') ? 'm4a' : 
                    mimeType?.includes('mpeg') ? 'mp3' :
                    mimeType?.includes('mp3') ? 'mp3' :
                    mimeType?.includes('wav') ? 'wav' :
                    mimeType?.includes('flac') ? 'flac' :
                    mimeType?.includes('ogg') ? 'ogg' :
                    mimeType?.includes('aac') ? 'aac' : 'webm';

  const formData = new FormData();
  const blob = new Blob([audioContent], { type: mimeType || 'audio/mpeg' });
  formData.append('file', blob, `audio.${extension}`);
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('model', 'whisper-1');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openAIApiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${errorText}`);
  }

  const result = await response.json();
  const segments = (result.segments || []).map((segment: any, index: number) => ({
    id: index + 1,
    start: segment.start,
    end: segment.end,
    text: segment.text?.trim() || '',
  }));

  return { text: result.text, segments };
}

// Process a single file and return result
async function processFile(
  file: any, 
  supabase: any, 
  userId: string, 
  jobId: string, 
  accountMap: Map<string, any>, 
  encryptionKey: string
): Promise<{ success: boolean; error?: string }> {
  // Create log entry (even for skipped files, so we don't retry forever)
  const { data: logEntry, error: logError } = await supabase
    .from("transcription_logs")
    .insert({
      user_id: userId,
      transcription_job_id: jobId,
      status: "processing",
      source_provider: file.provider,
      source_file_id: file.id,
      source_file_name: file.name,
      source_file_path: file.path,
      file_size: file.size,
    })
    .select()
    .single();

  if (logError) {
    console.error("Failed to create log entry:", logError);
    return { success: false, error: logError.message };
  }

  // Check file size - skip very large files (mark as skipped so we don't loop)
  const fileSizeMB = (file.size || 0) / (1024 * 1024);
  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    const message = `File too large (${fileSizeMB.toFixed(1)}MB > ${MAX_FILE_SIZE_MB}MB limit)`;
    console.log(`Skipping ${file.name} - ${message}`);

    await supabase
      .from("transcription_logs")
      .update({
        status: "skipped",
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logEntry.id);

    return { success: false, error: message };
  }

  try {
    // Get access token
    const account = accountMap.get(file.provider);
    let accessToken = "";
    if (account) {
      accessToken = await getValidAccessToken(supabase, account, encryptionKey);
    }

    // Download file
    console.log(`Downloading ${file.name}...`);
    const { content, mimeType } = await downloadAudioFile(file.provider, accessToken, file.id, supabase, userId);
    console.log(`Downloaded ${file.name}, size: ${content.byteLength} bytes`);

    // Transcribe
    console.log(`Transcribing ${file.name}...`);
    const { text, segments } = await transcribeAudio(content, mimeType);
    console.log(`Transcribed ${file.name}, text length: ${text.length}`);

    // Save transcription to storage
    const transcriptionId = crypto.randomUUID();
    const transcriptionData = {
      id: transcriptionId,
      fileName: file.name,
      sourceProvider: file.provider,
      sourcePath: file.path,
      transcription: text,
      segments,
      createdAt: new Date().toISOString(),
    };

    const { error: uploadError } = await supabase.storage
      .from("user-files")
      .upload(
        `${userId}/Transcriptions/${transcriptionId}.json`,
        JSON.stringify(transcriptionData),
        { contentType: "application/json", upsert: true }
      );

    if (uploadError) {
      console.error("Failed to save transcription:", uploadError);
    }

    // Update log as completed
    await supabase
      .from("transcription_logs")
      .update({
        status: "completed",
        transcription_id: transcriptionId,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logEntry.id);

    return { success: true };
  } catch (err: any) {
    console.error(`Error processing ${file.name}:`, err);
    
    await supabase
      .from("transcription_logs")
      .update({
        status: "failed",
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logEntry.id);

    return { success: false, error: err.message };
  }
}

// Get files that haven't been processed yet for a job
async function getPendingFiles(supabase: any, userId: string, allFiles: any[]): Promise<any[]> {
  const { data: existingLogs } = await supabase
    .from("transcription_logs")
    .select("source_file_id, source_provider, status")
    .eq("user_id", userId);

  const processedFileIds = new Set(
    (existingLogs || [])
      .filter((l: any) => ["completed", "processing", "failed", "skipped"].includes(l.status))
      .map((l: any) => `${l.source_provider}:${l.source_file_id}`)
  );

  return allFiles.filter(f => !processedFileIds.has(`${f.provider}:${f.id}`));
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
  
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { action, userId, jobId } = await req.json();
    console.log(`Transcribe-batch action: ${action}, userId: ${userId}, jobId: ${jobId}`);

    if (action === "stop") {
      // Stop a running job
      const { error } = await supabase
        .from("transcription_jobs")
        .update({ 
          status: "cancelled", 
          error_message: "Job cancelled by user",
          completed_at: new Date().toISOString() 
        })
        .eq("id", jobId)
        .eq("user_id", userId)
        .in("status", ["running", "pending"]);

      if (error) throw error;
      console.log(`Job ${jobId} cancelled`);
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "scan") {
      // Scan configured sources for audio files
      const { data: sources, error: sourcesError } = await supabase
        .from("transcription_sources")
        .select("*")
        .eq("user_id", userId)
        .eq("scan_enabled", true);

      if (sourcesError) throw sourcesError;

      const { data: accounts, error: accountsError } = await supabase
        .from("connected_accounts")
        .select("*")
        .eq("user_id", userId);

      if (accountsError) throw accountsError;

      const { data: existingLogs } = await supabase
        .from("transcription_logs")
        .select("source_file_id, source_provider")
        .eq("user_id", userId)
        .eq("status", "completed");

      const existingFileIds = new Set((existingLogs || []).map(l => `${l.source_provider}:${l.source_file_id}`));

      let allFiles: any[] = [];

      for (const source of sources || []) {
        const account = accounts?.find(a => a.provider === source.provider);
        if (!account && source.provider !== "local") continue;

        let accessToken = "";
        if (account) {
          accessToken = await getValidAccessToken(supabase, account, encryptionKey);
        }

        try {
          const files = await listAudioFiles(source.provider, accessToken, source.folder_id, supabase, userId);
          const newFiles = files.filter(f => !existingFileIds.has(`${f.provider}:${f.id}`));
          allFiles.push(...newFiles);
        } catch (err) {
          console.error(`Error scanning source ${source.id}:`, err);
        }

        // Update last scanned
        await supabase
          .from("transcription_sources")
          .update({ last_scanned_at: new Date().toISOString() })
          .eq("id", source.id);
      }

      console.log(`Scan found ${allFiles.length} new audio files`);

      return new Response(JSON.stringify({ files: allFiles, count: allFiles.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "resume") {
      // Resume an existing job - process next batch of files
      const { data: job, error: jobError } = await supabase
        .from("transcription_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("user_id", userId)
        .single();

      if (jobError || !job) {
        return new Response(JSON.stringify({ error: "Job not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (job.status !== "running" && job.status !== "pending") {
        return new Response(JSON.stringify({ 
          error: "Job is not running", 
          status: job.status,
          filesProcessed: job.files_processed,
          filesTotal: job.files_total
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get all files again and find pending ones
      const { data: sources } = await supabase
        .from("transcription_sources")
        .select("*")
        .eq("user_id", userId)
        .eq("scan_enabled", true);

      const { data: accounts } = await supabase
        .from("connected_accounts")
        .select("*")
        .eq("user_id", userId);

      const accountMap = new Map((accounts || []).map(a => [a.provider, a]));

      let allFiles: any[] = [];
      for (const source of sources || []) {
        const account = accounts?.find(a => a.provider === source.provider);
        if (!account && source.provider !== "local") continue;

        let accessToken = "";
        if (account) {
          accessToken = await getValidAccessToken(supabase, account, encryptionKey);
        }

        try {
          const files = await listAudioFiles(source.provider, accessToken, source.folder_id, supabase, userId);
          allFiles.push(...files);
        } catch (err) {
          console.error(`Error scanning source ${source.id}:`, err);
        }
      }

      // Filter to only pending files
      const pendingFiles = await getPendingFiles(supabase, userId, allFiles);
      
      if (pendingFiles.length === 0) {
        // Job is complete
        await supabase
          .from("transcription_jobs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        return new Response(JSON.stringify({ 
          jobId, 
          status: "completed",
          filesProcessed: job.files_processed,
          filesTotal: job.files_total,
          remaining: 0
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Process next batch
      const filesToProcess = pendingFiles.slice(0, MAX_FILES_PER_REQUEST);
      let filesProcessed = job.files_processed || 0;
      let filesSkipped = job.files_skipped || 0;

      for (const file of filesToProcess) {
        const result = await processFile(file, supabase, userId, jobId, accountMap, encryptionKey);
        if (result.success) {
          filesProcessed++;
        } else {
          filesSkipped++;
        }

        // Update job progress
        await supabase
          .from("transcription_jobs")
          .update({
            files_processed: filesProcessed,
            files_skipped: filesSkipped,
          })
          .eq("id", jobId);
      }

      const remaining = pendingFiles.length - filesToProcess.length;
      const isComplete = remaining === 0;

      if (isComplete) {
        await supabase
          .from("transcription_jobs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }

      console.log(`Resume job ${jobId}: processed ${filesToProcess.length}, remaining ${remaining}`);

      return new Response(JSON.stringify({ 
        jobId, 
        status: isComplete ? "completed" : "running",
        filesProcessed,
        filesSkipped,
        filesTotal: job.files_total,
        remaining,
        continueProcessing: !isComplete
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "start" || action === "scan-and-transcribe") {
      // First scan for all files
      const { data: sources } = await supabase
        .from("transcription_sources")
        .select("*")
        .eq("user_id", userId)
        .eq("scan_enabled", true);

      const { data: accounts } = await supabase
        .from("connected_accounts")
        .select("*")
        .eq("user_id", userId);

      const accountMap = new Map((accounts || []).map(a => [a.provider, a]));

      const { data: existingLogs } = await supabase
        .from("transcription_logs")
        .select("source_file_id, source_provider")
        .eq("user_id", userId)
        .eq("status", "completed");

      const existingFileIds = new Set((existingLogs || []).map(l => `${l.source_provider}:${l.source_file_id}`));

      let allFiles: any[] = [];
      for (const source of sources || []) {
        const account = accounts?.find(a => a.provider === source.provider);
        if (!account && source.provider !== "local") continue;

        let accessToken = "";
        if (account) {
          accessToken = await getValidAccessToken(supabase, account, encryptionKey);
        }

        try {
          const files = await listAudioFiles(source.provider, accessToken, source.folder_id, supabase, userId);
          const newFiles = files.filter(f => !existingFileIds.has(`${f.provider}:${f.id}`));
          allFiles.push(...newFiles);
        } catch (err) {
          console.error(`Error scanning source ${source.id}:`, err);
        }

        await supabase
          .from("transcription_sources")
          .update({ last_scanned_at: new Date().toISOString() })
          .eq("id", source.id);
      }

      if (allFiles.length === 0) {
        return new Response(JSON.stringify({ message: "No new files to transcribe" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Create job with total file count
      const { data: job, error: jobError } = await supabase
        .from("transcription_jobs")
        .insert({
          user_id: userId,
          status: "running",
          files_total: allFiles.length,
          files_processed: 0,
          files_skipped: 0,
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (jobError) throw jobError;
      console.log(`Created transcription job ${job.id} with ${allFiles.length} files`);

      // Process first batch immediately
      const filesToProcess = allFiles.slice(0, MAX_FILES_PER_REQUEST);
      let filesProcessed = 0;
      let filesSkipped = 0;

      for (const file of filesToProcess) {
        const result = await processFile(file, supabase, userId, job.id, accountMap, encryptionKey);
        if (result.success) {
          filesProcessed++;
        } else {
          filesSkipped++;
        }

        // Update job progress
        await supabase
          .from("transcription_jobs")
          .update({
            files_processed: filesProcessed,
            files_skipped: filesSkipped,
          })
          .eq("id", job.id);
      }

      const remaining = allFiles.length - filesToProcess.length;
      const isComplete = remaining === 0;

      if (isComplete) {
        await supabase
          .from("transcription_jobs")
          .update({
            status: filesProcessed > 0 ? "completed" : "failed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      }

      console.log(`Started job ${job.id}: processed ${filesProcessed}, remaining ${remaining}`);

      return new Response(JSON.stringify({ 
        jobId: job.id, 
        status: isComplete ? "completed" : "running",
        filesProcessed, 
        filesSkipped,
        filesTotal: allFiles.length,
        remaining,
        continueProcessing: !isComplete
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Transcribe-batch error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
