import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Mail, Paperclip, Download, User, Clock, ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: { name: string; value: string }[];
    parts?: any[];
    body?: { data?: string };
    mimeType?: string;
  };
  internalDate: string;
}

interface EmailViewerProps {
  message: GmailMessage | null;
}

interface Attachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export const EmailViewer = ({ message }: EmailViewerProps) => {
  const [fullMessage, setFullMessage] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [emailBody, setEmailBody] = useState("");

  useEffect(() => {
    if (message) {
      fetchFullMessage(message.id);
    } else {
      setFullMessage(null);
      setEmailBody("");
      setAttachments([]);
    }
  }, [message?.id]);

  const fetchFullMessage = async (messageId: string) => {
    setLoading(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke("gmail-browse", {
        body: { action: "get", messageId },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;
      
      const msg = response.data.message;
      setFullMessage(msg);
      
      // Extract body and attachments
      const { body, attachments } = extractContent(msg.payload);
      setEmailBody(body);
      setAttachments(attachments);
    } catch (error) {
      console.error("Error fetching message:", error);
    } finally {
      setLoading(false);
    }
  };

  const extractContent = (payload: any): { body: string; attachments: Attachment[] } => {
    let body = "";
    const attachments: Attachment[] = [];

    const processPayload = (part: any) => {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0,
        });
      }

      if (part.mimeType === "text/html" && part.body?.data) {
        body = decodeBase64Url(part.body.data);
      } else if (part.mimeType === "text/plain" && !body && part.body?.data) {
        body = decodeBase64Url(part.body.data);
      }

      if (part.parts) {
        part.parts.forEach(processPayload);
      }
    };

    processPayload(payload);

    // If no body found in parts, check the main body
    if (!body && payload.body?.data) {
      body = decodeBase64Url(payload.body.data);
    }

    return { body, attachments };
  };

  const decodeBase64Url = (str: string): string => {
    try {
      const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      return decodeURIComponent(escape(atob(padded)));
    } catch {
      return str;
    }
  };

  const downloadAttachment = async (attachment: Attachment) => {
    if (!message) return;

    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await supabase.functions.invoke("gmail-browse", {
        body: { 
          action: "attachment", 
          messageId: message.id,
          attachmentId: attachment.attachmentId 
        },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (response.error) throw response.error;

      const data = response.data.attachment.data;
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const blob = new Blob([bytes], { type: attachment.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error downloading attachment:", error);
    }
  };

  const getHeader = (name: string): string => {
    if (!fullMessage) return "";
    const header = fullMessage.payload?.headers?.find(
      (h: { name: string }) => h.name.toLowerCase() === name.toLowerCase()
    );
    return header?.value || "";
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  if (!message) {
    return (
      <Card className="h-[calc(100vh-220px)] flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Mail className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>Select an email to read</p>
        </div>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="h-[calc(100vh-220px)]">
        <CardHeader className="space-y-4">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-[calc(100vh-220px)]">
      <CardHeader className="border-b">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">
            {getHeader("Subject") || "(no subject)"}
          </h2>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4" />
              <span>{getHeader("From")}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              <span>
                {message.internalDate && 
                  format(new Date(parseInt(message.internalDate)), "MMM d, yyyy h:mm a")}
              </span>
            </div>
          </div>
          {getHeader("To") && (
            <p className="text-sm text-muted-foreground">
              To: {getHeader("To")}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[calc(100vh-400px)]">
          {/* Attachments */}
          {attachments.length > 0 && (
            <div className="p-4 border-b">
              <div className="flex items-center gap-2 mb-3">
                <Paperclip className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {attachments.length} Attachment{attachments.length > 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment, index) => (
                  <Button
                    key={index}
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => downloadAttachment(attachment)}
                  >
                    <Download className="w-3 h-3" />
                    <span className="max-w-[150px] truncate">{attachment.filename}</span>
                    <Badge variant="secondary" className="text-xs">
                      {formatBytes(attachment.size)}
                    </Badge>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Email Body */}
          <div className="p-4">
            {emailBody.includes("<") ? (
              <div 
                className="prose prose-sm max-w-none dark:prose-invert"
                dangerouslySetInnerHTML={{ __html: emailBody }} 
              />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm">
                {emailBody}
              </pre>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
