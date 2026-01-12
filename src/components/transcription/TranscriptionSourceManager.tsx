import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, FolderOpen, Music, Folder, ArrowLeft, Check, Play, Square } from "lucide-react";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { UnifiedFileBrowser, FileItem } from "@/components/browser/UnifiedFileBrowser";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";

interface TranscriptionSource {
  id: string;
  provider: string;
  folder_id: string;
  folder_path: string;
  folder_name: string;
  item_type: string;
  scan_enabled: boolean;
  scan_schedule: string | null;
  last_scanned_at: string | null;
}

interface LocalStorageItem {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
}

export const TranscriptionSourceManager: React.FC<{ onSourcesChange?: () => void }> = ({ onSourcesChange }) => {
  const { user } = useAuth();
  const { accounts, loading: accountsLoading } = useConnectedAccounts();
  const [sources, setSources] = useState<TranscriptionSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [transcribingSourceId, setTranscribingSourceId] = useState<string | null>(null);

  // Local storage browser state
  const [localItems, setLocalItems] = useState<LocalStorageItem[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localPath, setLocalPath] = useState<string[]>([]);

  useEffect(() => {
    if (user) {
      fetchSources();
    }
  }, [user]);

  // Fetch local storage items when provider is local
  useEffect(() => {
    if (selectedProvider === "local" && user) {
      fetchLocalItems();
    }
  }, [selectedProvider, localPath, user]);

  const fetchLocalItems = async () => {
    if (!user) return;
    setLocalLoading(true);

    try {
      const pathPrefix = localPath.length > 0 
        ? `${user.id}/${localPath.join("/")}`
        : user.id;

      const { data, error } = await supabase.storage
        .from("user-files")
        .list(pathPrefix, { limit: 500 });

      if (error) throw error;

      const items: LocalStorageItem[] = (data || [])
        .filter(item => item.name !== ".emptyFolderPlaceholder" && item.name !== ".placeholder")
        .filter(item => item.id === null) // Only folders (files have an id)
        .map(item => ({
          id: item.name,
          name: item.name,
          type: "folder" as const,
          path: localPath.length > 0 ? `${localPath.join("/")}/${item.name}` : item.name,
        }));

      setLocalItems(items);
    } catch (err) {
      console.error("Failed to fetch local items:", err);
      toast.error("Failed to load local storage");
    } finally {
      setLocalLoading(false);
    }
  };

  const fetchSources = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("transcription_sources")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setSources(data || []);
    } catch (err) {
      console.error("Failed to fetch transcription sources:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSource = async (item: { id: string; name: string; path?: string; type?: string }) => {
    if (!user) return;
    setSaving(true);

    try {
      const { error } = await supabase
        .from("transcription_sources")
        .upsert({
          user_id: user.id,
          provider: selectedProvider,
          folder_id: item.id,
          folder_path: item.path || item.name,
          folder_name: item.name,
          item_type: item.type || "folder",
          scan_enabled: true,
          scan_schedule: "manual",
        }, {
          onConflict: "user_id,provider,folder_id",
        });

      if (error) throw error;
      
      toast.success("Audio source added");
      fetchSources();
      onSourcesChange?.();
      resetDialog();
    } catch (err) {
      console.error("Failed to add source:", err);
      toast.error("Failed to add audio source");
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveSource = async (sourceId: string) => {
    try {
      const { error } = await supabase
        .from("transcription_sources")
        .delete()
        .eq("id", sourceId);

      if (error) throw error;
      
      toast.success("Audio source removed");
      fetchSources();
      onSourcesChange?.();
    } catch (err) {
      console.error("Failed to remove source:", err);
      toast.error("Failed to remove audio source");
    }
  };

  const handleToggleScan = async (sourceId: string, enabled: boolean) => {
    try {
      const { error } = await supabase
        .from("transcription_sources")
        .update({ scan_enabled: enabled })
        .eq("id", sourceId);

      if (error) throw error;
      
      setSources(prev => prev.map(s => 
        s.id === sourceId ? { ...s, scan_enabled: enabled } : s
      ));
    } catch (err) {
      console.error("Failed to toggle scan:", err);
      toast.error("Failed to update source");
    }
  };

  const handleScheduleChange = async (sourceId: string, schedule: string) => {
    try {
      const { error } = await supabase
        .from("transcription_sources")
        .update({ scan_schedule: schedule })
        .eq("id", sourceId);

      if (error) throw error;
      
      setSources(prev => prev.map(s => 
        s.id === sourceId ? { ...s, scan_schedule: schedule } : s
      ));
    } catch (err) {
      console.error("Failed to update schedule:", err);
      toast.error("Failed to update schedule");
    }
  };

  const handleTranscribeSource = async (source: TranscriptionSource) => {
    if (transcribingSourceId || !user) return;
    
    setTranscribingSourceId(source.id);
    try {
      const { data, error } = await supabase.functions.invoke("transcribe-batch", {
        body: { 
          action: "scan-and-transcribe",
          userId: user.id,
          sourceIds: [source.id]
        },
      });

      if (error) throw error;

      toast.success("Transcription started - check progress above");
      onSourcesChange?.();
    } catch (error) {
      console.error("Transcription error:", error);
      toast.error("Failed to start transcription");
    } finally {
      setTranscribingSourceId(null);
    }
  };

  const handleStopTranscription = async (sourceId: string) => {
    try {
      // Find the running job for this source
      const { data: runningJob } = await supabase
        .from("transcription_jobs")
        .select("id")
        .eq("user_id", user!.id)
        .eq("status", "running")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (!runningJob) {
        toast.info("No running transcription job found");
        return;
      }

      // Update job status to cancelled
      await supabase
        .from("transcription_jobs")
        .update({ status: "cancelled", completed_at: new Date().toISOString() })
        .eq("id", runningJob.id);

      toast.success("Transcription cancelled");
    } catch (error) {
      console.error("Stop transcription error:", error);
      toast.error("Failed to stop transcription");
    } finally {
      setTranscribingSourceId(null);
    }
  };

  const resetDialog = () => {
    setDialogOpen(false);
    setSelectedProvider("");
    setLocalPath([]);
    setLocalItems([]);
  };

  const handleLocalFolderClick = (folder: LocalStorageItem) => {
    setLocalPath(prev => [...prev, folder.name]);
  };

  const handleLocalBack = () => {
    setLocalPath(prev => prev.slice(0, -1));
  };

  const handleSelectCurrentLocalFolder = () => {
    const folderName = localPath.length > 0 ? localPath[localPath.length - 1] : "Root";
    const folderId = localPath.length > 0 ? localPath.join("/") : "";
    handleAddSource({
      id: folderId || "root",
      name: folderName,
      path: localPath.join("/") || "/",
      type: "folder",
    });
  };

  const ProviderIcon = ({ provider }: { provider: string }) => {
    switch (provider) {
      case "onedrive":
        return <OneDriveIcon className="w-4 h-4 text-onedrive" />;
      case "google_drive":
        return <GoogleDriveIcon className="w-4 h-4 text-google-drive" />;
      case "local":
        return <LocalStorageIcon className="w-4 h-4 text-primary" />;
      default:
        return <FolderOpen className="w-4 h-4" />;
    }
  };

  const availableProviders = [
    { id: "local", name: "Local Storage", icon: LocalStorageIcon },
    ...(accounts?.find(a => a.provider === "onedrive") ? [{ id: "onedrive", name: "OneDrive", icon: OneDriveIcon }] : []),
    ...(accounts?.find(a => a.provider === "google_drive") ? [{ id: "google_drive", name: "Google Drive", icon: GoogleDriveIcon }] : []),
  ];

  return (
    <Card className="glass border-border/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            <Music className="w-5 h-5" />
            Audio Sources
          </CardTitle>
          <CardDescription>Configure folders to scan for audio files</CardDescription>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          if (!open) resetDialog();
          else setDialogOpen(true);
        }}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="w-4 h-4" />
              Add Source
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Add Audio Source</DialogTitle>
              <DialogDescription>Select a folder containing audio files to transcribe</DialogDescription>
            </DialogHeader>
            
            {!selectedProvider ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 py-4">
                {availableProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="outline"
                    className="h-24 flex-col gap-2"
                    onClick={() => setSelectedProvider(provider.id)}
                  >
                    <provider.icon className="w-8 h-8" />
                    <span>{provider.name}</span>
                  </Button>
                ))}
              </div>
            ) : selectedProvider === "local" ? (
              <div className="py-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedProvider("")}
                    >
                      ← Providers
                    </Button>
                    {localPath.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleLocalBack}
                      >
                        <ArrowLeft className="w-4 h-4 mr-1" />
                        Back
                      </Button>
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={handleSelectCurrentLocalFolder}
                    disabled={saving}
                    className="gap-2"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Select This Folder
                  </Button>
                </div>

                <div className="text-sm text-muted-foreground mb-3">
                  Current: /{localPath.join("/") || "Root"}
                </div>

                {localLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : localItems.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p>No subfolders in this location</p>
                    <p className="text-sm">Click "Select This Folder" to use the current folder</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-1">
                      {localItems.map((item) => (
                        <button
                          key={item.id}
                          className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors text-left"
                          onClick={() => handleLocalFolderClick(item)}
                        >
                          <Folder className="w-5 h-5 text-primary shrink-0" />
                          <span className="truncate">{item.name}</span>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            ) : (
              <div className="py-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedProvider("")}
                  className="mb-4"
                >
                  ← Back to providers
                </Button>
                <UnifiedFileBrowser
                  selectionMode
                  allowFiles={false}
                  onItemSelect={(item, path) => {
                    if (item.type === "folder") {
                      handleAddSource({ ...item, path });
                    }
                  }}
                />
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : sources.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No audio sources configured</p>
            <p className="text-sm">Add a folder to start transcribing audio files</p>
          </div>
        ) : (
          <ScrollArea className="h-[300px]">
            <div className="space-y-3">
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/30"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <ProviderIcon provider={source.provider} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{source.folder_name}</div>
                      <div className="text-xs text-muted-foreground truncate">{source.folder_path}</div>
                      {source.last_scanned_at && (
                        <div className="text-xs text-muted-foreground">
                          Last scan: {new Date(source.last_scanned_at).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {transcribingSourceId === source.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStopTranscription(source.id)}
                        className="h-8 w-8 p-0"
                        title="Stop transcription"
                      >
                        <Square className="w-4 h-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTranscribeSource(source)}
                        disabled={!!transcribingSourceId}
                        className="h-8 w-8 p-0"
                        title="Transcribe this source"
                      >
                        {transcribingSourceId ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                    
                    <Select
                      value={source.scan_schedule || "manual"}
                      onValueChange={(value) => handleScheduleChange(source.id, value)}
                    >
                      <SelectTrigger className="w-24 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">Manual</SelectItem>
                        <SelectItem value="hourly">Hourly</SelectItem>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                      </SelectContent>
                    </Select>
                    
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Scan</span>
                      <Switch
                        checked={source.scan_enabled}
                        onCheckedChange={(checked) => handleToggleScan(source.id, checked)}
                      />
                    </div>
                    
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveSource(source.id)}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
};
