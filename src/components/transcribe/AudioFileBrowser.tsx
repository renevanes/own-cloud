import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";
import { Folder, FileAudio, ChevronRight, ArrowLeft, Loader2, RefreshCw, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OneDriveIcon, GoogleDriveIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";
import { FileItem } from "@/components/browser/UnifiedFileBrowser";

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

interface ProviderState {
  files: FileItem[];
  loading: boolean;
  currentFolderId: string | null;
  breadcrumbs: BreadcrumbItem[];
}

interface AudioFileBrowserProps {
  onFileSelect: (file: FileItem) => void;
  isProcessing?: boolean;
}

// Audio file extensions and MIME types
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm', '.aac', '.wma', '.aiff'];
const AUDIO_MIME_PREFIXES = ['audio/'];

const isAudioFile = (file: FileItem): boolean => {
  if (file.type === 'folder') return false;
  
  // Check MIME type
  if (file.mimeType && AUDIO_MIME_PREFIXES.some(prefix => file.mimeType?.startsWith(prefix))) {
    return true;
  }
  
  // Check file extension
  const name = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some(ext => name.endsWith(ext));
};

export const AudioFileBrowser: React.FC<AudioFileBrowserProps> = ({
  onFileSelect,
  isProcessing = false,
}) => {
  const { onedriveConnected, googleDriveConnected } = useConnectedAccounts();
  
  const [activeProvider, setActiveProvider] = useState<"onedrive" | "google_drive">(
    onedriveConnected ? "onedrive" : "google_drive"
  );
  
  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({
    onedrive: { files: [], loading: false, currentFolderId: null, breadcrumbs: [{ id: null, name: "OneDrive" }] },
    google_drive: { files: [], loading: false, currentFolderId: null, breadcrumbs: [{ id: null, name: "Google Drive" }] },
  });

  const fetchFiles = async (provider: "onedrive" | "google_drive", folderId: string | null = null) => {
    setProviderStates(prev => ({
      ...prev,
      [provider]: { ...prev[provider], loading: true }
    }));

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) {
        toast.error("Please sign in to browse files");
        return;
      }

      const { data, error } = await supabase.functions.invoke("browse-files", {
        body: { provider, folderId },
      });

      if (error) throw error;
      
      const filesWithProvider = (data.files || []).map((f: Omit<FileItem, 'provider'>) => ({
        ...f,
        provider
      }));
      
      // Filter to show only folders and audio files
      const filteredFiles = filesWithProvider.filter((f: FileItem) => 
        f.type === 'folder' || isAudioFile(f)
      );
      
      setProviderStates(prev => ({
        ...prev,
        [provider]: { ...prev[provider], files: filteredFiles, loading: false }
      }));
    } catch (error) {
      console.error("Error fetching files:", error);
      toast.error(`Failed to load ${provider === "onedrive" ? "OneDrive" : "Google Drive"} files`);
      setProviderStates(prev => ({
        ...prev,
        [provider]: { ...prev[provider], loading: false }
      }));
    }
  };

  useEffect(() => {
    if (onedriveConnected) {
      fetchFiles("onedrive", providerStates.onedrive.currentFolderId);
    }
  }, [onedriveConnected, providerStates.onedrive.currentFolderId]);

  useEffect(() => {
    if (googleDriveConnected) {
      fetchFiles("google_drive", providerStates.google_drive.currentFolderId);
    }
  }, [googleDriveConnected, providerStates.google_drive.currentFolderId]);

  const handleFolderClick = (provider: "onedrive" | "google_drive" | "local_storage", folder: FileItem) => {
    if (folder.type !== "folder") return;
    if (provider === "local_storage") return;

    setProviderStates(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        currentFolderId: folder.id,
        breadcrumbs: [...prev[provider].breadcrumbs, { id: folder.id, name: folder.name }]
      }
    }));
  };

  const handleBreadcrumbClick = (provider: "onedrive" | "google_drive" | "local_storage", index: number) => {
    if (provider === "local_storage") return;
    const state = providerStates[provider];
    const breadcrumb = state.breadcrumbs[index];
    
    setProviderStates(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        currentFolderId: breadcrumb.id,
        breadcrumbs: state.breadcrumbs.slice(0, index + 1)
      }
    }));
  };

  const handleBack = (provider: "onedrive" | "google_drive" | "local_storage") => {
    if (provider === "local_storage") return;
    const state = providerStates[provider];
    if (state.breadcrumbs.length > 1) {
      const newBreadcrumbs = state.breadcrumbs.slice(0, -1);
      setProviderStates(prev => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          currentFolderId: newBreadcrumbs[newBreadcrumbs.length - 1].id,
          breadcrumbs: newBreadcrumbs
        }
      }));
    }
  };

  const handleItemClick = (file: FileItem) => {
    if (file.type === "folder") {
      handleFolderClick(file.provider, file);
    } else if (isAudioFile(file)) {
      onFileSelect(file);
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const renderProviderContent = (provider: "onedrive" | "google_drive") => {
    const state = providerStates[provider];
    const isConnected = provider === "onedrive" ? onedriveConnected : googleDriveConnected;
    const ProviderIcon = provider === "onedrive" ? OneDriveIcon : GoogleDriveIcon;
    const providerName = provider === "onedrive" ? "OneDrive" : "Google Drive";

    if (!isConnected) {
      return (
        <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground">
          <ProviderIcon className="w-12 h-12 mb-4 opacity-50" />
          <p>{providerName} is not connected</p>
          <Button variant="outline" className="mt-4" onClick={() => window.location.href = "/"}>
            Connect {providerName}
          </Button>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
          {state.breadcrumbs.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => handleBack(provider)}
              disabled={isProcessing}
            >
              <ArrowLeft className="w-3 h-3 mr-1" />
              Back
            </Button>
          )}
          {state.breadcrumbs.map((crumb, index) => (
            <React.Fragment key={crumb.id || "root"}>
              {index > 0 && <ChevronRight className="w-3 h-3" />}
              <button
                onClick={() => handleBreadcrumbClick(provider, index)}
                className="hover:text-foreground transition-colors"
                disabled={isProcessing}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 ml-auto"
            onClick={() => fetchFiles(provider, state.currentFolderId)}
            disabled={state.loading || isProcessing}
          >
            <RefreshCw className={`w-3 h-3 ${state.loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* File List */}
        <ScrollArea className="h-[300px] border rounded-lg">
          {state.loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : state.files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <FileAudio className="w-8 h-8 mb-2 opacity-50" />
              <p>No audio files found</p>
              <p className="text-xs mt-1">Navigate to a folder with audio files</p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {state.files.map((file) => (
                <button
                  key={file.id}
                  className={`w-full flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors text-left ${
                    isProcessing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                  }`}
                  onClick={() => !isProcessing && handleItemClick(file)}
                  disabled={isProcessing}
                >
                  {file.type === "folder" ? (
                    <Folder className="w-5 h-5 text-primary shrink-0" />
                  ) : (
                    <FileAudio className="w-5 h-5 text-accent shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium truncate block">
                      {file.name}
                    </span>
                  </div>

                  <span className="text-xs text-muted-foreground shrink-0">
                    {file.type === "file" ? formatSize(file.size) : ""}
                  </span>

                  {file.type === "folder" && (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    );
  };

  const connectedProviders = [
    onedriveConnected && "onedrive",
    googleDriveConnected && "google_drive"
  ].filter(Boolean) as ("onedrive" | "google_drive")[];

  if (connectedProviders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <HardDrive className="w-12 h-12 mb-4 text-muted-foreground" />
        <p className="text-muted-foreground mb-4">No cloud services connected</p>
        <Button variant="gradient" onClick={() => window.location.href = "/"}>
          Connect Services
        </Button>
      </div>
    );
  }

  return (
    <Tabs value={activeProvider} onValueChange={(v) => setActiveProvider(v as "onedrive" | "google_drive")}>
      <TabsList className="w-full mb-4">
        {onedriveConnected && (
          <TabsTrigger value="onedrive" className="flex-1 gap-2" disabled={isProcessing}>
            <OneDriveIcon className="w-4 h-4" />
            OneDrive
          </TabsTrigger>
        )}
        {googleDriveConnected && (
          <TabsTrigger value="google_drive" className="flex-1 gap-2" disabled={isProcessing}>
            <GoogleDriveIcon className="w-4 h-4" />
            Google Drive
          </TabsTrigger>
        )}
      </TabsList>

      {onedriveConnected && (
        <TabsContent value="onedrive">
          {renderProviderContent("onedrive")}
        </TabsContent>
      )}
      {googleDriveConnected && (
        <TabsContent value="google_drive">
          {renderProviderContent("google_drive")}
        </TabsContent>
      )}
    </Tabs>
  );
};
