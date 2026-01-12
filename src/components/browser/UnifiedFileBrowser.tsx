import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";
import { Folder, File, ChevronRight, ArrowLeft, Loader2, RefreshCw, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OneDriveIcon, GoogleDriveIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";

export interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  size: number;
  mimeType?: string;
  modifiedAt: string;
  path: string;
  provider: "onedrive" | "google_drive" | "local_storage";
}

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

interface UnifiedFileBrowserProps {
  selectionMode?: boolean;
  allowFiles?: boolean;
  selectedItems?: string[];
  onSelectionChange?: (items: FileItem[]) => void;
  onItemSelect?: (item: FileItem, path: string) => void;
}

export const UnifiedFileBrowser: React.FC<UnifiedFileBrowserProps> = ({
  selectionMode = false,
  allowFiles = false,
  selectedItems = [],
  onSelectionChange,
  onItemSelect,
}) => {
  const { onedriveConnected, googleDriveConnected } = useConnectedAccounts();
  
  const [activeProvider, setActiveProvider] = useState<"onedrive" | "google_drive">(
    onedriveConnected ? "onedrive" : "google_drive"
  );
  
  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({
    onedrive: { files: [], loading: false, currentFolderId: null, breadcrumbs: [{ id: null, name: "OneDrive" }] },
    google_drive: { files: [], loading: false, currentFolderId: null, breadcrumbs: [{ id: null, name: "Google Drive" }] },
  });

  const [selectedItemsList, setSelectedItemsList] = useState<FileItem[]>([]);

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
      
      setProviderStates(prev => ({
        ...prev,
        [provider]: { ...prev[provider], files: filesWithProvider, loading: false }
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
    // Only handle cloud providers in this component
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

  const handleBack = (provider: "onedrive" | "google_drive") => {
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

  const handleItemCheck = (item: FileItem, checked: boolean) => {
    let newSelection: FileItem[];
    if (checked) {
      newSelection = [...selectedItemsList, item];
    } else {
      newSelection = selectedItemsList.filter((i) => i.id !== item.id);
    }
    setSelectedItemsList(newSelection);
    onSelectionChange?.(newSelection);
  };

  const handleItemClick = (item: FileItem) => {
    const state = providerStates[item.provider];
    const path = state.breadcrumbs.map(b => b.name).join("/") + "/" + item.name;
    
    if (selectionMode && onItemSelect) {
      if (item.type === "folder" || allowFiles) {
        onItemSelect(item, path);
      }
    } else if (item.type === "folder") {
      handleFolderClick(item.provider, item);
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

  const formatDate = (dateString: string) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleDateString();
  };

  const renderProviderContent = (provider: "onedrive" | "google_drive") => {
    const state = providerStates[provider];
    const isConnected = provider === "onedrive" ? onedriveConnected : googleDriveConnected;
    const ProviderIcon = provider === "onedrive" ? OneDriveIcon : GoogleDriveIcon;
    const providerName = provider === "onedrive" ? "OneDrive" : "Google Drive";

    if (!isConnected) {
      return (
        <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground">
          <ProviderIcon className="w-12 h-12 mb-4 opacity-50" />
          <p>{providerName} is not connected</p>
          <Button variant="outline" className="mt-4" onClick={() => window.location.href = "/"}>
            Connect {providerName}
          </Button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
          {state.breadcrumbs.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => handleBack(provider)}
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
            disabled={state.loading}
          >
            <RefreshCw className={`w-3 h-3 ${state.loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* File List */}
        <ScrollArea className="h-[400px] border rounded-lg">
          {state.loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : state.files.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              No files found
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {state.files.map((file) => {
                const isSelectable = file.type === "folder" || allowFiles;
                const isSelected = selectedItemsList.some(i => i.id === file.id);
                
                return (
                  <div
                    key={file.id}
                    className={`flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors ${
                      isSelectable ? "cursor-pointer" : ""
                    } ${isSelected ? "bg-primary/10" : ""}`}
                    onClick={() => !selectionMode && file.type === "folder" && handleFolderClick(provider, file)}
                  >
                    {selectionMode && isSelectable && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => handleItemCheck(file, checked as boolean)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    
                    {file.type === "folder" ? (
                      <Folder className="w-5 h-5 text-primary shrink-0" />
                    ) : (
                      <File className="w-5 h-5 text-muted-foreground shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      <button
                        className="text-sm font-medium truncate block text-left w-full hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleItemClick(file);
                        }}
                      >
                        {file.name}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(file.modifiedAt)}
                      </span>
                    </div>

                    <span className="text-xs text-muted-foreground shrink-0">
                      {file.type === "file" ? formatSize(file.size) : ""}
                    </span>

                    {file.type === "folder" && !selectionMode && (
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    )}
                  </div>
                );
              })}
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
      <Card className="glass">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <HardDrive className="w-12 h-12 mb-4 text-muted-foreground" />
          <p className="text-muted-foreground mb-4">No cloud services connected</p>
          <Button variant="gradient" onClick={() => window.location.href = "/"}>
            Connect Services
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="w-5 h-5" />
          File Explorer
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={activeProvider} onValueChange={(v) => setActiveProvider(v as "onedrive" | "google_drive")}>
          <TabsList className="w-full mb-4">
            {onedriveConnected && (
              <TabsTrigger value="onedrive" className="flex-1 gap-2">
                <OneDriveIcon className="w-4 h-4" />
                OneDrive
              </TabsTrigger>
            )}
            {googleDriveConnected && (
              <TabsTrigger value="google_drive" className="flex-1 gap-2">
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
      </CardContent>
    </Card>
  );
};
