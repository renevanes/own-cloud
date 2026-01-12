import React, { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mail, Shield, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getFreshSession, verifySession } from "@/lib/auth-helpers";

interface GmailConnectProps {
  onConnected: () => void;
}

export const GmailConnect = ({ onConnected }: GmailConnectProps) => {
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);

    try {
      // Get fresh session
      const freshSession = await getFreshSession();
      if (!freshSession) {
        toast({
          title: "Session Error",
          description: "Please sign in again",
          variant: "destructive",
        });
        return;
      }

      // Verify session
      const isValid = await verifySession(freshSession);
      if (!isValid) {
        toast({
          title: "Session Error",
          description: "Session expired. Please sign in again.",
          variant: "destructive",
        });
        return;
      }

      const redirectUri = `${window.location.origin}/oauth/callback`;

      // Call oauth-connect with gmail provider
      const response = await supabase.functions.invoke("oauth-connect", {
        body: {
          provider: "google",
          redirectUri,
          permissionLevel: "read_only",
          service: "gmail", // Indicate this is for Gmail
        },
        headers: {
          Authorization: `Bearer ${freshSession.access_token}`,
        },
      });

      if (response.error) {
        throw new Error(response.error.message || "Failed to start OAuth flow");
      }

      if (response.data?.authUrl) {
        // Store that this is a Gmail connection
        sessionStorage.setItem("oauth_service", "gmail");
        window.location.href = response.data.authUrl;
      } else {
        throw new Error("No authorization URL received");
      }
    } catch (error: any) {
      console.error("Gmail connect error:", error);
      toast({
        title: "Connection Error",
        description: error.message || "Failed to connect Gmail",
        variant: "destructive",
      });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto p-4 rounded-full bg-primary/10 w-fit mb-4">
            <Mail className="w-12 h-12 text-primary" />
          </div>
          <CardTitle className="text-2xl">Connect Your Gmail</CardTitle>
          <CardDescription>
            Connect your Gmail account to browse and manage your emails
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
              <div>
                <p className="font-medium">Read your emails</p>
                <p className="text-sm text-muted-foreground">
                  Browse your inbox, sent items, and labels
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
              <div>
                <p className="font-medium">Search and filter</p>
                <p className="text-sm text-muted-foreground">
                  Find specific emails using powerful search
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
              <div>
                <p className="font-medium">Scan for invoices</p>
                <p className="text-sm text-muted-foreground">
                  Automatically detect and save invoice attachments
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 p-4 rounded-lg bg-muted">
            <Shield className="w-5 h-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              We only request read-only access to your emails. Your data is encrypted and secure.
            </p>
          </div>

          <Button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full"
            size="lg"
          >
            {connecting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                Connecting...
              </>
            ) : (
              <>
                <Mail className="w-5 h-5 mr-2" />
                Connect Gmail
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
