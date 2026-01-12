import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { UnifiedFileBrowser, FileItem } from "@/components/browser/UnifiedFileBrowser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, FolderSync, ArrowRight, Loader2, File, Folder } from "lucide-react";
import { OneDriveIcon, GoogleDriveIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";

interface SyncItem {
  id: string;
  source_provider: "onedrive" | "google_drive";
  source_folder_id: string;
  source_folder_path: string;
  target_provider: "onedrive" | "google_drive";
  target_folder_id: string | null;
  target_folder_path: string | null;
  sync_enabled: boolean;
  last_synced_at: string | null;
}

export const SyncManager: React.FC = () => {
  const { user } = useAuth();
  const [syncItems, setSyncItems] = useState<SyncItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<"source" | "target">("source");
  const [selectedSource, setSelectedSource] = useState<{ item: FileItem; path: string } | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<{ item: FileItem; path: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchSyncItems = async () => {
    if (!user) return;

    try {
      const { data, error } = await supabase
        .from("sync_folders")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setSyncItems((data || []) as SyncItem[]);
    } catch (error) {
      console.error("Error fetching sync items:", error);
      toast.error("Failed to load sync configuration");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSyncItems();
  }, [user]);

  const handleSourceSelect = (item: FileItem, path: string) => {
    setSelectedSource({ item, path });
    setStep("target");
  };

  const handleTargetSelect = (item: FileItem, path: string) => {
    setSelectedTarget({ item, path });
  };

  const handleSave = async () => {
    if (!user || !selectedSource) return;

    setSaving(true);
    try {
      const targetProvider = selectedSource.item.provider === "onedrive" ? "google_drive" : "onedrive";

      const { error } = await supabase.from("sync_folders").insert({
        user_id: user.id,
        source_provider: selectedSource.item.provider,
        source_folder_id: selectedSource.item.id,
        source_folder_path: selectedSource.path,
        target_provider: targetProvider,
        target_folder_id: selectedTarget?.item.id || null,
        target_folder_path: selectedTarget?.path || null,
        sync_enabled: true,
      });

      if (error) throw error;

      toast.success("Sync configuration added");
      setDialogOpen(false);
      resetDialog();
      fetchSyncItems();
    } catch (error) {
      console.error("Error saving sync configuration:", error);
      toast.error("Failed to save sync configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("sync_folders").delete().eq("id", id);
      if (error) throw error;

      toast.success("Sync configuration removed");
      fetchSyncItems();
    } catch (error) {
      console.error("Error deleting sync configuration:", error);
      toast.error("Failed to remove sync configuration");
    }
  };

  const handleToggleSync = async (id: string, enabled: boolean) => {
    try {
      const { error } = await supabase
        .from("sync_folders")
        .update({ sync_enabled: enabled })
        .eq("id", id);

      if (error) throw error;
      
      setSyncItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, sync_enabled: enabled } : item))
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
  };

  const ProviderIcon = ({ provider }: { provider: "onedrive" | "google_drive" | "local_storage" }) =>
    provider === "onedrive" ? (
      <OneDriveIcon className="w-4 h-4" />
    ) : provider === "google_drive" ? (
      <GoogleDriveIcon className="w-4 h-4" />
    ) : null;

  const getTargetProvider = (sourceProvider: "onedrive" | "google_drive" | "local_storage"): "onedrive" | "google_drive" => 
    sourceProvider === "onedrive" ? "google_drive" : "onedrive";

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
              Sync files and folders between your cloud services
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
            <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {step === "source" ? "Select Source" : "Select Target Location"}
                </DialogTitle>
                <DialogDescription>
                  {step === "source"
                    ? "Choose a file or folder to sync. Click on an item to select it."
                    : "Choose where to sync to, or skip to use the root folder."}
                </DialogDescription>
              </DialogHeader>

              {step === "source" && (
                <div className="space-y-4">
                  <UnifiedFileBrowser
                    selectionMode
                    allowFiles
                    onItemSelect={handleSourceSelect}
                  />

                  {selectedSource && (
                    <div className="p-3 bg-primary/10 rounded-lg flex items-center gap-2">
                      <ProviderIcon provider={selectedSource.item.provider} />
                      {selectedSource.item.type === "folder" ? (
                        <Folder className="w-4 h-4" />
                      ) : (
                        <File className="w-4 h-4" />
                      )}
                      <span className="text-sm font-medium">Selected: </span>
                      <span className="text-sm">{selectedSource.path}</span>
                    </div>
                  )}
                </div>
              )}

              {step === "target" && selectedSource && (
                <div className="space-y-4">
                  <div className="p-3 bg-muted rounded-lg flex items-center gap-2 flex-wrap">
                    <ProviderIcon provider={selectedSource.item.provider} />
                    {selectedSource.item.type === "folder" ? (
                      <Folder className="w-4 h-4" />
                    ) : (
                      <File className="w-4 h-4" />
                    )}
                    <span className="text-sm truncate">{selectedSource.path}</span>
                    <ArrowRight className="w-4 h-4" />
                    <ProviderIcon provider={getTargetProvider(selectedSource.item.provider)} />
                    {selectedTarget ? (
                      <>
                        <Folder className="w-4 h-4" />
                        <span className="text-sm">{selectedTarget.path}</span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">Root folder</span>
                    )}
                  </div>

                  <div className="text-sm text-muted-foreground mb-2">
                    Select a folder in {getTargetProvider(selectedSource.item.provider) === "onedrive" ? "OneDrive" : "Google Drive"}:
                  </div>

                  <UnifiedFileBrowser
                    selectionMode
                    allowFiles={false}
                    onItemSelect={handleTargetSelect}
                  />

                  <div className="flex justify-between pt-4 border-t">
                    <Button variant="outline" onClick={() => setStep("source")}>
                      Back
                    </Button>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={handleSave}
                        disabled={saving}
                      >
                        {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                        Sync to Root
                      </Button>
                      <Button
                        variant="gradient"
                        onClick={handleSave}
                        disabled={saving || !selectedTarget}
                      >
                        {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
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
        ) : syncItems.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No sync configurations yet. Add files or folders to sync.
          </div>
        ) : (
          <div className="space-y-3">
            {syncItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <ProviderIcon provider={item.source_provider} />
                  <span className="text-sm truncate max-w-[180px]">
                    {item.source_folder_path}
                  </span>
                  <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  <ProviderIcon provider={item.target_provider} />
                  <span className="text-sm truncate max-w-[180px] text-muted-foreground">
                    {item.target_folder_path || "Root"}
                  </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {item.last_synced_at && (
                    <Badge variant="outline" className="text-xs hidden sm:flex">
                      Last: {new Date(item.last_synced_at).toLocaleDateString()}
                    </Badge>
                  )}
                  <Switch
                    checked={item.sync_enabled}
                    onCheckedChange={(checked) => handleToggleSync(item.id, checked)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(item.id)}
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
