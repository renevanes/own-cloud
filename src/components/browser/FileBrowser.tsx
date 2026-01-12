import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Folder, File, ChevronRight, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";

interface FileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  size: number;
  mimeType?: string;
  modifiedAt: string;
  path: string;
}

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

interface FileBrowserProps {
  provider: "onedrive" | "google_drive" | "local";
  onFolderSelect?: (item: FileItem, path: string) => void;
  selectionMode?: boolean;
  selectedFolders?: string[];
  onSelectionChange?: (folderIds: string[]) => void;
  allowFileSelection?: boolean;
  selectedItemId?: string | null;
  compact?: boolean;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  provider,
  onFolderSelect,
  selectionMode = false,
  selectedFolders = [],
  onSelectionChange,
  allowFileSelection = false,
  selectedItemId = null,
  compact = false,
}) => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: null, name: "Root" },
  ]);

  const fetchFiles = async (folderId: string | null = null) => {
    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.access_token) {
        toast.error("Please sign in to browse files");
        return;
      }

      if (provider === "local") {
        // Fetch from Supabase storage
        const userId = sessionData.session.user.id;
        const folderPath = folderId || userId;
        
        const { data: storageFiles, error } = await supabase.storage
          .from("user-files")
          .list(folderPath, { limit: 100, sortBy: { column: 'name', order: 'asc' } });

        if (error) throw error;

        const mappedFiles: FileItem[] = (storageFiles || []).map((f) => {
          // Build the full path for the item
          const itemPath = folderId ? `${folderId}/${f.name}` : `${userId}/${f.name}`;
          return {
            id: itemPath, // Use full path as ID
            name: f.name,
            type: f.metadata ? "file" as const : "folder" as const,
            size: f.metadata?.size || 0,
            mimeType: f.metadata?.mimetype,
            modifiedAt: f.updated_at || f.created_at || "",
            path: itemPath,
          };
        });
        setFiles(mappedFiles);
      } else {
        const { data, error } = await supabase.functions.invoke("browse-files", {
          body: { provider, folderId },
        });

        if (error) throw error;
        setFiles(data.files || []);
      }
    } catch (error) {
      console.error("Error fetching files:", error);
      toast.error("Failed to load files");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles(currentFolderId);
  }, [currentFolderId, provider]);

  const handleFolderClick = (folder: FileItem) => {
    if (folder.type !== "folder") return;

    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    const breadcrumb = breadcrumbs[index];
    setCurrentFolderId(breadcrumb.id);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleBack = () => {
    if (breadcrumbs.length > 1) {
      const newBreadcrumbs = breadcrumbs.slice(0, -1);
      setBreadcrumbs(newBreadcrumbs);
      setCurrentFolderId(newBreadcrumbs[newBreadcrumbs.length - 1].id);
    }
  };

  const handleFolderCheck = (folder: FileItem, checked: boolean) => {
    if (!onSelectionChange) return;

    if (checked) {
      onSelectionChange([...selectedFolders, folder.id]);
    } else {
      onSelectionChange(selectedFolders.filter((id) => id !== folder.id));
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

  const getProviderConfig = () => {
    switch (provider) {
      case "onedrive":
        return { Icon: OneDriveIcon, name: "OneDrive", color: "text-onedrive" };
      case "google_drive":
        return { Icon: GoogleDriveIcon, name: "Google Drive", color: "text-google-drive" };
      case "local":
        return { Icon: LocalStorageIcon, name: "Local Storage", color: "text-primary" };
    }
  };
  
  const { Icon: ProviderIcon, name: providerName, color: providerColor } = getProviderConfig();

  const scrollHeight = compact ? "h-[200px]" : "h-[300px]";

  return (
    <Card className={`glass ${compact ? "p-0" : ""}`}>
      <CardHeader className={compact ? "py-2 px-3" : "pb-3"}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ProviderIcon className={`w-4 h-4 ${providerColor}`} />
            <CardTitle className={compact ? "text-sm" : "text-lg"}>{providerName}</CardTitle>
          </div>
          <div className="flex items-center gap-1">
            {breadcrumbs.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={handleBack}
              >
                <ArrowLeft className="w-3 h-3 mr-1" />
                Back
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => fetchFiles(currentFolderId)}
              disabled={loading}
            >
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Compact Breadcrumbs */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1 flex-wrap">
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={crumb.id || "root"}>
              {index > 0 && <ChevronRight className="w-3 h-3" />}
              <button
                onClick={() => handleBreadcrumbClick(index)}
                className="hover:text-foreground transition-colors"
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>
      </CardHeader>

      <CardContent className={compact ? "py-2 px-3" : ""}>
        <ScrollArea className={scrollHeight}>
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : files.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No files found
            </div>
          ) : (
            <RadioGroup
              value={selectedItemId || ""}
              onValueChange={(value) => {
                const file = files.find(f => f.id === value);
                if (file && onFolderSelect) {
                  const path = breadcrumbs.map(b => b.name).join("/") + "/" + file.name;
                  onFolderSelect(file, path);
                }
              }}
              className="space-y-0.5"
            >
              {files.map((file) => {
                const isSelectable = file.type === "folder" || (file.type === "file" && allowFileSelection);
                
                return (
                  <div
                    key={file.id}
                    className={`flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted/50 transition-colors ${
                      file.type === "folder" ? "cursor-pointer" : ""
                    } ${selectedItemId === file.id ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}
                  >
                    {/* Radio button for selection */}
                    {selectionMode && isSelectable && (
                      <RadioGroupItem
                        value={file.id}
                        id={file.id}
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    
                    {/* Checkbox mode for multi-select */}
                    {!selectionMode && file.type === "folder" && onSelectionChange && (
                      <Checkbox
                        checked={selectedFolders.includes(file.id)}
                        onCheckedChange={(checked) =>
                          handleFolderCheck(file, checked as boolean)
                        }
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    
                    {file.type === "folder" ? (
                      <Folder className="w-4 h-4 text-primary shrink-0" />
                    ) : (
                      <File className="w-4 h-4 text-muted-foreground shrink-0" />
                    )}

                    <div 
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => {
                        if (file.type === "folder") {
                          handleFolderClick(file);
                        } else if (file.type === "file" && allowFileSelection && onFolderSelect) {
                          const path = breadcrumbs.map(b => b.name).join("/") + "/" + file.name;
                          onFolderSelect(file, path);
                        }
                      }}
                    >
                      <span className="text-sm font-medium truncate block">
                        {file.name}
                      </span>
                    </div>

                    <span className="text-xs text-muted-foreground shrink-0">
                      {file.type === "file" ? formatSize(file.size) : ""}
                    </span>

                    {file.type === "folder" && (
                      <ChevronRight 
                        className="w-4 h-4 text-muted-foreground shrink-0 cursor-pointer hover:text-foreground" 
                        onClick={() => handleFolderClick(file)}
                      />
                    )}
                  </div>
                );
              })}
            </RadioGroup>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
