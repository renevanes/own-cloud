import React, { useRef } from "react";
import { Paperclip, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UploadedFile {
  name: string;
  type: string;
  content: string;
}

interface FileUploadButtonProps {
  uploadedFile: UploadedFile | null;
  onFileSelect: (file: UploadedFile | null) => void;
  disabled?: boolean;
}

export const FileUploadButton: React.FC<FileUploadButtonProps> = ({
  uploadedFile,
  onFileSelect,
  disabled,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Read file content
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      onFileSelect({
        name: file.name,
        type: file.type || getFileType(file.name),
        content: content,
      });
    };

    // Read as text for text-based files
    if (isTextFile(file.name, file.type)) {
      reader.readAsText(file);
    } else {
      // For binary files, read as data URL
      reader.readAsDataURL(file);
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isTextFile = (fileName: string, mimeType: string): boolean => {
    const textExtensions = [
      ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx",
      ".html", ".css", ".csv", ".xml", ".yaml", ".yml",
      ".py", ".java", ".c", ".cpp", ".h", ".rb", ".go",
      ".rs", ".swift", ".kt", ".sql", ".sh", ".bash",
      ".log", ".env", ".conf", ".cfg", ".ini",
    ];
    const textMimeTypes = [
      "text/", "application/json", "application/javascript",
      "application/xml", "application/x-yaml",
    ];
    
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
    if (textExtensions.includes(ext)) return true;
    
    return textMimeTypes.some(type => mimeType.startsWith(type));
  };

  const getFileType = (fileName: string): string => {
    const ext = fileName.toLowerCase().slice(fileName.lastIndexOf(".") + 1);
    const typeMap: Record<string, string> = {
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      js: "application/javascript",
      ts: "application/typescript",
      tsx: "application/typescript",
      jsx: "application/javascript",
      html: "text/html",
      css: "text/css",
      csv: "text/csv",
      xml: "application/xml",
      yaml: "application/x-yaml",
      yml: "application/x-yaml",
      py: "text/x-python",
      java: "text/x-java-source",
      sql: "application/sql",
    };
    return typeMap[ext] || "application/octet-stream";
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
        accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.html,.css,.csv,.xml,.yaml,.yml,.py,.java,.c,.cpp,.h,.rb,.go,.rs,.swift,.kt,.sql,.sh,.bash,.log,.env,.conf,.cfg,.ini"
      />
      
      {uploadedFile ? (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 text-sm">
          <FileText className="w-4 h-4 text-primary" />
          <span className="truncate max-w-32">{uploadedFile.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={() => onFileSelect(null)}
            disabled={disabled}
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className={cn("shrink-0")}
        >
          <Paperclip className="w-4 h-4" />
        </Button>
      )}
    </>
  );
};
