import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { OneDriveIcon, GoogleDriveIcon, SyncIcon } from "@/components/icons/CloudIcons";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { getFreshSession, verifySession } from "@/lib/auth-helpers";
import { invokeFunction } from "@/lib/functions-fetch";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionSelector } from "@/components/sync/PermissionSelector";

interface ConnectedAccount {
  id: string;
  provider: string;
  account_email: string | null;
  account_name: string | null;
  permission_level: string | null;
}

interface ConnectionFlowProps {
  isActive: boolean;
}

export const ConnectionFlow = ({ isActive }: ConnectionFlowProps) => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissionDialog, setPermissionDialog] = useState<{
    open: boolean;
    provider: "microsoft" | "google" | null;
  }>({ open: false, provider: null });
  const [selectedPermission, setSelectedPermission] = useState<"read_only" | "read_write">("read_write");

  useEffect(() => {
    if (user) {
      fetchConnectedAccounts();
    }
  }, [user]);

  const fetchConnectedAccounts = async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from("connected_accounts")
        .select("id, provider, account_email, account_name, permission_level")
        .eq("user_id", user.id);

      if (error) throw error;
      setConnectedAccounts(data || []);
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    } finally {
      setLoading(false);
    }
  };

  const openPermissionDialog = (provider: "microsoft" | "google") => {
    setSelectedPermission("read_write");
    setPermissionDialog({ open: true, provider });
  };

  const handleConnect = async () => {
    const provider = permissionDialog.provider;
    if (!user || !provider) {
      toast.error("Please sign in first");
      return;
    }

    setPermissionDialog({ open: false, provider: null });
    setConnecting(provider);

    try {
      // Get a fresh session with auto-refresh if near expiry
      const freshSession = await getFreshSession();
      
      if (!freshSession?.access_token) {
        toast.error("Your session expired. Please sign in again.");
        await signOut();
        navigate("/auth");
        return;
      }

      // Verify the token is actually valid
      const isValid = await verifySession(freshSession);
      if (!isValid) {
        toast.error("Your session is invalid. Please sign in again.");
        await signOut();
        navigate("/auth");
        return;
      }

      console.log("oauth-connect invoke: has token", !!freshSession.access_token, "expires_at", freshSession.expires_at);

      const redirectUri = `${window.location.origin}/oauth/callback`;

      const { data, error } = await invokeFunction<{ authUrl?: string; error?: string }>(
        "oauth-connect",
        {
          body: { provider, redirectUri, permissionLevel: selectedPermission },
          accessToken: freshSession.access_token,
        }
      );

      if (error) {
        throw error;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      if (!data?.authUrl) {
        throw new Error("No auth URL returned");
      }

      // Store permission level in sessionStorage for callback
      sessionStorage.setItem("oauth_permission_level", selectedPermission);

      // Redirect to OAuth provider
      window.location.href = data.authUrl;
    } catch (err: any) {
      console.error("Connection error:", err);
      toast.error(err.message || "Failed to connect");
      setConnecting(null);
    }
  };

  const isConnected = (provider: string) => {
    return connectedAccounts.some(acc => 
      (provider === "microsoft" && acc.provider === "onedrive") ||
      (provider === "google" && acc.provider === "google_drive")
    );
  };

  const getAccountInfo = (provider: string) => {
    const providerKey = provider === "microsoft" ? "onedrive" : "google_drive";
    return connectedAccounts.find(acc => acc.provider === providerKey);
  };

  const onedriveConnected = isConnected("microsoft");
  const googleConnected = isConnected("google");
  const bothConnected = onedriveConnected && googleConnected;

  return (
    <>
      <div className="glass rounded-xl p-8 relative overflow-hidden">
        <div className="flex items-center justify-center gap-8">
          {/* OneDrive */}
          <div className="flex flex-col items-center gap-3">
            <div className={`p-6 rounded-2xl bg-onedrive/20 border-2 transition-all duration-500 ${
              onedriveConnected 
                ? 'border-onedrive shadow-lg shadow-onedrive/20' 
                : 'border-onedrive/30'
            } ${isActive && onedriveConnected ? 'animate-pulse-slow' : ''}`}>
              <OneDriveIcon className="w-12 h-12 text-onedrive" />
            </div>
            <span className="font-display font-medium text-foreground">OneDrive</span>
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            ) : onedriveConnected ? (
              <div className="flex items-center gap-1 text-sm text-green-500">
                <Check className="w-4 h-4" />
                <span>Connected</span>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={() => openPermissionDialog("microsoft")}
                disabled={connecting !== null}
                className="bg-onedrive hover:bg-onedrive/90"
              >
                {connecting === "microsoft" ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : null}
                Connect
              </Button>
            )}
            {onedriveConnected && getAccountInfo("microsoft") && (
              <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                {getAccountInfo("microsoft")?.account_email}
              </span>
            )}
          </div>
          
          {/* Connection Line */}
          <div className="flex items-center gap-4 px-4">
            <div className={`h-0.5 w-12 bg-gradient-to-r from-onedrive to-transparent transition-all duration-500 ${
              onedriveConnected ? 'opacity-100' : 'opacity-30'
            } ${isActive && bothConnected ? 'animate-pulse' : ''}`} />
            <div className={`p-3 rounded-full bg-secondary border transition-all duration-300 ${
              bothConnected 
                ? 'border-primary shadow-lg shadow-primary/20' 
                : 'border-border'
            }`}>
              <SyncIcon className="w-6 h-6 text-primary" spinning={isActive && bothConnected} />
            </div>
            <div className={`h-0.5 w-12 bg-gradient-to-l from-google-drive to-transparent transition-all duration-500 ${
              googleConnected ? 'opacity-100' : 'opacity-30'
            } ${isActive && bothConnected ? 'animate-pulse' : ''}`} />
          </div>
          
          {/* Google Drive */}
          <div className="flex flex-col items-center gap-3">
            <div className={`p-6 rounded-2xl bg-google-drive/20 border-2 transition-all duration-500 ${
              googleConnected 
                ? 'border-google-drive shadow-lg shadow-google-drive/20' 
                : 'border-google-drive/30'
            } ${isActive && googleConnected ? 'animate-pulse-slow' : ''}`}>
              <GoogleDriveIcon className="w-12 h-12 text-google-drive" />
            </div>
            <span className="font-display font-medium text-foreground">Google Drive</span>
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            ) : googleConnected ? (
              <div className="flex items-center gap-1 text-sm text-green-500">
                <Check className="w-4 h-4" />
                <span>Connected</span>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={() => openPermissionDialog("google")}
                disabled={connecting !== null}
                className="bg-google-drive hover:bg-google-drive/90"
              >
                {connecting === "google" ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : null}
                Connect
              </Button>
            )}
            {googleConnected && getAccountInfo("google") && (
              <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                {getAccountInfo("google")?.account_email}
              </span>
            )}
          </div>
        </div>
        
        {/* Background glow */}
        {isActive && bothConnected && (
          <>
            <div className="absolute inset-0 bg-gradient-to-r from-onedrive/5 via-transparent to-google-drive/5 pointer-events-none" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
          </>
        )}
      </div>

      <Dialog open={permissionDialog.open} onOpenChange={(open) => setPermissionDialog({ ...permissionDialog, open })}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Connect {permissionDialog.provider === "microsoft" ? "OneDrive" : "Google Drive"}
            </DialogTitle>
            <DialogDescription>
              Choose the level of access you want to grant. You can always reconnect later to change permissions.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <PermissionSelector
              value={selectedPermission}
              onChange={setSelectedPermission}
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setPermissionDialog({ open: false, provider: null })}>
              Cancel
            </Button>
            <Button onClick={handleConnect}>
              Connect with {selectedPermission === "read_only" ? "Read Only" : "Full"} Access
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};