import { useState, useCallback } from "react";
import JSZip from "jszip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  Cloud,
  Check,
  Loader2,
  MessageSquare,
  Phone,
  AlertCircle,
  Archive,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { FileBrowser } from "@/components/browser/FileBrowser";
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts";

// Size limits
const MAX_ZIP_SIZE_BYTES = 2.5 * 1024 * 1024 * 1024; // 2.5 GB
const MAX_TXT_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB for extracted .txt

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete: () => void;
}

interface ParsedConversation {
  name: string;
  phoneNumber?: string;
  messageCount: number;
  firstMessageAt?: string;
  lastMessageAt?: string;
}

interface PreviewData {
  format: "whatsapp" | "sms";
  conversations: ParsedConversation[];
  filename: string;
  content: string;
}

export function ImportDialog({
  open,
  onOpenChange,
  onImportComplete,
}: ImportDialogProps) {
  const { session } = useAuth();
  const { toast } = useToast();
  const { accounts } = useConnectedAccounts();
  const [step, setStep] = useState<"select" | "preview" | "importing">("select");
  const [source, setSource] = useState<"local" | "cloud">("local");
  const [selectedProvider, setSelectedProvider] = useState<"google_drive" | "onedrive" | "">("");
  const [userIdentifier, setUserIdentifier] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string>("");
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cloudProviders = accounts.filter((a) =>
    ["google_drive", "onedrive"].includes(a.provider)
  );

  const resetState = useCallback(() => {
    setStep("select");
    setSource("local");
    setSelectedProvider("");
    setUserIdentifier("");
    setIsLoading(false);
    setLoadingMessage("");
    setLoadingProgress(0);
    setPreviewData(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onOpenChange(false);
  }, [onOpenChange, resetState]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const extractTxtFromZip = async (zipData: ArrayBuffer, filename: string): Promise<{ content: string; txtFilename: string }> => {
    setLoadingMessage("Opening ZIP archive...");
    setLoadingProgress(10);

    const zip = await JSZip.loadAsync(zipData);
    
    // Find .txt files in the ZIP (WhatsApp exports have _chat.txt or similar)
    const txtFiles = Object.keys(zip.files).filter(
      (name) => name.toLowerCase().endsWith(".txt") && !zip.files[name].dir
    );

    if (txtFiles.length === 0) {
      throw new Error("No .txt file found in ZIP. WhatsApp exports should contain a chat .txt file.");
    }

    // Prefer files with "chat" in the name, otherwise take the first .txt
    const targetFile = txtFiles.find((f) => f.toLowerCase().includes("chat")) || txtFiles[0];
    const zipFile = zip.files[targetFile];

    setLoadingMessage(`Extracting ${targetFile}...`);
    setLoadingProgress(30);

    const content = await zipFile.async("string");
    
    // Check extracted content size
    const contentSize = new Blob([content]).size;
    if (contentSize > MAX_TXT_SIZE_BYTES) {
      throw new Error(
        `Chat file is too large (${formatFileSize(contentSize)}). Maximum supported: ${formatFileSize(MAX_TXT_SIZE_BYTES)}`
      );
    }

    setLoadingProgress(80);
    
    return { content, txtFilename: targetFile };
  };

  const parseFile = async (content: string, filename: string) => {
    setLoadingMessage("Parsing messages...");
    setLoadingProgress(90);

    try {
      const { data, error: fnError } = await supabase.functions.invoke(
        "parse-chat-backup",
        {
          body: {
            content,
            filename,
            userIdentifier,
            saveToDatabase: false, // Preview only
          },
        }
      );

      if (fnError) throw fnError;
      if (data.error) throw new Error(data.error);

      setLoadingProgress(100);
      setPreviewData({
        format: data.format,
        conversations: data.conversations,
        filename,
        content,
      });
      setStep("preview");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to parse file";
      setError(message);
      toast({
        title: "Parse Error",
        description: message,
        variant: "destructive",
      });
    }
  };

  const handleLocalUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setError(null);
    setLoadingProgress(0);

    try {
      const lowerName = file.name.toLowerCase();
      const isZip = lowerName.endsWith(".zip");

      // Check file size
      if (isZip && file.size > MAX_ZIP_SIZE_BYTES) {
        throw new Error(
          `ZIP file is too large (${formatFileSize(file.size)}). Maximum supported: ${formatFileSize(MAX_ZIP_SIZE_BYTES)}`
        );
      }

      if (isZip) {
        setLoadingMessage("Reading ZIP file...");
        setLoadingProgress(5);
        
        const arrayBuffer = await file.arrayBuffer();
        const { content, txtFilename } = await extractTxtFromZip(arrayBuffer, file.name);
        await parseFile(content, txtFilename);
      } else {
        // Regular .txt or .xml file
        setLoadingMessage("Reading file...");
        setLoadingProgress(20);
        
        const content = await file.text();
        await parseFile(content, file.name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to process file";
      setError(message);
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setLoadingMessage("");
      setLoadingProgress(0);
    }
  };

  const handleCloudFileSelect = async (file: {
    id: string;
    name: string;
    provider: string;
    size?: number;
  }) => {
    setIsLoading(true);
    setError(null);
    setLoadingProgress(0);

    const lowerName = file.name.toLowerCase();
    const isZip = lowerName.endsWith(".zip");

    // Check file size for ZIP if provided
    if (isZip && file.size && file.size > MAX_ZIP_SIZE_BYTES) {
      setError(`ZIP file is too large (${formatFileSize(file.size)}). Maximum: ${formatFileSize(MAX_ZIP_SIZE_BYTES)}`);
      toast({
        title: "File too large",
        description: `Maximum ZIP size is ${formatFileSize(MAX_ZIP_SIZE_BYTES)}`,
        variant: "destructive",
      });
      setIsLoading(false);
      return;
    }

    try {
      setLoadingMessage("Downloading file from cloud...");
      setLoadingProgress(10);

      // Download file from cloud
      const { data, error: fnError } = await supabase.functions.invoke(
        "download-cloud-file",
        {
          body: {
            provider: file.provider,
            fileId: file.id,
          },
        }
      );

      if (fnError) throw fnError;
      if (data.error) throw new Error(data.error);

      setLoadingProgress(50);

      if (isZip) {
        // Decode base64 to binary for ZIP
        const binaryString = atob(data.content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        const { content, txtFilename } = await extractTxtFromZip(bytes.buffer, file.name);
        await parseFile(content, txtFilename);
      } else {
        // Decode base64 content for txt/xml
        const content = atob(data.content);
        await parseFile(content, file.name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to download file";
      setError(message);
      toast({
        title: "Download Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setLoadingMessage("");
      setLoadingProgress(0);
    }
  };

  const handleConfirmImport = async () => {
    if (!previewData) return;

    setStep("importing");
    setIsLoading(true);

    try {
      const { data, error: fnError } = await supabase.functions.invoke(
        "parse-chat-backup",
        {
          body: {
            content: previewData.content,
            filename: previewData.filename,
            userIdentifier,
            saveToDatabase: true,
          },
        }
      );

      if (fnError) throw fnError;
      if (data.error) throw new Error(data.error);

      toast({
        title: "Import Complete",
        description: `Imported ${previewData.conversations.length} conversation(s)`,
      });

      onImportComplete();
      handleClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to import";
      setError(message);
      toast({
        title: "Import Error",
        description: message,
        variant: "destructive",
      });
      setStep("preview");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            Import Chat Messages
          </DialogTitle>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-6">
            {/* Source Selection */}
            <Tabs value={source} onValueChange={(v) => setSource(v as "local" | "cloud")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="local" className="gap-2">
                  <Upload className="w-4 h-4" />
                  Local File
                </TabsTrigger>
                <TabsTrigger value="cloud" className="gap-2">
                  <Cloud className="w-4 h-4" />
                  Cloud Storage
                </TabsTrigger>
              </TabsList>

              <TabsContent value="local" className="space-y-4 mt-4">
                <div className="border-2 border-dashed rounded-lg p-8 text-center">
                  <Input
                    type="file"
                    accept=".txt,.xml,.zip"
                    onChange={handleLocalUpload}
                    className="hidden"
                    id="file-upload"
                    disabled={isLoading}
                  />
                  <label
                    htmlFor="file-upload"
                    className="cursor-pointer flex flex-col items-center"
                  >
                    <div className="flex gap-2 mb-3">
                      <Upload className="w-8 h-8 text-muted-foreground" />
                      <Archive className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <span className="font-medium">Click to upload</span>
                    <span className="text-sm text-muted-foreground mt-1">
                      WhatsApp export (.txt or .zip) or SMS Backup (.xml)
                    </span>
                    <span className="text-xs text-muted-foreground mt-1">
                      Max ZIP size: 2.5 GB
                    </span>
                  </label>
                </div>
              </TabsContent>

              <TabsContent value="cloud" className="space-y-4 mt-4">
                {cloudProviders.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Cloud className="w-10 h-10 mx-auto mb-3 opacity-50" />
                    <p>No cloud storage connected</p>
                    <p className="text-sm">Connect Google Drive or OneDrive in Settings</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      {cloudProviders.map((acc) => (
                        <Button
                          key={acc.id}
                          variant={selectedProvider === acc.provider ? "default" : "outline"}
                          size="sm"
                          onClick={() => setSelectedProvider(acc.provider as "google_drive" | "onedrive")}
                        >
                          {acc.provider === "google_drive" ? "Google Drive" : "OneDrive"}
                        </Button>
                      ))}
                    </div>

                    {selectedProvider && (
                      <div className="border rounded-lg overflow-hidden">
                        <FileBrowser
                          provider={selectedProvider}
                          allowFileSelection={true}
                          selectionMode={true}
                          onFolderSelect={(file) => {
                            if (file.type !== "file") return;

                            const name = file.name.toLowerCase();
                            const isSupported = name.endsWith(".txt") || name.endsWith(".xml") || name.endsWith(".zip");

                            if (!isSupported) {
                              toast({
                                title: "Unsupported file",
                                description: "Please select a .txt, .zip (WhatsApp) or .xml (SMS Backup) file.",
                                variant: "destructive",
                              });
                              return;
                            }

                            handleCloudFileSelect({
                              id: file.id,
                              name: file.name,
                              provider: selectedProvider,
                              size: file.size,
                            });
                          }}
                          compact
                        />
                        <p className="px-3 pb-3 text-xs text-muted-foreground">
                          Supports .txt, .zip (WhatsApp) and .xml (SMS Backup). Max ZIP: 2.5 GB
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>
            </Tabs>

            {/* User Identifier */}
            <div className="space-y-2">
              <Label htmlFor="user-id">Your Name/Number (optional)</Label>
              <Input
                id="user-id"
                placeholder="e.g., John or +1234567890"
                value={userIdentifier}
                onChange={(e) => setUserIdentifier(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Used to identify which messages are from you
              </p>
            </div>

            {/* Error Display */}
            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="w-4 h-4" />
                {error}
              </div>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="space-y-2">
                <div className="flex items-center justify-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {loadingMessage || "Processing file..."}
                </div>
                {loadingProgress > 0 && (
                  <Progress value={loadingProgress} className="h-2" />
                )}
              </div>
            )}
          </div>
        )}

        {step === "preview" && previewData && (
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className={
                  previewData.format === "whatsapp"
                    ? "bg-green-500/20 text-green-600"
                    : "bg-blue-500/20 text-blue-600"
                }
              >
                {previewData.format === "whatsapp" ? (
                  <>
                    <MessageSquare className="w-3 h-3 mr-1" />
                    WhatsApp
                  </>
                ) : (
                  <>
                    <Phone className="w-3 h-3 mr-1" />
                    SMS Backup
                  </>
                )}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {previewData.filename}
              </span>
            </div>

            <ScrollArea className="flex-1 border rounded-lg">
              <div className="p-3 space-y-2">
                {previewData.conversations.map((conv, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg"
                  >
                    <div
                      className={
                        previewData.format === "whatsapp"
                          ? "w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center"
                          : "w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center"
                      }
                    >
                      {previewData.format === "whatsapp" ? (
                        <MessageSquare className="w-5 h-5 text-green-600" />
                      ) : (
                        <Phone className="w-5 h-5 text-blue-600" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium">{conv.name}</div>
                      {conv.phoneNumber && (
                        <div className="text-xs text-muted-foreground">
                          {conv.phoneNumber}
                        </div>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-medium">{conv.messageCount} messages</div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("select")}>
                Back
              </Button>
              <Button onClick={handleConfirmImport} disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4 mr-2" />
                    Import {previewData.conversations.length} Conversation(s)
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {step === "importing" && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-12 h-12 animate-spin text-primary mb-4" />
            <p className="text-lg font-medium">Importing messages...</p>
            <p className="text-sm text-muted-foreground">
              This may take a moment for large conversations
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
