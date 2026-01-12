import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";
import { SourceSelector, SourceFileItem } from "@/components/browser/SourceSelector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, FolderSync, ArrowRight, Loader2, Clock, File, Folder, Play, Square } from "lucide-react";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";

type SyncSchedule = "manual" | "hourly" | "every_6_hours" | "daily" | "weekly";
type Provider = "onedrive" | "google_drive" | "local";

interface SyncFolder {
  id: string;
  source_provider: Provider;
  source_folder_id: string;
  source_folder_path: string;
  target_provider: Provider;
  target_folder_id: string | null;
  target_folder_path: string | null;
  sync_enabled: boolean;
  last_synced_at: string | null;
  sync_schedule: SyncSchedule | null;
  next_sync_at: string | null;
}

interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  size: number;
  mimeType?: string;
  modifiedAt: string;
  path: string;
}

export const SyncFolderManager: React.FC = () => {
  const { user } = useAuth();
  const { onedriveConnected, googleDriveConnected } = useConnectedAccounts();
  
  const [syncFolders, setSyncFolders] = useState<SyncFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<"source" | "target">("source");
  const [sourceProvider, setSourceProvider] = useState<Provider>("local");
  const [targetProvider, setTargetProvider] = useState<Provider>("onedrive");
  const [selectedSource, setSelectedSource] = useState<{ item: SourceFileItem; path: string } | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<{ item: SourceFileItem; path: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncingFolderId, setSyncingFolderId] = useState<string | null>(null);

  // Get available providers
  const availableProviders: Provider[] = [
    "local",
    ...(onedriveConnected ? ["onedrive" as Provider] : []),
    ...(googleDriveConnected ? ["google_drive" as Provider] : []),
  ];

  const handleManualSync = async (folderId: string) => {
    if (syncingFolderId) return;
    
    setSyncingFolderId(folderId);
    try {
      const { data, error } = await supabase.functions.invoke("sync-files", {
        body: { syncFolderId: folderId, action: "manual" },
      });

      if (error) throw error;

      // Sync now runs in background - show toast and let realtime updates handle progress
      toast.success("Sync started - check progress above");
      // Don't clear syncingFolderId immediately - it will be cleared when we detect job completion
    } catch (error) {
      console.error("Sync error:", error);
      toast.error("Failed to sync files");
      setSyncingFolderId(null);
    }
  };

  const handleStopSync = async (folderId: string) => {
    try {
      // Find the running job for this folder
      const { data: runningJob } = await supabase
        .from("sync_jobs")
        .select("id")
        .eq("user_id", user!.id)
        .eq("sync_folder_id", folderId)
        .eq("status", "running")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (!runningJob) {
        toast.info("No running sync job found");
        return;
      }

      const { error } = await supabase.functions.invoke("sync-files", {
        body: { action: "stop", jobId: runningJob.id },
      });

      if (error) throw error;

      toast.success("Sync job cancelled");
    } catch (error) {
      console.error("Stop sync error:", error);
      toast.error("Failed to stop sync");
    } finally {
      setSyncingFolderId(null);
    }
  };

  const fetchSyncFolders = async () => {
    if (!user) return;

    try {
      const { data, error } = await supabase
        .from("sync_folders")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setSyncFolders((data || []) as SyncFolder[]);
    } catch (error) {
      console.error("Error fetching sync folders:", error);
      toast.error("Failed to load sync configurations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSyncFolders();
  }, [user]);

  const handleSourceSelect = (item: SourceFileItem, path: string) => {
    setSelectedSource({ item, path });
    // Set the source provider from the selected item
    const provider = item.provider === "local_storage" ? "local" : item.provider;
    setSourceProvider(provider as Provider);
    // Ensure target is different from source
    if (provider === targetProvider) {
      const newTarget = targetProviderOptions.find(p => p !== provider);
      if (newTarget) setTargetProvider(newTarget);
    }
  };
  
  const handleSourceConfirm = (item: SourceFileItem, path: string) => {
    setSelectedSource({ item, path });
    const provider = item.provider === "local_storage" ? "local" : item.provider;
    setSourceProvider(provider as Provider);
    setStep("target");
  };

  const handleTargetSelect = (item: SourceFileItem, path: string) => {
    setSelectedTarget({ item, path });
    const provider = item.provider === "local_storage" ? "local" : item.provider;
    setTargetProvider(provider as Provider);
  };

  const handleSave = async () => {
    if (!user || !selectedSource) return;

    setSaving(true);
    try {
      // For local storage targets without a selected folder, use empty string for root
      let targetFolderId = selectedTarget?.item.id || null;
      let targetFolderPath = selectedTarget?.path || null;
      
      // Map local_storage to local for database
      const sourceProviderDb = selectedSource.item.provider === "local_storage" ? "local" : selectedSource.item.provider;
      const targetProviderDb = targetProvider === "local" ? "local" : targetProvider;
      
      // For local storage target without selection, set to user's root folder
      if (targetProvider === "local" && !selectedTarget) {
        targetFolderId = user.id;
        targetFolderPath = "Root";
      }

      const { error } = await supabase.from("sync_folders").insert({
        user_id: user.id,
        source_provider: sourceProviderDb,
        source_folder_id: selectedSource.item.id,
        source_folder_path: selectedSource.path,
        target_provider: targetProviderDb,
        target_folder_id: targetFolderId,
        target_folder_path: targetFolderPath,
        sync_enabled: true,
        sync_schedule: null,
      });

      if (error) throw error;

      toast.success("Sync configuration added successfully");
      setDialogOpen(false);
      resetDialog();
      fetchSyncFolders();
    } catch (error) {
      console.error("Error saving sync folder:", error);
      toast.error("Failed to save sync folder");
    } finally {
      setSaving(false);
    }
  };

  const handleScheduleChange = async (id: string, schedule: SyncSchedule) => {
    try {
      const now = new Date();
      let nextSyncAt: Date | null = null;
      
      if (schedule !== "manual") {
        switch (schedule) {
          case "hourly":
            nextSyncAt = new Date(now.getTime() + 60 * 60 * 1000);
            break;
          case "every_6_hours":
            nextSyncAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
            break;
          case "daily":
            nextSyncAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            break;
          case "weekly":
            nextSyncAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            break;
        }
      }

      const { error } = await supabase
        .from("sync_folders")
        .update({ 
          sync_schedule: schedule === "manual" ? null : schedule,
          next_sync_at: nextSyncAt?.toISOString() || null
        })
        .eq("id", id);

      if (error) throw error;
      
      setSyncFolders((prev) =>
        prev.map((f) => (f.id === id ? { ...f, sync_schedule: schedule === "manual" ? null : schedule, next_sync_at: nextSyncAt?.toISOString() || null } : f))
      );
      toast.success(`Schedule updated to ${schedule === "manual" ? "manual" : schedule.replace("_", " ")}`);
    } catch (error) {
      console.error("Error updating schedule:", error);
      toast.error("Failed to update schedule");
    }
  };

  const getScheduleLabel = (schedule: SyncSchedule | null): string => {
    if (!schedule) return "Manual";
    switch (schedule) {
      case "hourly": return "Every hour";
      case "every_6_hours": return "Every 6 hours";
      case "daily": return "Daily";
      case "weekly": return "Weekly";
      default: return "Manual";
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("sync_folders").delete().eq("id", id);
      if (error) throw error;

      toast.success("Sync folder removed");
      fetchSyncFolders();
    } catch (error) {
      console.error("Error deleting sync folder:", error);
      toast.error("Failed to remove sync folder");
    }
  };

  const handleToggleSync = async (id: string, enabled: boolean) => {
    try {
      const { error } = await supabase
        .from("sync_folders")
        .update({ sync_enabled: enabled })
        .eq("id", id);

      if (error) throw error;
      
      setSyncFolders((prev) =>
        prev.map((f) => (f.id === id ? { ...f, sync_enabled: enabled } : f))
      );
      toast.success(enabled ? "Sync enabled" : "Sync disabled");
    } catch (error) {
      console.error("Error toggling sync:", error);
      toast.error("Failed to update sync setting");
    }
  };

  const resetDialog = () => {
    setStep("source");
    setSelectedSource(null);
    setSelectedTarget(null);
    setSourceProvider("local");
    setTargetProvider(onedriveConnected ? "onedrive" : googleDriveConnected ? "google_drive" : "local");
  };

  const ProviderIcon = ({ provider }: { provider: Provider }) => {
    switch (provider) {
      case "onedrive":
        return <OneDriveIcon className="w-4 h-4 text-onedrive" />;
      case "google_drive":
        return <GoogleDriveIcon className="w-4 h-4 text-google-drive" />;
      case "local":
        return <LocalStorageIcon className="w-4 h-4 text-primary" />;
    }
  };

  const getProviderLabel = (provider: Provider) => {
    switch (provider) {
      case "onedrive": return "OneDrive";
      case "google_drive": return "Google Drive";
      case "local": return "Local Storage";
    }
  };

  // Get target provider options (exclude source provider)
  const targetProviderOptions = availableProviders.filter(p => p !== sourceProvider);

  return (
    <Card className="glass">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FolderSync className="w-5 h-5" />
              Sync Configuration
            </CardTitle>
            <CardDescription>
              Choose files or folders to sync between your cloud services
            </CardDescription>
          </div>

          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetDialog();
          }}>
            <DialogTrigger asChild>
              <Button variant="gradient" size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add Sync
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
              <DialogHeader>
                <DialogTitle>
                  {step === "source" ? "Select Source (File or Folder)" : "Select Target Folder (Optional)"}
                </DialogTitle>
                <DialogDescription>
                  {step === "source"
                    ? "Choose a file or folder to sync. Click on the name to select it."
                    : "Choose a destination folder, or skip to sync to the root folder."}
                </DialogDescription>
              </DialogHeader>

              {step === "source" && (
                <div className="flex flex-col flex-1 min-h-0 space-y-3">
                  <div className="flex-1 min-h-0 overflow-auto h-[500px]">
                    <SourceSelector
                      onSelect={handleSourceSelect}
                      onConfirm={handleSourceConfirm}
                      selectedItemId={selectedSource?.item.id}
                      allowFileSelection
                      showConfirmButton
                      confirmButtonLabel="Next"
                    />
                  </div>
                </div>
              )}

              {step === "target" && (
                <div className="flex flex-col flex-1 min-h-0 space-y-3">
                  <div className="p-2 bg-muted rounded-lg flex items-center gap-2 text-sm shrink-0">
                    <ProviderIcon provider={sourceProvider} />
                    <span className="truncate">{selectedSource?.path}</span>
                    <ArrowRight className="w-4 h-4 shrink-0" />
                    <ProviderIcon provider={selectedTarget ? (selectedTarget.item.provider === "local_storage" ? "local" : selectedTarget.item.provider as Provider) : targetProvider} />
                    <span className="text-muted-foreground truncate">
                      {selectedTarget?.path || "Select destination..."}
                    </span>
                  </div>

                  <div className="flex-1 min-h-0 overflow-auto h-[400px]">
                    <SourceSelector
                      onSelect={handleTargetSelect}
                      selectedItemId={selectedTarget?.item.id}
                      allowFileSelection={false}
                      providerFilter={(() => {
                        const providers: ("onedrive" | "google_drive" | "local_storage")[] = [];
                        if (onedriveConnected && sourceProvider !== "onedrive") providers.push("onedrive");
                        if (googleDriveConnected && sourceProvider !== "google_drive") providers.push("google_drive");
                        if (sourceProvider !== "local") providers.push("local_storage");
                        return providers;
                      })()}
                    />
                  </div>

                  <div className="flex justify-between shrink-0">
                    <Button variant="outline" size="sm" onClick={() => setStep("source")}>
                      Back
                    </Button>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSave}
                        disabled={saving}
                      >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                        Skip (Sync to Root)
                      </Button>
                      <Button
                        variant="gradient"
                        size="sm"
                        onClick={handleSave}
                        disabled={saving || !selectedTarget}
                      >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : syncFolders.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No sync folders configured yet. Add a folder to get started.
          </div>
        ) : (
          <div className="space-y-3">
            {syncFolders.map((folder) => (
              <div
                key={folder.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <ProviderIcon provider={folder.source_provider} />
                  <span className="text-sm truncate max-w-[150px]">
                    {folder.source_folder_path}
                  </span>
                  <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  <ProviderIcon provider={folder.target_provider} />
                  <span className="text-sm truncate max-w-[150px] text-muted-foreground">
                    {folder.target_folder_path || "Root"}
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {folder.last_synced_at && (
                    <Badge variant="outline" className="text-xs">
                      Last: {new Date(folder.last_synced_at).toLocaleDateString()}
                    </Badge>
                  )}
                  {syncingFolderId === folder.id ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-8 gap-1"
                      onClick={() => handleStopSync(folder.id)}
                    >
                      <Square className="w-3 h-3" />
                      <span className="hidden sm:inline">Stop</span>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      onClick={() => handleManualSync(folder.id)}
                      disabled={syncingFolderId !== null || !folder.sync_enabled}
                    >
                      <Play className="w-3 h-3" />
                      <span className="hidden sm:inline">Sync</span>
                    </Button>
                  )}
                  <Select
                    value={folder.sync_schedule || "manual"}
                    onValueChange={(value) => handleScheduleChange(folder.id, value as SyncSchedule)}
                  >
                    <SelectTrigger className="w-[130px] h-8 text-xs">
                      <Clock className="w-3 h-3 mr-1" />
                      <SelectValue placeholder="Schedule" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="every_6_hours">Every 6 hours</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                    </SelectContent>
                  </Select>
                  <Switch
                    checked={folder.sync_enabled}
                    onCheckedChange={(checked) => handleToggleSync(folder.id, checked)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(folder.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
