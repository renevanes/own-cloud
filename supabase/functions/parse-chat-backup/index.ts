import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ParsedMessage {
  sender: string;
  content: string;
  sentAt: string;
  messageType: 'text' | 'media' | 'system';
  isOutgoing: boolean;
}

interface ParsedConversation {
  name: string;
  phoneNumber?: string;
  messages: ParsedMessage[];
}

// Parse WhatsApp chat export format
function parseWhatsAppChat(content: string, userIdentifier?: string): ParsedConversation[] {
  const lines = content.split('\n');
  const messages: ParsedMessage[] = [];
  
  // WhatsApp patterns - handle various date/time formats
  const patterns = [
    // DD/MM/YYYY, HH:MM - Sender: Message (European format)
    /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*[-–]\s*([^:]+):\s*(.*)$/i,
    // [DD/MM/YYYY, HH:MM:SS] Sender: Message (Bracketed format)
    /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]+):\s*(.*)$/i,
    // MM/DD/YYYY, HH:MM - Sender: Message (US format)
    /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*[-–]\s*([^:]+):\s*(.*)$/i,
  ];

  // System message patterns
  const systemPatterns = [
    /messages and calls are end-to-end encrypted/i,
    /created group/i,
    /added you/i,
    /left the group/i,
    /changed the subject/i,
    /changed the group/i,
    /security code changed/i,
  ];

  let currentMessage: ParsedMessage | null = null;
  const senders = new Set<string>();

  for (const line of lines) {
    let matched = false;
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        // Save previous message if exists
        if (currentMessage) {
          messages.push(currentMessage);
        }

        const [, datePart, timePart, sender, content] = match;
        const senderTrimmed = sender.trim();
        senders.add(senderTrimmed);
        
        // Parse date - try different formats
        let parsedDate: Date;
        try {
          const parts = datePart.split('/');
          const day = parseInt(parts[0]);
          const month = parseInt(parts[1]) - 1;
          let year = parseInt(parts[2]);
          if (year < 100) year += 2000;
          
          // Parse time
          let hours = 0, minutes = 0, seconds = 0;
          const timeMatch = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?/i);
          if (timeMatch) {
            hours = parseInt(timeMatch[1]);
            minutes = parseInt(timeMatch[2]);
            seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
            if (timeMatch[4]) {
              if (timeMatch[4].toUpperCase() === 'PM' && hours !== 12) hours += 12;
              if (timeMatch[4].toUpperCase() === 'AM' && hours === 12) hours = 0;
            }
          }
          
          parsedDate = new Date(year, month, day, hours, minutes, seconds);
        } catch {
          parsedDate = new Date();
        }

        // Detect message type
        let messageType: 'text' | 'media' | 'system' = 'text';
        const contentLower = content.toLowerCase();
        
        if (systemPatterns.some(p => p.test(content))) {
          messageType = 'system';
        } else if (
          contentLower.includes('<media omitted>') ||
          contentLower.includes('image omitted') ||
          contentLower.includes('video omitted') ||
          contentLower.includes('audio omitted') ||
          contentLower.includes('sticker omitted') ||
          contentLower.includes('gif omitted')
        ) {
          messageType = 'media';
        }

        // Determine if outgoing
        const isOutgoing = userIdentifier 
          ? senderTrimmed.toLowerCase().includes(userIdentifier.toLowerCase())
          : false;

        currentMessage = {
          sender: senderTrimmed,
          content: content.trim(),
          sentAt: parsedDate.toISOString(),
          messageType,
          isOutgoing,
        };
        
        matched = true;
        break;
      }
    }

    // If no match, this might be a continuation of the previous message
    if (!matched && currentMessage && line.trim()) {
      currentMessage.content += '\n' + line.trim();
    }
  }

  // Don't forget the last message
  if (currentMessage) {
    messages.push(currentMessage);
  }

  // Extract conversation name from senders (exclude user)
  const otherSenders = Array.from(senders).filter(s => 
    !userIdentifier || !s.toLowerCase().includes(userIdentifier.toLowerCase())
  );
  
  const conversationName = otherSenders.length > 0 
    ? otherSenders.join(', ') 
    : 'WhatsApp Chat';

  return [{
    name: conversationName,
    messages,
  }];
}

// Parse SMS Backup & Restore XML format
function parseSmsBackup(content: string): ParsedConversation[] {
  const conversations = new Map<string, ParsedConversation>();
  
  // Match SMS entries - handle both self-closing and regular tags
  const smsPattern = /<sms[^>]*\/?>/gi;
  const matches = content.match(smsPattern) || [];

  for (const match of matches) {
    // Extract attributes
    const getAttr = (name: string): string => {
      const attrMatch = match.match(new RegExp(`${name}="([^"]*)"`, 'i'));
      return attrMatch ? attrMatch[1] : '';
    };

    const address = getAttr('address');
    const date = getAttr('date');
    const type = getAttr('type');
    const body = getAttr('body');
    const contactName = getAttr('contact_name') || address;

    if (!address || !body) continue;

    // Type: 1 = received, 2 = sent
    const isOutgoing = type === '2';
    
    // Parse date from Unix timestamp (milliseconds)
    let sentAt: string;
    try {
      sentAt = new Date(parseInt(date)).toISOString();
    } catch {
      sentAt = new Date().toISOString();
    }

    // Decode HTML entities
    const decodedBody = body
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

    const message: ParsedMessage = {
      sender: isOutgoing ? 'Me' : contactName,
      content: decodedBody,
      sentAt,
      messageType: 'text',
      isOutgoing,
    };

    // Group by phone number
    if (!conversations.has(address)) {
      conversations.set(address, {
        name: contactName !== '(Unknown)' ? contactName : address,
        phoneNumber: address,
        messages: [],
      });
    }
    
    conversations.get(address)!.messages.push(message);
  }

  // Sort messages within each conversation
  for (const conv of conversations.values()) {
    conv.messages.sort((a, b) => 
      new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()
    );
  }

  return Array.from(conversations.values());
}

// Detect file format
function detectFormat(content: string, filename: string): 'whatsapp' | 'sms' | 'unknown' {
  const lowerFilename = filename.toLowerCase();
  
  // Check filename hints
  if (lowerFilename.includes('whatsapp')) return 'whatsapp';
  if (lowerFilename.includes('sms') && lowerFilename.endsWith('.xml')) return 'sms';
  
  // Check content
  const trimmedContent = content.trim();
  
  // XML signature for SMS backup
  if (trimmedContent.startsWith('<?xml') || trimmedContent.startsWith('<smses')) {
    return 'sms';
  }
  
  // WhatsApp patterns in content
  const whatsappPattern = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/m;
  if (whatsappPattern.test(content)) {
    return 'whatsapp';
  }

  return 'unknown';
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      throw new Error("Unauthorized");
    }

    const { content, filename, sourceType, userIdentifier, saveToDatabase } = await req.json();

    if (!content || !filename) {
      throw new Error("Missing content or filename");
    }

    console.log(`Parsing chat backup: ${filename}, sourceType hint: ${sourceType}`);

    // Detect format
    const format = sourceType || detectFormat(content, filename);
    console.log(`Detected format: ${format}`);

    if (format === 'unknown') {
      throw new Error("Unable to detect chat format. Please ensure the file is a WhatsApp export (.txt) or SMS Backup & Restore export (.xml)");
    }

    // Parse based on format
    let conversations: ParsedConversation[];
    
    if (format === 'whatsapp') {
      conversations = parseWhatsAppChat(content, userIdentifier);
    } else {
      conversations = parseSmsBackup(content);
    }

    console.log(`Parsed ${conversations.length} conversations`);

    // If saveToDatabase is true, store in Supabase
    if (saveToDatabase) {
      for (const conv of conversations) {
        if (conv.messages.length === 0) continue;

        // Sort messages by date
        conv.messages.sort((a, b) => 
          new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()
        );

        // Create conversation record
        const { data: convData, error: convError } = await supabase
          .from('chat_conversations')
          .insert({
            user_id: user.id,
            name: conv.name,
            phone_number: conv.phoneNumber || null,
            source_type: format,
            source_file: filename,
            message_count: conv.messages.length,
            first_message_at: conv.messages[0]?.sentAt,
            last_message_at: conv.messages[conv.messages.length - 1]?.sentAt,
          })
          .select()
          .single();

        if (convError) {
          console.error('Error creating conversation:', convError);
          throw new Error(`Failed to create conversation: ${convError.message}`);
        }

        console.log(`Created conversation: ${convData.id} with ${conv.messages.length} messages`);

        // Insert messages in batches
        const batchSize = 100;
        for (let i = 0; i < conv.messages.length; i += batchSize) {
          const batch = conv.messages.slice(i, i + batchSize).map(msg => ({
            conversation_id: convData.id,
            user_id: user.id,
            sender: msg.sender,
            content: msg.content,
            message_type: msg.messageType,
            sent_at: msg.sentAt,
            is_outgoing: msg.isOutgoing,
          }));

          const { error: msgError } = await supabase
            .from('chat_messages')
            .insert(batch);

          if (msgError) {
            console.error('Error inserting messages:', msgError);
            throw new Error(`Failed to insert messages: ${msgError.message}`);
          }
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        format,
        conversations: conversations.map(c => ({
          name: c.name,
          phoneNumber: c.phoneNumber,
          messageCount: c.messages.length,
          firstMessageAt: c.messages[0]?.sentAt,
          lastMessageAt: c.messages[c.messages.length - 1]?.sentAt,
          messages: saveToDatabase ? undefined : c.messages,
        })),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error: unknown) {
    console.error("Error parsing chat backup:", error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      }
    );
  }
});
