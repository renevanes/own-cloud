import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useConnectedAccounts, StorageAccount } from "@/hooks/useConnectedAccounts";
import { useAuth } from "@/hooks/useAuth";
import { 
  Folder, 
  File,
  FileAudio,
  ChevronRight, 
  ArrowLeft, 
  Loader2, 
  RefreshCw, 
  Plus,
  Home,
  ExternalLink
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface SourceFileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
  provider: "onedrive" | "google_drive" | "local_storage";
  accountId?: string;
}

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

interface ProviderState {
  files: SourceFileItem[];
  loading: boolean;
  currentFolderId: string | null;
  breadcrumbs: BreadcrumbItem[];
}

type StorageKey = string;

const getStorageKey = (account: StorageAccount): StorageKey => {
  return `${account.provider}-${account.id}`;
};

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

export interface SourceSelectorProps {
  onSelect: (item: SourceFileItem, path: string) => void;
  selectedItemId?: string | null;
  allowFileSelection?: boolean;
  filterAudioOnly?: boolean;
  showAddButton?: boolean;
  onAdd?: (item: SourceFileItem, path: string) => void;
  isItemConfigured?: (itemId: string, provider: string) => boolean;
  /** Filter to show only specific providers */
  providerFilter?: ("onedrive" | "google_drive" | "local_storage")[];
  /** Show a confirmation button to finalize selection */
  showConfirmButton?: boolean;
  /** Label for confirm button */
  confirmButtonLabel?: string;
  /** Called when confirm button is clicked */
  onConfirm?: (item: SourceFileItem, path: string) => void;
}

export const SourceSelector: React.FC<SourceSelectorProps> = ({
  onSelect,
  selectedItemId,
  allowFileSelection = true,
  filterAudioOnly = false,
  showAddButton = false,
  onAdd,
  isItemConfigured,
  providerFilter,
  showConfirmButton = false,
  confirmButtonLabel = "Select",
  onConfirm,
}) => {
  const { getAllStorageAccounts, accounts } = useConnectedAccounts();
  const { user } = useAuth();
  
  const allAccountsRaw = React.useMemo(() => getAllStorageAccounts(), [accounts, user]);
  
  // Filter accounts by provider if specified
  const allAccounts = React.useMemo(() => {
    if (!providerFilter || providerFilter.length === 0) return allAccountsRaw;
    return allAccountsRaw.filter(acc => providerFilter.includes(acc.provider as any));
  }, [allAccountsRaw, providerFilter]);
  
  const [activeStorageKey, setActiveStorageKey] = useState<StorageKey | null>(null);
  const [selectedItem, setSelectedItem] = useState<{ item: SourceFileItem; path: string } | null>(null);
  const [storageStates, setStorageStates] = useState<Record<StorageKey, ProviderState>>({});

  const isAudioFile = (file: SourceFileItem): boolean => {
    const mime = file.mimeType?.toLowerCase() || "";
    const name = file.name.toLowerCase();
    return mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac|m4a|wma|webm)$/.test(name);
  };

  // Get external URL for cloud storage items
  const getExternalUrl = (item: SourceFileItem): string | null => {
    if (item.provider === "local_storage") return null;
    
    if (item.provider === "google_drive") {
      if (item.type === "folder") {
        return `https://drive.google.com/drive/folders/${item.id}`;
      }
      return `https://drive.google.com/file/d/${item.id}/view`;
    }
    
    if (item.provider === "onedrive") {
      // OneDrive URLs require the webUrl from the API, but we can link to the web interface
      // The item.id is the driveItem id which can be used with the web interface
      return `https://onedrive.live.com/?id=${item.id}`;
    }
    
    return null;
  };

  const handleOpenExternal = (item: SourceFileItem) => {
    const url = getExternalUrl(item);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  // Initialize states for all accounts
  useEffect(() => {
    const newStates: Record<StorageKey, ProviderState> = {};
    allAccounts.forEach((account) => {
      const key = getStorageKey(account);
      if (!storageStates[key]) {
        const displayName = account.provider === 'local_storage' 
          ? 'Local Storage' 
          : (account.account_email || account.account_name || account.provider);
        newStates[key] = {
          files: [],
          loading: false,
          currentFolderId: null,
          breadcrumbs: [{ id: null, name: displayName }],
        };
      } else {
        newStates[key] = storageStates[key];
      }
    });
    
    if (Object.keys(newStates).length > 0 && Object.keys(newStates).length !== Object.keys(storageStates).length) {
      setStorageStates(newStates);
    }
  }, [allAccounts]);

  // Set initial active storage
  useEffect(() => {
    if (!activeStorageKey && allAccounts.length > 0) {
      setActiveStorageKey(getStorageKey(allAccounts[0]));
    }
  }, [allAccounts, activeStorageKey]);

  const getAccountByKey = (key: StorageKey): StorageAccount | undefined => {
    return allAccounts.find(acc => getStorageKey(acc) === key);
  };

  const fetchLocalStorageFiles = useCallback(async (folderId: string | null) => {
    if (!user) return [];
    
    try {
      const prefix = folderId ? `${user.id}/${folderId}` : user.id;
      
      const { data, error } = await supabase.storage
        .from("user-files")
        .list(prefix, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
      
      if (error) throw error;
      
      const items = (data || [])
        .filter(item => item.name !== '.emptyFolderPlaceholder' && item.name !== '.placeholder')
        .map((item) => {
          const isFolder = item.id === null;
          const relativePath = folderId ? `${folderId}/${item.name}` : item.name;
          return {
            // Use the relative path as a stable unique ID (avoids duplicate folder names across different paths)
            id: relativePath,
            name: item.name,
            type: isFolder ? "folder" as const : "file" as const,
            mimeType: item.metadata?.mimetype,
            path: `/${relativePath}`,
            provider: "local_storage" as const,
            accountId: "local_storage",
          };
        });

      if (filterAudioOnly) {
        return items.filter(item => item.type === "folder" || isAudioFile(item));
      }
      return items;
    } catch (error) {
      console.error("Error fetching local storage:", error);
      return [];
    }
  }, [user, filterAudioOnly]);

  const fetchFiles = useCallback(async (storageKey: StorageKey, folderId: string | null = null) => {
    const account = getAccountByKey(storageKey);
    if (!account) return;

    setStorageStates((prev) => ({
      ...prev,
      [storageKey]: { ...prev[storageKey], loading: true },
    }));

    try {
      if (account.provider === "local_storage") {
        const files = await fetchLocalStorageFiles(folderId);
        setStorageStates((prev) => ({
          ...prev,
          [storageKey]: { ...prev[storageKey], files, loading: false },
        }));
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) {
        toast.error("Please sign in to browse files");
        setStorageStates((prev) => ({
          ...prev,
          [storageKey]: { ...prev[storageKey], loading: false, files: [] },
        }));
        return;
      }

      const { data, error } = await supabase.functions.invoke("browse-files", {
        body: { provider: account.provider, folderId, accountId: account.id },
      });

      if (error) throw error;

      let filesWithProvider = (data.files || []).map((f: any) => ({
        ...f,
        provider: account.provider,
        accountId: account.id,
      }));

      if (filterAudioOnly) {
        filesWithProvider = filesWithProvider.filter((f: SourceFileItem) => 
          f.type === "folder" || isAudioFile(f)
        );
      }

      setStorageStates((prev) => ({
        ...prev,
        [storageKey]: { ...prev[storageKey], files: filesWithProvider, loading: false },
      }));
    } catch (error) {
      console.error("Error fetching files:", error);
      const providerName = account.account_email || account.account_name || account.provider;
      toast.error(`Failed to load ${providerName} folders`);
      setStorageStates((prev) => ({
        ...prev,
        [storageKey]: { ...prev[storageKey], loading: false, files: [] },
      }));
    }
  }, [fetchLocalStorageFiles, allAccounts, filterAudioOnly]);

  // Fetch files when storage changes
  useEffect(() => {
    if (activeStorageKey && storageStates[activeStorageKey]) {
      fetchFiles(activeStorageKey, storageStates[activeStorageKey]?.currentFolderId);
    }
  }, [activeStorageKey]);

  const handleFolderNavigate = (storageKey: StorageKey, folder: SourceFileItem) => {
    const account = getAccountByKey(storageKey);
    const displayName = account?.provider === 'local_storage' 
      ? 'Local Storage' 
      : (account?.account_email || account?.account_name || account?.provider || storageKey);
    
    let newFolderId = folder.id;
    if (account?.provider === "local_storage") {
      const currentFolderId = storageStates[storageKey]?.currentFolderId;
      newFolderId = currentFolderId ? `${currentFolderId}/${folder.name}` : folder.name;
    }
    
    setStorageStates(prev => ({
      ...prev,
      [storageKey]: {
        ...prev[storageKey],
        currentFolderId: newFolderId,
        breadcrumbs: [...(prev[storageKey]?.breadcrumbs || [{ id: null, name: displayName }]), { id: newFolderId, name: folder.name }]
      }
    }));
    
    fetchFiles(storageKey, newFolderId);
  };

  const handleBreadcrumbClick = (storageKey: StorageKey, index: number) => {
    const state = storageStates[storageKey];
    if (!state) return;
    
    const breadcrumb = state.breadcrumbs[index];
    
    setStorageStates(prev => ({
      ...prev,
      [storageKey]: {
        ...prev[storageKey],
        currentFolderId: breadcrumb.id,
        breadcrumbs: state.breadcrumbs.slice(0, index + 1)
      }
    }));
    
    fetchFiles(storageKey, breadcrumb.id);
  };

  const handleBack = (storageKey: StorageKey) => {
    const state = storageStates[storageKey];
    if (!state || state.breadcrumbs.length <= 1) return;
    
    const newBreadcrumbs = state.breadcrumbs.slice(0, -1);
    const newFolderId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
    
    setStorageStates(prev => ({
      ...prev,
      [storageKey]: {
        ...prev[storageKey],
        currentFolderId: newFolderId,
        breadcrumbs: newBreadcrumbs
      }
    }));
    
    fetchFiles(storageKey, newFolderId);
  };

  const getCurrentPath = (storageKey: StorageKey, itemName: string): string => {
    const state = storageStates[storageKey];
    if (!state) return itemName;
    return state.breadcrumbs.map(b => b.name).join("/") + "/" + itemName;
  };

  const handleItemClick = (item: SourceFileItem) => {
    if (!activeStorageKey) return;

    // Selecting should work for BOTH folders and files (when allowFileSelection is true).
    // Folder navigation is handled via a dedicated "Open" control.
    if (item.type === "folder") {
      const path = getCurrentPath(activeStorageKey, item.name);
      setSelectedItem({ item, path });
      onSelect(item, path);
      return;
    }

    if (allowFileSelection) {
      const path = getCurrentPath(activeStorageKey, item.name);
      setSelectedItem({ item, path });
      onSelect(item, path);
    }
  };

  const handleOpenFolder = (item: SourceFileItem) => {
    if (!activeStorageKey) return;
    if (item.type !== "folder") return;
    handleFolderNavigate(activeStorageKey, item);
  };

  const handleSelectFolder = (item: SourceFileItem) => {
    if (!activeStorageKey) return;
    const path = getCurrentPath(activeStorageKey, item.name);
    setSelectedItem({ item, path });
    onSelect(item, path);
  };

  const handleConfirm = () => {
    if (selectedItem && onConfirm) {
      onConfirm(selectedItem.item, selectedItem.path);
    }
  };

  const handleAddClick = (item: SourceFileItem) => {
    if (!activeStorageKey || !onAdd) return;
    const path = getCurrentPath(activeStorageKey, item.name);
    onAdd(item, path);
  };

  const currentState = activeStorageKey ? storageStates[activeStorageKey] : null;
  const currentAccount = activeStorageKey ? getAccountByKey(activeStorageKey) : null;

  return (
    <div className="flex gap-4 h-full">
      {/* Left sidebar - Storage accounts */}
      <div className="w-56 border-r pr-4 overflow-y-auto">
        <ScrollArea className="h-full">
          <div className="space-y-1">
            {allAccounts.map((account) => {
              const key = getStorageKey(account);
              const ProviderIcon = getProviderIcon(account.provider);
              const displayName = account.provider === 'local_storage' 
                ? 'Local Storage' 
                : (account.account_email || account.account_name || account.provider);
              
              return (
                <button
                  key={key}
                  onClick={() => setActiveStorageKey(key)}
                  className={cn(
                    "w-full flex items-center gap-2 p-2 rounded-lg text-left text-sm transition-colors",
                    activeStorageKey === key 
                      ? "bg-primary/10 text-primary" 
                      : "hover:bg-muted/50"
                  )}
                >
                  <ProviderIcon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{displayName}</span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Right side - File browser */}
      <div className="flex-1 flex flex-col min-w-0">
        {currentState && currentAccount ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 mb-3">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => activeStorageKey && handleBack(activeStorageKey)}
                disabled={!currentState.breadcrumbs || currentState.breadcrumbs.length <= 1}
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => activeStorageKey && handleBreadcrumbClick(activeStorageKey, 0)}
              >
                <Home className="w-4 h-4" />
              </Button>
              
              <div className="flex-1 flex items-center gap-1 text-sm text-muted-foreground overflow-x-auto">
                {currentState.breadcrumbs?.map((crumb, index) => (
                  <React.Fragment key={crumb.id || "root"}>
                    {index > 0 && <ChevronRight className="w-3 h-3 shrink-0" />}
                    <button
                      onClick={() => activeStorageKey && handleBreadcrumbClick(activeStorageKey, index)}
                      className="hover:text-foreground transition-colors whitespace-nowrap"
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => activeStorageKey && fetchFiles(activeStorageKey, currentState.currentFolderId)}
                disabled={currentState.loading}
              >
                <RefreshCw className={cn("w-4 h-4", currentState.loading && "animate-spin")} />
              </Button>
            </div>

            {/* File and Folder List */}
            <ScrollArea className="flex-1 border rounded-lg">
              {currentState.loading ? (
                <div className="flex items-center justify-center h-full min-h-[200px]">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : currentState.files.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground">
                  <Folder className="w-10 h-10 mb-2 opacity-50" />
                  <p className="text-sm">{filterAudioOnly ? "No folders or audio files found" : "No files or folders found"}</p>
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {currentState.files.map((item) => {
                    const isConfigured = isItemConfigured?.(item.id, item.provider) ?? false;
                    const isFolder = item.type === "folder";
                    const isAudio = !isFolder && isAudioFile(item);
                    const isSelected = selectedItemId === item.id || selectedItem?.item.id === item.id;
                    
                    let ItemIcon = isFolder ? Folder : File;
                    if (isAudio) ItemIcon = FileAudio;
                    
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          "group flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors",
                          isConfigured && "bg-primary/5",
                          isSelected && "bg-primary/10 ring-1 ring-primary"
                        )}
                      >
                        <ItemIcon
                          className={cn(
                            "w-5 h-5 shrink-0",
                            isFolder ? "text-primary" : isAudio ? "text-orange-500" : "text-muted-foreground"
                          )}
                        />

                        <button
                          className="flex-1 text-left text-sm truncate hover:underline"
                          onClick={() => handleItemClick(item)}
                        >
                          {item.name}
                        </button>

                        {/* Open/navigate control for folders */}
                        {isFolder && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenFolder(item);
                            }}
                            aria-label={`Open ${item.name}`}
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        )}

                        {/* Select button for folders when in folder-only mode */}
                        {isFolder && !allowFileSelection && (
                          <Button
                            variant={isSelected ? "default" : "ghost"}
                            size="sm"
                            className="h-7 shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectFolder(item);
                            }}
                          >
                            {isSelected ? <Check className="w-3 h-3 mr-1" /> : null}
                            {isSelected ? "Selected" : "Select"}
                          </Button>
                        )}
                        
                        {/* Open in external service (Google Drive / OneDrive) */}
                        {item.provider !== "local_storage" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0 opacity-60 hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenExternal(item);
                            }}
                            aria-label={`Open in ${item.provider === "google_drive" ? "Google Drive" : "OneDrive"}`}
                            title={`Open in ${item.provider === "google_drive" ? "Google Drive" : "OneDrive"}`}
                          >
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                        
                        {showAddButton && !isConfigured && (isFolder || allowFileSelection) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAddClick(item);
                            }}
                          >
                            <Plus className="w-4 h-4" />
                          </Button>
                        )}
                        
                        {isConfigured && (
                          <span className="text-xs text-primary shrink-0">Added</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
            
            {/* Confirm button when showConfirmButton is true */}
            {showConfirmButton && selectedItem && (
              <div className="mt-3 pt-3 border-t flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
                  {selectedItem.item.type === "folder" ? (
                    <Folder className="w-4 h-4 shrink-0 text-primary" />
                  ) : (
                    <File className="w-4 h-4 shrink-0" />
                  )}
                  <span className="truncate">{selectedItem.path}</span>
                </div>
                <Button
                  variant="gradient"
                  size="sm"
                  onClick={handleConfirm}
                >
                  {confirmButtonLabel}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>Select a storage account to browse</p>
          </div>
        )}
      </div>
    </div>
  );
};
