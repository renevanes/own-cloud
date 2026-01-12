import React, { useState, useEffect } from "react";
import { 
  Folder, 
  FileAudio,
  X,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ConfiguredFolder,
  getConfiguredFolders,
  addConfiguredFolder,
  removeConfiguredFolder,
} from "@/lib/transcription-storage";
import { SourceSelector, SourceFileItem } from "@/components/browser/SourceSelector";

const getProviderIcon = (provider: string): React.FC<{ className?: string }> => {
  switch (provider) {
    case 'onedrive':
      return OneDriveIcon;
    case 'google_drive':
      return GoogleDriveIcon;
    default:
      return LocalStorageIcon;
  }
};

interface TranscribeFolderConfigProps {
  onFoldersChange?: (folders: ConfiguredFolder[]) => void;
}

export const TranscribeFolderConfig: React.FC<TranscribeFolderConfigProps> = ({
  onFoldersChange,
}) => {
  const [open, setOpen] = useState(false);
  const [configuredFolders, setConfiguredFolders] = useState<ConfiguredFolder[]>([]);

  // Load configured folders on mount
  useEffect(() => {
    const folders = getConfiguredFolders();
    setConfiguredFolders(folders);
    onFoldersChange?.(folders);
  }, []);

  const handleAddSource = (item: SourceFileItem, path: string) => {
    const configuredSource: ConfiguredFolder = {
      id: item.id,
      name: item.name,
      path,
      provider: item.provider as "onedrive" | "google_drive" | "local_storage",
      type: item.type,
      accountId: item.accountId,
    };
    
    addConfiguredFolder(configuredSource);
    const updatedFolders = getConfiguredFolders();
    setConfiguredFolders(updatedFolders);
    onFoldersChange?.(updatedFolders);
    
    const typeLabel = item.type === "folder" ? "folder" : "file";
    toast.success(`Added ${typeLabel} "${item.name}" to transcription sources`);
  };

  const handleRemoveFolder = (folder: ConfiguredFolder) => {
    removeConfiguredFolder(folder.id, folder.provider);
    const updatedFolders = getConfiguredFolders();
    setConfiguredFolders(updatedFolders);
    onFoldersChange?.(updatedFolders);
    
    toast.success(`Removed "${folder.name}" from transcription sources`);
  };

  const isSourceConfigured = (itemId: string, provider: string) => {
    return configuredFolders.some(f => f.id === itemId && f.provider === provider);
  };

  return (
    <div className="space-y-3">
      {/* Configured Sources Display */}
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Source Files & Folders</label>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              <FolderOpen className="w-3 h-3" />
              Select Source
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Browse Files - Select Source</DialogTitle>
            </DialogHeader>
            
            <div className="h-[500px]">
              <SourceSelector
                onSelect={handleAddSource}
                onAdd={handleAddSource}
                showAddButton
                allowFileSelection
                filterAudioOnly
                isItemConfigured={isSourceConfigured}
              />
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Configured folders/files list */}
      {configuredFolders.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center border rounded-lg border-dashed">
          No sources configured. Click "Select Source" to add folders or files.
        </div>
      ) : (
        <div className="space-y-2">
          {configuredFolders.map((folder) => {
            const ProviderIcon = getProviderIcon(folder.provider);
            const isFile = folder.type === "file";
            const ItemIcon = isFile ? FileAudio : Folder;
            
            return (
              <div
                key={`${folder.provider}-${folder.id}`}
                className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg"
              >
                <ProviderIcon className="w-4 h-4 shrink-0" />
                <ItemIcon className={`w-4 h-4 shrink-0 ${isFile ? "text-orange-500" : "text-primary"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{folder.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{folder.path}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {isFile ? "File" : "Folder"}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => handleRemoveFolder(folder)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
