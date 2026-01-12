import React, { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useConnectedAccounts, StorageAccount } from "@/hooks/useConnectedAccounts";
import { useAuth } from "@/hooks/useAuth";
import { 
  Folder, File, ChevronRight, ChevronDown, ArrowLeft, ArrowRight,
  Loader2, RefreshCw, HardDrive, Grid3X3, List, Search, Home,
  FileText, FileImage, FileVideo, FileAudio, FileArchive, 
  Trash2, Edit3, Copy, Download, Upload, FolderPlus, MoreHorizontal,
  ExternalLink
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { FilePreview } from "./FilePreview";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  size: number;
  mimeType?: string;
  modifiedAt: string;
  path: string;
  provider: "onedrive" | "google_drive" | "local_storage";
  accountId?: string; // To identify which account this file belongs to
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
  expanded: boolean;
}

type ViewMode = "list" | "grid";

// Unique key for each storage account
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

const getProviderColor = (provider: string): string => {
  switch (provider) {
    case 'onedrive':
      return 'text-[#0078D4]';
    case 'google_drive':
      return 'text-[#4285F4]';
    default:
      return 'text-primary';
  }
};

const getFileIcon = (file: FileItem) => {
  if (file.type === "folder") return Folder;

  const mime = file.mimeType?.toLowerCase() || "";
  const name = file.name.toLowerCase();

  if (mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/.test(name)) return FileImage;
  if (mime.startsWith("video/") || /\.(mp4|avi|mov|wmv|mkv|webm)$/.test(name)) return FileVideo;
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac)$/.test(name)) return FileAudio;
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return FileArchive;

  return FileText;
};

const getExternalUrl = (file: FileItem): string | null => {
  if (file.provider === "local_storage") return null;

  if (file.provider === "google_drive") {
    return file.type === "folder"
      ? `https://drive.google.com/drive/folders/${file.id}`
      : `https://drive.google.com/file/d/${file.id}/view`;
  }

  if (file.provider === "onedrive") {
    // Best-effort deep link without extra API calls
    return `https://onedrive.live.com/?id=${encodeURIComponent(file.id)}`;
  }

  return null;
};

export const WindowsExplorer: React.FC = () => {
  const { getAllStorageAccounts, accounts, loading: accountsLoading } = useConnectedAccounts();
  const { user } = useAuth();
  const [activeStorageKey, setActiveStorageKey] = useState<StorageKey | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [navigationHistory, setNavigationHistory] = useState<{ storageKey: StorageKey; folderId: string | null }[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  
  const [storageStates, setStorageStates] = useState<Record<StorageKey, ProviderState>>({});

  const allAccounts = useMemo(() => getAllStorageAccounts(), [accounts, user]);

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
          expanded: true,
        };
      } else {
        newStates[key] = storageStates[key];
      }
    });
    
    if (Object.keys(newStates).length !== Object.keys(storageStates).length) {
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
      
      return (data || [])
        .filter(item => item.name !== '.emptyFolderPlaceholder' && item.name !== '.placeholder')
        .map((item) => {
          const isFolder = item.id === null;
          
          return {
            id: isFolder ? item.name : (item.id || item.name),
            name: item.name,
            type: isFolder ? "folder" as const : "file" as const,
            size: item.metadata?.size || 0,
            mimeType: item.metadata?.mimetype,
            modifiedAt: item.updated_at || item.created_at || new Date().toISOString(),
            path: folderId ? `/${folderId}` : "/",
            provider: "local_storage" as const,
            accountId: "local_storage",
          };
        });
    } catch (error) {
      console.error("Error fetching local storage:", error);
      return [];
    }
  }, [user]);

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

      const filesWithProvider = (data.files || []).map((f: Omit<FileItem, "provider" | "accountId">) => ({
        ...f,
        provider: account.provider,
        accountId: account.id,
      }));

      setStorageStates((prev) => ({
        ...prev,
        [storageKey]: { ...prev[storageKey], files: filesWithProvider, loading: false },
      }));
    } catch (error) {
      console.error("Error fetching files:", error);
      const providerName = account.account_email || account.account_name || account.provider;
      toast.error(`Failed to load ${providerName} files`);
      setStorageStates((prev) => ({
        ...prev,
        [storageKey]: { ...prev[storageKey], loading: false, files: [] },
      }));
    }
  }, [fetchLocalStorageFiles, allAccounts]);

  const activeFolderId = activeStorageKey ? storageStates[activeStorageKey]?.currentFolderId : null;

  useEffect(() => {
    if (activeStorageKey && storageStates[activeStorageKey]) {
      fetchFiles(activeStorageKey, activeFolderId);
    }
  }, [activeStorageKey, activeFolderId, fetchFiles]);

  const navigateTo = (storageKey: StorageKey, folderId: string | null, folderName?: string) => {
    setActiveStorageKey(storageKey);
    
    const newHistory = navigationHistory.slice(0, historyIndex + 1);
    newHistory.push({ storageKey, folderId });
    setNavigationHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    
    const account = getAccountByKey(storageKey);
    const displayName = account?.provider === 'local_storage' 
      ? 'Local Storage' 
      : (account?.account_email || account?.account_name || account?.provider || storageKey);
    
    if (folderId === null) {
      setStorageStates(prev => ({
        ...prev,
        [storageKey]: {
          ...prev[storageKey],
          currentFolderId: null,
          breadcrumbs: [{ id: null, name: displayName }]
        }
      }));
    } else if (folderName) {
      setStorageStates(prev => ({
        ...prev,
        [storageKey]: {
          ...prev[storageKey],
          currentFolderId: folderId,
          breadcrumbs: [...(prev[storageKey]?.breadcrumbs || [{ id: null, name: displayName }]), { id: folderId, name: folderName }]
        }
      }));
    }
  };

  const handleFolderClick = (file: FileItem) => {
    if (file.type !== "folder") return;
    
    const storageKey = file.accountId ? `${file.provider}-${file.accountId}` : `${file.provider}-${file.provider}`;
    
    let newFolderId = file.id;
    if (file.provider === "local_storage") {
      const currentFolderId = storageStates[storageKey]?.currentFolderId;
      newFolderId = currentFolderId ? `${currentFolderId}/${file.name}` : file.name;
    }
    
    navigateTo(storageKey, newFolderId, file.name);
  };

  const handleFileClick = (file: FileItem) => {
    if (file.type === "file") {
      setPreviewFile(file);
      setPreviewOpen(true);
    }
  };

  const handleBreadcrumbClick = (storageKey: StorageKey, index: number) => {
    const state = storageStates[storageKey];
    if (!state) return;
    
    const breadcrumb = state.breadcrumbs[index];
    
    setNavigationHistory([...navigationHistory.slice(0, historyIndex + 1), { storageKey, folderId: breadcrumb.id }]);
    setHistoryIndex(navigationHistory.length);
    
    setStorageStates(prev => ({
      ...prev,
      [storageKey]: {
        ...prev[storageKey],
        currentFolderId: breadcrumb.id,
        breadcrumbs: state.breadcrumbs.slice(0, index + 1)
      }
    }));
  };

  const goBack = () => {
    if (historyIndex > 0) {
      const prevState = navigationHistory[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setActiveStorageKey(prevState.storageKey);
      
      const state = storageStates[prevState.storageKey];
      if (state) {
        const breadcrumbIndex = state.breadcrumbs.findIndex(b => b.id === prevState.folderId);
        if (breadcrumbIndex >= 0) {
          setStorageStates(prev => ({
            ...prev,
            [prevState.storageKey]: {
              ...prev[prevState.storageKey],
              currentFolderId: prevState.folderId,
              breadcrumbs: state.breadcrumbs.slice(0, breadcrumbIndex + 1)
            }
          }));
        }
      }
    }
  };

  const goForward = () => {
    if (historyIndex < navigationHistory.length - 1) {
      const nextState = navigationHistory[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setActiveStorageKey(nextState.storageKey);
    }
  };

  const goHome = () => {
    if (activeStorageKey) {
      navigateTo(activeStorageKey, null);
    }
  };

  const toggleExpanded = (storageKey: StorageKey) => {
    setStorageStates(prev => ({
      ...prev,
      [storageKey]: { ...prev[storageKey], expanded: !prev[storageKey]?.expanded }
    }));
  };

  // File operations
  const handleDelete = async (file: FileItem) => {
    if (!confirm(`Are you sure you want to delete "${file.name}"?`)) return;
    
    const storageKey = file.accountId ? `${file.provider}-${file.accountId}` : `${file.provider}-local_storage`;
    
    try {
      if (file.provider === "local_storage" && user) {
        const path = `${user.id}/${file.path === "/" ? "" : file.path + "/"}${file.name}`;
        const { error } = await supabase.storage.from("user-files").remove([path]);
        if (error) throw error;
        toast.success(`Deleted "${file.name}"`);
      } else {
        const { error } = await supabase.functions.invoke("file-operations", {
          body: { operation: "delete", provider: file.provider, fileId: file.id, accountId: file.accountId },
        });
        if (error) throw error;
        toast.success(`Deleted "${file.name}"`);
      }
      fetchFiles(storageKey, storageStates[storageKey]?.currentFolderId);
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete file");
    }
  };

  const handleRename = async () => {
    if (!selectedFile || !newFileName.trim()) return;
    
    const storageKey = selectedFile.accountId ? `${selectedFile.provider}-${selectedFile.accountId}` : `${selectedFile.provider}-local_storage`;
    
    try {
      if (selectedFile.provider === "local_storage" && user) {
        const oldPath = `${user.id}/${selectedFile.path === "/" ? "" : selectedFile.path + "/"}${selectedFile.name}`;
        const newPath = `${user.id}/${selectedFile.path === "/" ? "" : selectedFile.path + "/"}${newFileName}`;
        
        const { data: fileData, error: downloadError } = await supabase.storage
          .from("user-files")
          .download(oldPath);
        if (downloadError) throw downloadError;
        
        const { error: uploadError } = await supabase.storage
          .from("user-files")
          .upload(newPath, fileData);
        if (uploadError) throw uploadError;
        
        await supabase.storage.from("user-files").remove([oldPath]);
        toast.success(`Renamed to "${newFileName}"`);
      } else {
        const { error } = await supabase.functions.invoke("file-operations", {
          body: { operation: "rename", provider: selectedFile.provider, fileId: selectedFile.id, newName: newFileName, accountId: selectedFile.accountId },
        });
        if (error) throw error;
        toast.success(`Renamed to "${newFileName}"`);
      }
      setRenameDialogOpen(false);
      setNewFileName("");
      fetchFiles(storageKey, storageStates[storageKey]?.currentFolderId);
    } catch (error) {
      console.error("Rename error:", error);
      toast.error("Failed to rename file");
    }
  };

  const handleCreateFolder = async () => {
    if (!activeStorageKey || !newFolderName.trim() || !user) return;
    
    const account = getAccountByKey(activeStorageKey);
    if (!account) return;
    
    try {
      if (account.provider === "local_storage") {
        const currentFolder = storageStates[activeStorageKey]?.currentFolderId;
        const path = `${user.id}/${currentFolder ? currentFolder + "/" : ""}${newFolderName}/.placeholder`;
        
        const { error } = await supabase.storage
          .from("user-files")
          .upload(path, new Blob([""]), { contentType: "text/plain" });
        if (error) throw error;
        toast.success(`Created folder "${newFolderName}"`);
      } else {
        const currentFolder = storageStates[activeStorageKey]?.currentFolderId;
        const { error } = await supabase.functions.invoke("file-operations", {
          body: { operation: "createFolder", provider: account.provider, parentFolderId: currentFolder, folderName: newFolderName, accountId: account.id },
        });
        if (error) throw error;
        toast.success(`Created folder "${newFolderName}"`);
      }
      setNewFolderDialogOpen(false);
      setNewFolderName("");
      fetchFiles(activeStorageKey, storageStates[activeStorageKey]?.currentFolderId);
    } catch (error) {
      console.error("Create folder error:", error);
      toast.error("Failed to create folder");
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !activeStorageKey || !user) return;

    const account = getAccountByKey(activeStorageKey);
    if (!account) return;

    try {
      const currentFolder = storageStates[activeStorageKey]?.currentFolderId;
      
      if (account.provider === "local_storage") {
        for (const file of Array.from(files)) {
          const path = `${user.id}/${currentFolder ? currentFolder + "/" : ""}${file.name}`;
          const { error } = await supabase.storage.from("user-files").upload(path, file);
          if (error) throw error;
        }
        toast.success(`Uploaded ${files.length} file(s)`);
      } else {
        for (const file of Array.from(files)) {
          const arrayBuffer = await file.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
          
          const { error } = await supabase.functions.invoke("file-operations", {
            body: {
              operation: "upload",
              provider: account.provider,
              parentFolderId: currentFolder,
              fileName: file.name,
              fileContent: base64,
              mimeType: file.type || "application/octet-stream",
              accountId: account.id,
            },
          });
          if (error) throw error;
        }
        toast.success(`Uploaded ${files.length} file(s) to cloud`);
      }
      fetchFiles(activeStorageKey, currentFolder);
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("Failed to upload files");
    }
    
    e.target.value = "";
  };

  const handleDownload = async (file: FileItem) => {
    try {
      if (file.provider === "local_storage" && user) {
        const path = `${user.id}/${file.path === "/" ? "" : file.path + "/"}${file.name}`;
        const { data, error } = await supabase.storage.from("user-files").download(path);
        if (error) throw error;
        
        const url = URL.createObjectURL(data);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.info(`Downloading ${file.name}...`);
        const { data, error } = await supabase.functions.invoke("file-operations", {
          body: { operation: "download", provider: file.provider, fileId: file.id, accountId: file.accountId },
        });
        if (error) throw error;
        
        const binaryString = atob(data.content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: data.mimeType });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = data.name;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Downloaded ${data.name}`);
      }
    } catch (error) {
      console.error("Download error:", error);
      toast.error("Failed to download file");
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
    return new Date(dateString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const currentState = activeStorageKey ? storageStates[activeStorageKey] : null;
  const filteredFiles = currentState?.files.filter(f => 
    f.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const sortedFiles = [...filteredFiles].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (allAccounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground glass rounded-xl">
        <HardDrive className="w-16 h-16 mb-4 opacity-50" />
        <p className="text-lg mb-4">Please sign in to access files</p>
      </div>
    );
  }

  const activeAccount = activeStorageKey ? getAccountByKey(activeStorageKey) : null;

  return (
    <div className="glass rounded-xl overflow-hidden border border-border/50">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 border-b border-border/50 bg-secondary/30 flex-wrap">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={goBack} disabled={historyIndex <= 0}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={goForward} disabled={historyIndex >= navigationHistory.length - 1}>
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={goHome}>
            <Home className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => activeStorageKey && fetchFiles(activeStorageKey, currentState?.currentFolderId)}
            disabled={!activeStorageKey || currentState?.loading}
          >
            <RefreshCw className={cn("h-4 w-4", currentState?.loading && "animate-spin")} />
          </Button>
        </div>

        <Separator orientation="vertical" className="h-6" />

        <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => setNewFolderDialogOpen(true)}>
          <FolderPlus className="h-4 w-4" />
          <span className="hidden sm:inline">New Folder</span>
        </Button>
        <label>
          <Button variant="ghost" size="sm" className="h-8 gap-1" asChild>
            <span>
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">Upload</span>
            </span>
          </Button>
          <input type="file" className="hidden" multiple onChange={handleUpload} />
        </label>
        <Separator orientation="vertical" className="h-6" />

        {/* Breadcrumb */}
        <div className="flex-1 flex items-center gap-1 px-2 py-1 bg-background/50 rounded border border-border/50 text-sm overflow-x-auto min-w-0">
          {activeStorageKey && activeAccount && currentState && (
            <>
              {React.createElement(getProviderIcon(activeAccount.provider), { className: "h-4 w-4 shrink-0" })}
              {currentState.breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.id || "root"}>
                  <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                  <button
                    onClick={() => handleBreadcrumbClick(activeStorageKey, index)}
                    className="hover:text-primary transition-colors whitespace-nowrap"
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </>
          )}
        </div>

        <Separator orientation="vertical" className="h-6" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 w-32 sm:w-40 pl-8 text-sm"
          />
        </div>

        {/* View Toggle */}
        <div className="flex items-center border border-border/50 rounded">
          <Button variant={viewMode === "list" ? "secondary" : "ghost"} size="icon" className="h-8 w-8 rounded-r-none" onClick={() => setViewMode("list")}>
            <List className="h-4 w-4" />
          </Button>
          <Button variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon" className="h-8 w-8 rounded-l-none" onClick={() => setViewMode("grid")}>
            <Grid3X3 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex h-[400px]">
        {/* Sidebar - All Storage Accounts */}
        <div className="w-48 sm:w-56 border-r border-border/50 bg-secondary/20 shrink-0">
          <ScrollArea className="h-full">
            <div className="p-2 space-y-1">
              {allAccounts.map((account) => {
                const storageKey = getStorageKey(account);
                const state = storageStates[storageKey];
                const isActive = activeStorageKey === storageKey && state?.currentFolderId === null;
                const Icon = getProviderIcon(account.provider);
                const displayName = account.provider === 'local_storage' 
                  ? 'Local Storage' 
                  : (account.account_name || account.provider.replace('_', ' '));
                const email = account.account_email;
                
                return (
                  <div key={storageKey}>
                    <button
                      onClick={() => {
                        if (activeStorageKey !== storageKey || state?.currentFolderId !== null) {
                          navigateTo(storageKey, null);
                        }
                        toggleExpanded(storageKey);
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 p-2 rounded-lg text-sm transition-colors text-left",
                        isActive ? "bg-primary/20 text-primary" : "hover:bg-muted/50"
                      )}
                    >
                      {state?.expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <Icon className={cn("h-4 w-4 shrink-0", getProviderColor(account.provider))} />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{displayName}</span>
                        {email && (
                          <span className="block text-xs text-muted-foreground truncate">{email}</span>
                        )}
                      </div>
                    </button>
                    
                    {state?.expanded && state.files.filter(f => f.type === "folder").slice(0, 5).map((folder) => (
                      <button
                        key={folder.id}
                        onClick={() => handleFolderClick({ ...folder, accountId: account.id })}
                        className={cn(
                          "w-full flex items-center gap-2 p-2 pl-8 rounded-lg text-sm transition-colors",
                          activeStorageKey === storageKey && state?.currentFolderId === folder.id
                            ? "bg-primary/20 text-primary"
                            : "hover:bg-muted/50 text-muted-foreground"
                        )}
                      >
                        <Folder className="h-4 w-4 shrink-0" />
                        <span className="truncate text-xs">{folder.name}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Main Content */}
        <div className="flex-1 bg-background/30 min-w-0">
          <ScrollArea className="h-full">
            {currentState?.loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : sortedFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Folder className="w-12 h-12 mb-2 opacity-50" />
                <p>{searchQuery ? "No matching files found" : "This folder is empty"}</p>
              </div>
            ) : viewMode === "list" ? (
              <div className="p-1">
                <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground font-medium border-b border-border/30 sticky top-0 bg-background/80 backdrop-blur-sm">
                  <div className="w-8" />
                  <div className="flex-1">Name</div>
                  <div className="w-28 text-right hidden sm:block">Date modified</div>
                  <div className="w-16 text-right">Size</div>
                  <div className="w-8" />
                </div>
                
                {sortedFiles.map((file) => {
                  const FileIcon = getFileIcon(file);
                  return (
                    <div
                      key={file.id}
                      className="flex items-center gap-2 p-2 hover:bg-muted/30 rounded cursor-pointer transition-colors group"
                      onDoubleClick={() => (file.type === "folder" ? handleFolderClick(file) : handleFileClick(file))}
                    >
                      <FileIcon className={cn("w-5 h-5 shrink-0", file.type === "folder" ? "text-primary" : "text-muted-foreground")} />
                      <span className="flex-1 truncate text-sm group-hover:text-primary transition-colors">{file.name}</span>
                      <span className="w-28 text-right text-xs text-muted-foreground hidden sm:block">{formatDate(file.modifiedAt)}</span>
                      <span className="w-16 text-right text-xs text-muted-foreground">{file.type === "file" ? formatSize(file.size) : ""}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {file.provider !== "local_storage" && (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  const url = getExternalUrl(file);
                                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                                  else toast.error("External link not available for this item");
                                }}
                              >
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open in {file.provider === "google_drive" ? "Google Drive" : "OneDrive"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          {file.type === "file" && (
                            <>
                              <DropdownMenuItem onClick={() => handleFileClick(file)}>
                                <FileText className="h-4 w-4 mr-2" />Preview
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleDownload(file)}>
                                <Download className="h-4 w-4 mr-2" />Download
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem onClick={() => { setSelectedFile(file); setNewFileName(file.name); setRenameDialogOpen(true); }}>
                            <Edit3 className="h-4 w-4 mr-2" />Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDelete(file)} className="text-destructive">
                            <Trash2 className="h-4 w-4 mr-2" />Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-4 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
                {sortedFiles.map((file) => {
                  const FileIcon = getFileIcon(file);
                  return (
                    <div
                      key={file.id}
                      className="flex flex-col items-center p-3 hover:bg-muted/30 rounded-lg cursor-pointer transition-colors group relative"
                      onDoubleClick={() => (file.type === "folder" ? handleFolderClick(file) : handleFileClick(file))}
                    >
                      <FileIcon className={cn("w-10 h-10 mb-2", file.type === "folder" ? "text-primary" : "text-muted-foreground")} />
                      <span className="text-xs text-center truncate w-full group-hover:text-primary transition-colors">{file.name}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-5 w-5 absolute top-1 right-1 opacity-0 group-hover:opacity-100">
                            <MoreHorizontal className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {file.provider !== "local_storage" && (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  const url = getExternalUrl(file);
                                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                                  else toast.error("External link not available for this item");
                                }}
                              >
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open in {file.provider === "google_drive" ? "Google Drive" : "OneDrive"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          {file.type === "file" && (
                            <>
                              <DropdownMenuItem onClick={() => handleFileClick(file)}>
                                <FileText className="h-4 w-4 mr-2" />Preview
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleDownload(file)}>
                                <Download className="h-4 w-4 mr-2" />Download
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem onClick={() => { setSelectedFile(file); setNewFileName(file.name); setRenameDialogOpen(true); }}>
                            <Edit3 className="h-4 w-4 mr-2" />Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDelete(file)} className="text-destructive">
                            <Trash2 className="h-4 w-4 mr-2" />Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      <FilePreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        file={
          previewFile
            ? {
                id: previewFile.id,
                name: previewFile.name,
                type: previewFile.type,
                mimeType: previewFile.mimeType,
                provider: previewFile.provider,
                accountId: previewFile.accountId,
                path: previewFile.path,
              }
            : null
        }
      />

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <Input value={newFileName} onChange={(e) => setNewFileName(e.target.value)} placeholder="New name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
          </DialogHeader>
          <Input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="Folder name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateFolder}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/50 bg-secondary/30 text-xs text-muted-foreground">
        <span>{sortedFiles.length} item{sortedFiles.length !== 1 ? "s" : ""}{searchQuery && ` (filtered)`}</span>
        <span>{activeAccount?.account_email || activeAccount?.account_name || activeAccount?.provider}</span>
      </div>
    </div>
  );
};
