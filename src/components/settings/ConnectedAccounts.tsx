import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useConnectedAccounts, ConnectedAccount } from '@/hooks/useConnectedAccounts';
import { supabase } from '@/integrations/supabase/client';
import { getFreshSession, verifySession } from '@/lib/auth-helpers';
import { invokeFunction } from '@/lib/functions-fetch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { 
  AlertDialog, 
  AlertDialogAction, 
  AlertDialogCancel, 
  AlertDialogContent, 
  AlertDialogDescription, 
  AlertDialogFooter, 
  AlertDialogHeader, 
  AlertDialogTitle 
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loader2, Unlink, CheckCircle2, RefreshCw, Shield, ShieldCheck, Plus, Cloud } from 'lucide-react';
import { OneDriveIcon, GoogleDriveIcon } from '@/components/icons/CloudIcons';
import { PermissionSelector } from '@/components/sync/PermissionSelector';
import { toast } from 'sonner';

// AWS S3 Icon component
const AWSS3Icon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18l7.09 3.54L12 11.27 4.91 7.72 12 4.18zM4 9.09l7 3.5v7.32l-7-3.5V9.09zm9 10.82v-7.32l7-3.5v7.32l-7 3.5z"/>
  </svg>
);

interface ProviderConfig {
  id: string;
  name: string;
  icon: React.FC<{ className?: string }>;
  color: string;
  providerKey: string;
  authProvider?: 'microsoft' | 'google';
  isCustom?: boolean;
}

const providerConfigs: ProviderConfig[] = [
  {
    id: 'onedrive',
    name: 'OneDrive',
    icon: OneDriveIcon,
    color: 'text-[#0078D4]',
    providerKey: 'onedrive',
    authProvider: 'microsoft',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    icon: GoogleDriveIcon,
    color: 'text-[#4285F4]',
    providerKey: 'google_drive',
    authProvider: 'google',
  },
  {
    id: 'aws_s3',
    name: 'AWS S3',
    icon: AWSS3Icon,
    color: 'text-[#FF9900]',
    providerKey: 'aws_s3',
    isCustom: true,
  },
];

export const ConnectedAccounts: React.FC = () => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { accounts, refetch } = useConnectedAccounts();
  
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; accountId: string; name: string }>({ 
    open: false, 
    accountId: '', 
    name: '' 
  });
  const [permissionDialog, setPermissionDialog] = useState<{
    open: boolean;
    provider: ProviderConfig | null;
  }>({ open: false, provider: null });
  const [selectedPermission, setSelectedPermission] = useState<"read_only" | "read_write">("read_write");
  
  // AWS S3 form state
  const [s3Dialog, setS3Dialog] = useState(false);
  const [s3Form, setS3Form] = useState({
    accessKeyId: '',
    secretAccessKey: '',
    region: '',
    bucketName: '',
    accountName: '',
  });
  const [savingS3, setSavingS3] = useState(false);

  const openPermissionDialog = (provider: ProviderConfig) => {
    if (provider.isCustom) {
      if (provider.id === 'aws_s3') {
        setS3Dialog(true);
      }
    } else {
      setSelectedPermission("read_write");
      setPermissionDialog({ open: true, provider });
    }
  };

  const handleConnect = async () => {
    const provider = permissionDialog.provider;
    if (!user || !provider || !provider.authProvider) {
      toast.error("Please sign in first");
      return;
    }

    setPermissionDialog({ open: false, provider: null });
    setConnecting(provider.id);

    try {
      const freshSession = await getFreshSession();
      
      if (!freshSession?.access_token) {
        toast.error("Your session expired. Please sign in again.");
        await signOut();
        navigate("/auth");
        return;
      }

      const isValid = await verifySession(freshSession);
      if (!isValid) {
        toast.error("Your session is invalid. Please sign in again.");
        await signOut();
        navigate("/auth");
        return;
      }

      const redirectUri = `${window.location.origin}/oauth/callback`;

      const { data, error } = await invokeFunction<{ authUrl?: string; error?: string }>(
        "oauth-connect",
        {
          body: { provider: provider.authProvider, redirectUri, permissionLevel: selectedPermission },
          accessToken: freshSession.access_token,
        }
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.authUrl) throw new Error("No auth URL returned");

      sessionStorage.setItem("oauth_permission_level", selectedPermission);
      window.location.href = data.authUrl;
    } catch (err: any) {
      console.error("Connection error:", err);
      toast.error(err.message || "Failed to connect");
      setConnecting(null);
    }
  };

  const handleSaveS3 = async () => {
    if (!user) return;
    
    if (!s3Form.accessKeyId || !s3Form.secretAccessKey || !s3Form.region || !s3Form.bucketName) {
      toast.error("Please fill in all required fields");
      return;
    }

    setSavingS3(true);
    try {
      // Get fresh session for authenticated request
      const freshSession = await getFreshSession();
      if (!freshSession?.access_token) {
        toast.error("Your session expired. Please sign in again.");
        await signOut();
        navigate("/auth");
        return;
      }

      // Use edge function to encrypt and store credentials securely
      const { data, error } = await invokeFunction<{ success: boolean; accountId?: string; error?: string }>(
        "store-s3-credentials",
        {
          body: {
            accessKeyId: s3Form.accessKeyId,
            secretAccessKey: s3Form.secretAccessKey,
            region: s3Form.region,
            bucketName: s3Form.bucketName,
            accountName: s3Form.accountName,
          },
          accessToken: freshSession.access_token,
        }
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success("AWS S3 bucket connected securely!");
      setS3Dialog(false);
      setS3Form({ accessKeyId: '', secretAccessKey: '', region: '', bucketName: '', accountName: '' });
      refetch();
    } catch (err: any) {
      console.error("S3 connection error:", err);
      toast.error(err.message || "Failed to connect S3");
    } finally {
      setSavingS3(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!user) return;
    
    setDisconnecting(accountId);
    try {
      const { error: accountError } = await supabase
        .from('connected_accounts')
        .delete()
        .eq('id', accountId);

      if (accountError) throw accountError;

      toast.success("Account disconnected");
      refetch();
    } catch (error) {
      console.error('Error disconnecting account:', error);
      toast.error('Failed to disconnect account');
    } finally {
      setDisconnecting(null);
      setConfirmDialog({ open: false, accountId: '', name: '' });
    }
  };

  const openDisconnectDialog = (accountId: string, name: string) => {
    setConfirmDialog({ open: true, accountId, name });
  };

  const formatStorage = (bytes: number | null | undefined) => {
    if (!bytes) return '0 GB';
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const getProviderConfig = (providerKey: string) => {
    return providerConfigs.find(p => p.providerKey === providerKey);
  };

  const getAccountsByProvider = (providerKey: string): ConnectedAccount[] => {
    return accounts.filter(acc => acc.provider === providerKey);
  };

  return (
    <>
      <Card className="glass border-border/50">
        <CardHeader>
          <CardTitle className="text-xl">Connected Accounts</CardTitle>
          <CardDescription>
            Manage your connected cloud storage accounts. You can connect multiple accounts of the same type.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {providerConfigs.map((config) => {
            const providerAccounts = getAccountsByProvider(config.providerKey);
            const Icon = config.icon;
            
            return (
              <div key={config.id} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-background/50 ${config.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <h3 className="font-medium">{config.name}</h3>
                    <Badge variant="outline" className="text-xs">
                      {providerAccounts.length} connected
                    </Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openPermissionDialog(config)}
                    disabled={connecting !== null}
                  >
                    {connecting === config.id ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <Plus className="w-4 h-4 mr-2" />
                    )}
                    Add Account
                  </Button>
                </div>

                {providerAccounts.length > 0 && (
                  <div className="space-y-2 pl-10">
                    {providerAccounts.map((account) => (
                      <div
                        key={account.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-secondary/20 border border-border/20"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm truncate">
                              {account.account_name || account.account_email || 'Unknown'}
                            </span>
                            <Badge variant="default" className="bg-green-500/20 text-green-500 border-green-500/30 text-xs">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Connected
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            {account.account_email && account.account_name && (
                              <span className="truncate">{account.account_email}</span>
                            )}
                            {account.storage_used !== null && (
                              <span>
                                {formatStorage(account.storage_used)} / {formatStorage(account.storage_total)}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              {account.permission_level === 'read_only' ? (
                                <>
                                  <Shield className="w-3 h-3" />
                                  Read Only
                                </>
                              ) : (
                                <>
                                  <ShieldCheck className="w-3 h-3 text-primary" />
                                  Read & Write
                                </>
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          {config.authProvider && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openPermissionDialog(config)}
                              disabled={connecting !== null}
                            >
                              <RefreshCw className="w-4 h-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openDisconnectDialog(account.id, account.account_name || config.name)}
                            disabled={disconnecting === account.id}
                            className="text-destructive hover:text-destructive"
                          >
                            {disconnecting === account.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Unlink className="w-4 h-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {providerAccounts.length === 0 && (
                  <div className="pl-10 py-3 text-sm text-muted-foreground">
                    No accounts connected yet
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Permission Selection Dialog for OAuth providers */}
      <Dialog open={permissionDialog.open} onOpenChange={(open) => setPermissionDialog({ ...permissionDialog, open })}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Connect {permissionDialog.provider?.name}
            </DialogTitle>
            <DialogDescription>
              Choose the level of access you want to grant.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <PermissionSelector
              value={selectedPermission}
              onChange={setSelectedPermission}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermissionDialog({ open: false, provider: null })}>
              Cancel
            </Button>
            <Button onClick={handleConnect}>
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AWS S3 Configuration Dialog */}
      <Dialog open={s3Dialog} onOpenChange={setS3Dialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cloud className="w-5 h-5 text-[#FF9900]" />
              Connect AWS S3 Bucket
            </DialogTitle>
            <DialogDescription>
              Enter your AWS credentials to connect an S3 bucket.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="accountName">Account Name (optional)</Label>
              <Input
                id="accountName"
                placeholder="My S3 Storage"
                value={s3Form.accountName}
                onChange={(e) => setS3Form({ ...s3Form, accountName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bucketName">Bucket Name *</Label>
              <Input
                id="bucketName"
                placeholder="my-bucket"
                value={s3Form.bucketName}
                onChange={(e) => setS3Form({ ...s3Form, bucketName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region">Region *</Label>
              <Input
                id="region"
                placeholder="us-east-1"
                value={s3Form.region}
                onChange={(e) => setS3Form({ ...s3Form, region: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="accessKeyId">Access Key ID *</Label>
              <Input
                id="accessKeyId"
                placeholder="AKIAIOSFODNN7EXAMPLE"
                value={s3Form.accessKeyId}
                onChange={(e) => setS3Form({ ...s3Form, accessKeyId: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="secretAccessKey">Secret Access Key *</Label>
              <Input
                id="secretAccessKey"
                type="password"
                placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                value={s3Form.secretAccessKey}
                onChange={(e) => setS3Form({ ...s3Form, secretAccessKey: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setS3Dialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveS3} disabled={savingS3}>
              {savingS3 && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Confirmation Dialog */}
      <AlertDialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {confirmDialog.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove this connection and may affect sync configurations using this account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDisconnect(confirmDialog.accountId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};