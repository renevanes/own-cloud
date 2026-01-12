import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";
import { Header } from "@/components/dashboard/Header";
import { WindowsExplorer } from "@/components/browser/WindowsExplorer";
import { Button } from "@/components/ui/button";
import { FolderOpen, ArrowLeft } from "lucide-react";

const FileExplorer = () => {
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
              Please sign in to browse and manage your cloud files.
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
            File Explorer
          </h1>
          <p className="text-muted-foreground">
            Browse, manage, and organize your cloud files across all storage services.
          </p>
        </div>

        {neitherConnected ? (
          <div className="glass rounded-xl p-8 text-center">
            <FolderOpen className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h2 className="font-display text-xl font-bold text-foreground mb-2">
              Connect Your Cloud Services
            </h2>
            <p className="text-muted-foreground mb-6">
              Connect OneDrive or Google Drive to browse your files.
            </p>
            <Button variant="gradient" onClick={() => navigate("/settings")}>
              Go to Settings
            </Button>
          </div>
        ) : (
          <WindowsExplorer />
        )}
      </div>
    </div>
  );
};

export default FileExplorer;
