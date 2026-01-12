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

// Get valid access token
async function getValidAccessToken(
  supabase: any,
  account: any,
  encryptionKey: string
): Promise<string> {
  const expiresAt = new Date(account.token_expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;
  
  if (expiresAt.getTime() - now.getTime() < bufferMs && account.refresh_token) {
    return refreshGoogleToken(supabase, account, encryptionKey);
  }
  
  return decryptToken(account.access_token, encryptionKey);
}

// Use AI to detect if attachment is an invoice
async function detectInvoice(
  filename: string, 
  mimeType: string, 
  subject: string, 
  sender: string,
  filenameKeywords: string[]
): Promise<{ isInvoice: boolean; confidence: number; vendor?: string; amount?: number }> {
  // First do quick keyword check
  const filenameMatch = filenameKeywords.some(keyword => 
    filename.toLowerCase().includes(keyword.toLowerCase())
  );
  const subjectMatch = filenameKeywords.some(keyword => 
    subject.toLowerCase().includes(keyword.toLowerCase())
  );
  
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    console.log("LOVABLE_API_KEY not configured, using heuristic detection");
    // Fallback to heuristic detection
    const isLikelyInvoice = filenameMatch || subjectMatch;
    return { isInvoice: isLikelyInvoice, confidence: isLikelyInvoice ? 0.7 : 0.3 };
  }

  const prompt = `Analyze this email attachment and determine if it's likely an invoice/bill/receipt.

Filename: ${filename}
MIME Type: ${mimeType}
Email Subject: ${subject}
Sender: ${sender}

Based on these indicators, is this likely an invoice?`;

  try {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are an AI that detects invoices. Respond with JSON only: {\"isInvoice\": boolean, \"confidence\": 0-1, \"vendor\": string or null, \"estimatedAmount\": number or null}" },
          { role: "user", content: prompt }
        ],
        tools: [{
          type: "function",
          function: {
            name: "invoice_detection",
            description: "Detect if an attachment is an invoice",
            parameters: {
              type: "object",
              properties: {
                isInvoice: { type: "boolean" },
                confidence: { type: "number" },
                vendor: { type: "string" },
                estimatedAmount: { type: "number" }
              },
              required: ["isInvoice", "confidence"]
            }
          }
        }],
        tool_choice: { type: "function", function: { name: "invoice_detection" } }
      }),
    });

    if (!response.ok) {
      console.error("AI detection failed:", response.status);
      return { isInvoice: false, confidence: 0.5 };
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const result = JSON.parse(toolCall.function.arguments);
      return {
        isInvoice: result.isInvoice,
        confidence: result.confidence,
        vendor: result.vendor,
        amount: result.estimatedAmount
      };
    }
  } catch (e) {
    console.error("AI detection error:", e);
  }

  return { isInvoice: false, confidence: 0.5 };
}

// Extract header value from Gmail message
function getHeader(message: any, name: string): string {
  const header = message.payload?.headers?.find(
    (h: { name: string }) => h.name.toLowerCase() === name.toLowerCase()
  );
  return header?.value || "";
}

// Base64 URL decode
function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
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

    const { 
      action, 
      jobId, 
      dateFrom, 
      dateTo, 
      labelIds, 
      maxEmails = 100,
      senderFilter,
      subjectKeywords,
      filenameKeywords = "invoice,bill,receipt,facture,rechnung",
      confidenceThreshold = 0.6,
      includeImages = true,
      includePdfs = true
    } = await req.json();
    console.log("Invoice scan request:", { action, userId: user.id, jobId, maxEmails });

    // Get Gmail account
    const { data: accounts } = await supabase
      .from("connected_accounts")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider", "gmail")
      .limit(1);

    if (!accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({ error: "Gmail not connected" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const account = accounts[0];

    if (action === "start") {
      // Create a new scan job
      const { data: job, error: jobError } = await supabase
        .from("invoice_scan_jobs")
        .insert({
          user_id: user.id,
          status: "pending",
          date_from: dateFrom,
          date_to: dateTo,
          labels: labelIds,
        })
        .select()
        .single();

      if (jobError) throw jobError;

      return new Response(
        JSON.stringify({ job }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "process") {
      // Process the scan job
      if (!jobId) {
        return new Response(
          JSON.stringify({ error: "jobId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get job details
      const { data: job, error: jobError } = await supabase
        .from("invoice_scan_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("user_id", user.id)
        .single();

      if (jobError || !job) {
        return new Response(
          JSON.stringify({ error: "Job not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update job status to processing
      await supabase
        .from("invoice_scan_jobs")
        .update({ status: "processing", started_at: new Date().toISOString() })
        .eq("id", jobId);

      const accessToken = await getValidAccessToken(supabase, account, encryptionKey);

      // Build Gmail search query
      let searchQuery = "has:attachment";
      if (job.date_from) {
        const fromDate = new Date(job.date_from);
        searchQuery += ` after:${fromDate.getFullYear()}/${fromDate.getMonth() + 1}/${fromDate.getDate()}`;
      }
      if (job.date_to) {
        const toDate = new Date(job.date_to);
        searchQuery += ` before:${toDate.getFullYear()}/${toDate.getMonth() + 1}/${toDate.getDate()}`;
      }
      if (senderFilter) {
        searchQuery += ` from:(${senderFilter})`;
      }
      if (subjectKeywords) {
        const keywords = subjectKeywords.split(",").map((k: string) => k.trim()).filter(Boolean);
        if (keywords.length > 0) {
          searchQuery += ` subject:(${keywords.join(" OR ")})`;
        }
      }

      // Parse filename keywords for detection
      const filenameKeywordList = filenameKeywords.split(",").map((k: string) => k.trim()).filter(Boolean);

      // Search for emails with attachments
      let messagesUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxEmails}&q=${encodeURIComponent(searchQuery)}`;
      if (job.labels && job.labels.length > 0) {
        messagesUrl += `&labelIds=${job.labels.join(",")}`;
      }

      const messagesResponse = await fetch(messagesUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!messagesResponse.ok) {
        const error = await messagesResponse.json();
        throw new Error(error.error?.message || "Failed to fetch messages");
      }

      const messagesData = await messagesResponse.json();
      const messageIds = messagesData.messages || [];
      
      let emailsScanned = 0;
      let invoicesFound = 0;

      for (const msg of messageIds) {
        try {
          // Get full message
          const msgResponse = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const message = await msgResponse.json();

          const subject = getHeader(message, "Subject");
          const from = getHeader(message, "From");
          const date = getHeader(message, "Date");

          // Find attachments
          const parts = message.payload?.parts || [];
          for (const part of parts) {
            if (part.filename && part.body?.attachmentId) {
              const mimeType = part.mimeType || "";
              
              // Filter by file type preferences
              const isPdf = mimeType.includes("pdf");
              const isImage = mimeType.startsWith("image/");
              
              if (isPdf && !includePdfs) continue;
              if (isImage && !includeImages) continue;
              if (!isPdf && !isImage) continue;

              // Detect if it's an invoice
              const detection = await detectInvoice(part.filename, mimeType, subject, from, filenameKeywordList);
              
              if (detection.isInvoice && detection.confidence >= confidenceThreshold) {
                // Download attachment
                const attachmentResponse = await fetch(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/attachments/${part.body.attachmentId}`,
                  { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                const attachmentData = await attachmentResponse.json();
                
                if (attachmentData.data) {
                  const fileData = base64UrlDecode(attachmentData.data);
                  const storagePath = `${user.id}/${msg.id}_${part.filename}`;
                  
                  // Upload to storage
                  const { error: uploadError } = await supabase.storage
                    .from("invoices")
                    .upload(storagePath, fileData, {
                      contentType: mimeType,
                      upsert: true
                    });

                  if (!uploadError) {
                    // Save invoice record
                    await supabase.from("scanned_invoices").insert({
                      user_id: user.id,
                      email_id: msg.id,
                      email_subject: subject,
                      email_from: from,
                      email_date: date ? new Date(date).toISOString() : null,
                      invoice_filename: part.filename,
                      invoice_storage_path: storagePath,
                      invoice_amount: detection.amount,
                      vendor_name: detection.vendor,
                      confidence_score: detection.confidence,
                      status: "saved"
                    });
                    
                    invoicesFound++;
                  }
                }
              }
            }
          }
          
          emailsScanned++;

          // Update job progress periodically
          if (emailsScanned % 10 === 0) {
            await supabase
              .from("invoice_scan_jobs")
              .update({ emails_scanned: emailsScanned, invoices_found: invoicesFound })
              .eq("id", jobId);
          }
        } catch (msgError) {
          console.error(`Error processing message ${msg.id}:`, msgError);
        }
      }

      // Mark job complete
      await supabase
        .from("invoice_scan_jobs")
        .update({
          status: "completed",
          emails_scanned: emailsScanned,
          invoices_found: invoicesFound,
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);

      return new Response(
        JSON.stringify({ success: true, emailsScanned, invoicesFound }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "status") {
      // Get job status
      const { data: jobs } = await supabase
        .from("invoice_scan_jobs")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      return new Response(
        JSON.stringify({ jobs }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "invoices") {
      // Get scanned invoices
      const { data: invoices } = await supabase
        .from("scanned_invoices")
        .select("*")
        .eq("user_id", user.id)
        .order("email_date", { ascending: false });

      return new Response(
        JSON.stringify({ invoices }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Invoice scan error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
