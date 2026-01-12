import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";
import { Header } from "@/components/dashboard/Header";
import { SyncFolderManager } from "@/components/sync/SyncFolderManager";
import { SyncLogs } from "@/components/sync/SyncLogs";
import { SyncProgress } from "@/components/sync/SyncProgress";
import { SyncJobHistory } from "@/components/sync/SyncJobHistory";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FolderSync, FileText, ArrowLeft, Settings2, History } from "lucide-react";

const Synchronization = () => {
  const { user, loading: authLoading } = useAuth();
  const { onedriveConnected, googleDriveConnected, loading: accountsLoading } = useConnectedAccounts();
  const navigate = useNavigate();

  const loading = authLoading || accountsLoading;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container max-w-6xl mx-auto px-4 pb-12">
          <Header />
          <div className="glass rounded-xl p-8 text-center">
            <h2 className="font-display text-2xl font-bold text-foreground mb-2">
              Sign In Required
            </h2>
            <p className="text-muted-foreground mb-6">
              Please sign in to configure synchronization settings.
            </p>
            <Button variant="gradient" onClick={() => navigate("/auth")}>
              Sign In
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const neitherConnected = !onedriveConnected && !googleDriveConnected;
  const bothConnected = onedriveConnected && googleDriveConnected;

  return (
    <div className="min-h-screen bg-background">
      {/* Background gradients */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
      </div>

      <div className="relative container max-w-6xl mx-auto px-4 pb-12">
        <Header />

        <div className="mb-6">

          <h1 className="font-display text-3xl font-bold text-foreground mb-2">
            Synchronization
          </h1>
          <p className="text-muted-foreground">
            Configure and manage file synchronization between your cloud services.
          </p>
        </div>

        {neitherConnected ? (
          <div className="glass rounded-xl p-8 text-center">
            <FolderSync className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h2 className="font-display text-xl font-bold text-foreground mb-2">
              Connect Your Cloud Services
            </h2>
            <p className="text-muted-foreground mb-6">
              Connect OneDrive or Google Drive to configure synchronization.
            </p>
            <Button variant="gradient" onClick={() => navigate("/settings")}>
              Go to Settings
            </Button>
          </div>
        ) : !bothConnected ? (
          <div className="glass rounded-xl p-8 text-center">
            <FolderSync className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h2 className="font-display text-xl font-bold text-foreground mb-2">
              Connect Both Services
            </h2>
            <p className="text-muted-foreground mb-6">
              To sync files between cloud services, you need to connect both OneDrive and Google Drive.
            </p>
            <Button variant="gradient" onClick={() => navigate("/settings")}>
              Go to Settings
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <SyncProgress />
            
            <Tabs defaultValue="sync" className="space-y-6">
              <TabsList className="glass">
                <TabsTrigger value="sync" className="gap-2">
                  <Settings2 className="w-4 h-4" />
                  Sync Settings
                </TabsTrigger>
                <TabsTrigger value="history" className="gap-2">
                  <History className="w-4 h-4" />
                  Job History
                </TabsTrigger>
                <TabsTrigger value="logs" className="gap-2">
                  <FileText className="w-4 h-4" />
                  File Logs
                </TabsTrigger>
              </TabsList>

              <TabsContent value="sync">
                <SyncFolderManager />
              </TabsContent>

              <TabsContent value="history">
                <SyncJobHistory />
              </TabsContent>

              <TabsContent value="logs">
                <SyncLogs />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
};

export default Synchronization;
