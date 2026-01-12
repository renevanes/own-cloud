import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "@/components/dashboard/Header";
import { StorageCard } from "@/components/dashboard/StorageCard";
import { SyncStatus } from "@/components/dashboard/SyncStatus";
import { RecentActivity } from "@/components/dashboard/RecentActivity";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { useAuth } from "@/hooks/useAuth";
import { useConnectedAccounts, StorageAccount } from "@/hooks/useConnectedAccounts";
import { useFileActivity } from "@/hooks/useFileActivity";
import { useSyncJobs } from "@/hooks/useSyncJobs";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const Index = () => {
  const [isSyncing, setIsSyncing] = useState(false);
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  
  const { 
    getAllStorageAccounts,
    onedriveConnected, 
    googleDriveConnected,
    loading: accountsLoading,
    refetch: refetchAccounts
  } = useConnectedAccounts();
  
  const { activities, loading: activitiesLoading, refetch: refetchActivities } = useFileActivity(5);
  const { formattedLastSync, totalFilesSynced, loading: syncLoading, refetch: refetchSync } = useSyncJobs();

  const handleSync = async () => {
    if (!user) {
      toast.error("Please sign in to sync your files");
      navigate("/auth");
      return;
    }

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) {
        toast.error("Your session has expired. Please sign in again.");
        navigate("/auth");
        return;
      }

      // Proactively refresh if the token is near expiry (within 5 minutes)
      const expiresAt = sessionData.session.expires_at;
      if (expiresAt && expiresAt * 1000 < Date.now() + 300_000) {
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) {
          toast.error("Session refresh failed. Please sign in again.");
          navigate("/auth");
          return;
        }
      }

      if (!onedriveConnected || !googleDriveConnected) {
        toast.error("Please connect both OneDrive and Google Drive first");
        return;
      }

      setIsSyncing(true);
      toast.info("Starting synchronization...");

      const { data: syncFolders, error: foldersError } = await supabase
        .from("sync_folders")
        .select("id")
        .eq("user_id", user.id)
        .eq("sync_enabled", true);

      if (foldersError) throw foldersError;

      if (!syncFolders || syncFolders.length === 0) {
        toast.warning("No sync folders configured. Use the file browser to set up sync.");
        setIsSyncing(false);
        return;
      }

      for (const folder of syncFolders) {
        const { error } = await supabase.functions.invoke("sync-files", {
          body: { syncFolderId: folder.id },
        });
        if (error) throw error;
      }

      toast.success("Sync completed!", { description: "Check Sync Logs for details." });
      refetchActivities();
      refetchSync();
    } catch (error) {
      console.error("Sync error:", error);
      toast.error("Sync failed. Check Sync Logs for details.");
    } finally {
      setIsSyncing(false);
    }
  };

  const bytesToGB = (bytes: number | null | undefined): number => {
    if (!bytes) return 0;
    return bytes / (1024 * 1024 * 1024);
  };

  const getProviderIcon = (provider: string) => {
    switch (provider) {
      case 'onedrive':
        return <OneDriveIcon className="w-5 h-5 text-onedrive" />;
      case 'google_drive':
        return <GoogleDriveIcon className="w-5 h-5 text-google-drive" />;
      case 'local_storage':
        return <LocalStorageIcon className="w-5 h-5 text-primary" />;
      default:
        return null;
    }
  };

  const getProviderName = (account: StorageAccount): string => {
    if (account.provider === 'local_storage') {
      return 'Local Storage';
    }
    if (account.provider === 'onedrive') {
      return account.account_name || account.account_email || 'OneDrive';
    }
    if (account.provider === 'google_drive') {
      return account.account_name || account.account_email || 'Google Drive';
    }
    return account.provider;
  };

  const getProviderColor = (provider: string): string => {
    switch (provider) {
      case 'onedrive':
        return 'bg-onedrive/20';
      case 'google_drive':
        return 'bg-google-drive/20';
      case 'local_storage':
        return 'bg-primary/20';
      default:
        return 'bg-muted';
    }
  };

  const loading = authLoading || accountsLoading;
  const allAccounts = getAllStorageAccounts();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Background gradients */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
      </div>
      
      <div className="relative container max-w-7xl mx-auto px-4 pb-12">
        <Header />
        
        {!user && (
          <section className="glass rounded-xl p-8 mb-6 text-center animate-slide-up">
            <h2 className="font-display text-2xl font-bold text-foreground mb-2">
              Welcome to CloudSync
            </h2>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              Sign in to start syncing your OneDrive and Google Drive files seamlessly.
            </p>
            <Button variant="gradient" size="lg" onClick={() => navigate('/auth')}>
              Get Started
            </Button>
          </section>
        )}
        
        <main className="space-y-6">
          {/* Storage Overview - Dynamic Grid */}
          <section className="animate-slide-up" style={{ animationDelay: '100ms' }}>
            <h2 className="text-lg font-semibold mb-3">Storage Providers</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {allAccounts.map((account) => (
                <StorageCard
                  key={`${account.provider}-${account.id}`}
                  icon={getProviderIcon(account.provider)}
                  name={getProviderName(account)}
                  used={bytesToGB(account.storage_used)}
                  total={bytesToGB(account.storage_total) || (account.provider === 'local_storage' ? 100 : 15)}
                  color={getProviderColor(account.provider)}
                  connected={true}
                  accountEmail={account.account_email}
                  compact
                />
              ))}
              
              {/* Show placeholder for adding more accounts */}
              {user && (
                <div 
                  className="glass rounded-xl p-4 border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center cursor-pointer hover:border-primary/50 transition-colors min-h-[100px]"
                  onClick={() => navigate('/settings')}
                >
                  <p className="text-sm text-muted-foreground text-center">
                    + Add Storage
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Sync Status & Recent Activity */}
          <section className="grid lg:grid-cols-2 gap-6 animate-slide-up" style={{ animationDelay: '300ms' }}>
            <SyncStatus
              isSyncing={isSyncing}
              lastSync={user ? formattedLastSync : "Not available"}
              filesCount={totalFilesSynced}
              onSync={handleSync}
              canSync={onedriveConnected && googleDriveConnected}
            />
            <RecentActivity activities={activities} loading={activitiesLoading} />
          </section>
        </main>
      </div>
    </div>
  );
};

export default Index;
