import React, { useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Download, ExternalLink, FileText, FileImage, FileVideo, FileAudio, FileSpreadsheet, Presentation, X, Sparkles } from 'lucide-react';
import { TranscriptionPreview } from './TranscriptionPreview';
import type { StoredTranscription } from '@/lib/transcription-storage';
import { AIChatPanel } from '@/components/ai/AIChatPanel';

interface FilePreviewProps {
  open: boolean;
  onClose: () => void;
  file: {
    id: string;
    name: string;
    type: string;
    mimeType?: string;
    provider: string;
    accountId?: string;
    /** For local_storage: folder context ("/" or "/Folder") */
    path?: string;
  } | null;
}

type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'text' | 'google-doc' | 'google-sheet' | 'google-slides' | 'google-form' | 'unknown';

const getFileCategory = (mimeType?: string, fileName?: string): FileCategory => {
  if (!mimeType) return 'unknown';
  
  // Google Workspace formats
  if (mimeType === 'application/vnd.google-apps.document') return 'google-doc';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'google-sheet';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'google-slides';
  if (mimeType === 'application/vnd.google-apps.form') return 'google-form';
  
  // Images
  if (mimeType.startsWith('image/')) return 'image';
  
  // Video
  if (mimeType.startsWith('video/')) return 'video';
  
  // Audio
  if (mimeType.startsWith('audio/')) return 'audio';
  
  // PDF
  if (mimeType === 'application/pdf') return 'pdf';
  
  // Microsoft Word
  if (mimeType === 'application/msword' || 
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'document';
  }
  
  // Microsoft Excel
  if (mimeType === 'application/vnd.ms-excel' || 
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return 'spreadsheet';
  }
  
  // Microsoft PowerPoint
  if (mimeType === 'application/vnd.ms-powerpoint' || 
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return 'presentation';
  }
  
  // Text/Code files
  if (mimeType.startsWith('text/') || 
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/javascript') {
    return 'text';
  }
  
  return 'unknown';
};

const getCategoryIcon = (category: FileCategory) => {
  switch (category) {
    case 'image': return FileImage;
    case 'video': return FileVideo;
    case 'audio': return FileAudio;
    case 'spreadsheet':
    case 'google-sheet': return FileSpreadsheet;
    case 'presentation':
    case 'google-slides': return Presentation;
    default: return FileText;
  }
};

export const FilePreview: React.FC<FilePreviewProps> = ({ open, onClose, file }) => {
  const [loading, setLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    url?: string;
    thumbnailUrl?: string;
    name?: string;
    mimeType?: string;
    size?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [transcriptionData, setTranscriptionData] = useState<StoredTranscription | null>(null);
  const [aiChatOpen, setAiChatOpen] = useState(false);

  const fileCategory = useMemo(() => {
    return getFileCategory(previewData?.mimeType || file?.mimeType, file?.name);
  }, [file?.mimeType, file?.name, previewData?.mimeType]);

  // Check if this is a transcription JSON file (in Transcriptions folder)
  const isTranscriptionFile = useMemo(() => {
    if (!file) return false;
    const isJson = file.name.endsWith('.json') || file.mimeType === 'application/json';
    const inTranscriptionsFolder = file.path?.includes('Transcriptions') || file.id?.includes('Transcriptions');
    return isJson && inTranscriptionsFolder;
  }, [file]);

  const FileIcon = getCategoryIcon(fileCategory);

  React.useEffect(() => {
    if (open && file && file.type === 'file') {
      loadPreview();
    } else {
      setPreviewData(null);
      setError(null);
      setTextContent(null);
      setTranscriptionData(null);
      setAiChatOpen(false);
    }
  }, [open, file]);

  const loadPreview = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setTextContent(null);

    try {
      let preview: typeof previewData = null;

      // Handle local storage files directly - no need to call edge function
      if (file.provider === 'local_storage') {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        // WindowsExplorer uses a UUID for file.id; the actual storage path is userId/(folderId)/fileName.
        const folderId = file.path && file.path !== '/' ? file.path.replace(/^\//, '') : null;
        const idAsPath = file.id.includes('/') ? file.id.replace(/^\//, '') : null;
        const objectPath = idAsPath ?? `${user.id}${folderId ? `/${folderId}` : ''}/${file.name}`;

        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from('user-files')
          .createSignedUrl(objectPath, 3600); // 1 hour expiry

        if (signedUrlError) throw signedUrlError;

        if (signedUrlData?.signedUrl) {
          preview = {
            url: signedUrlData.signedUrl,
            name: file.name,
            mimeType: file.mimeType,
          };
        } else {
          throw new Error('Failed to get file URL');
        }
      } else {
        // Cloud providers - use edge function
        const { data, error: funcError } = await supabase.functions.invoke('file-preview', {
          body: { provider: file.provider, fileId: file.id, accountId: file.accountId },
        });

        if (funcError) throw funcError;
        preview = data;
      }

      setPreviewData(preview);

      // For transcription JSON files, parse and set transcription data
      const isTranscription = file.name.endsWith('.json') && 
        (file.path?.includes('Transcriptions') || file.id?.includes('Transcriptions'));
      
      if (isTranscription && preview?.url) {
        try {
          const jsonResponse = await fetch(preview.url);
          if (jsonResponse.ok) {
            const json = await jsonResponse.json();
            // Check if it has the transcription structure
            if (json.transcription && json.fileName) {
              setTranscriptionData(json as StoredTranscription);
            }
          }
        } catch {
          // Fall back to regular text display
        }
      }

      // For text files, try to fetch content
      const category = getFileCategory(preview?.mimeType || file.mimeType, file.name);
      if (category === 'text' && preview?.url && !isTranscription) {
        try {
          const textResponse = await fetch(preview.url);
          if (textResponse.ok) {
            const text = await textResponse.text();
            setTextContent(text.slice(0, 50000)); // Limit to 50KB
          }
        } catch {
          // Ignore text fetch errors, will show download option
        }
      }
    } catch (err) {
      console.error('Error loading preview:', err);
      setError(err instanceof Error ? err.message : 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const handleDownload = () => {
    if (previewData?.url) {
      window.open(previewData.url, '_blank');
    }
  };

  // Build Google Docs Viewer URL for Office documents
  const getOfficeViewerUrl = (url: string) => {
    return `https://docs.google.com/gview?url=${encodeURIComponent(url)}&embedded=true`;
  };

  // Build Google Drive embed URL for Google Workspace files
  const getGoogleWorkspaceViewUrl = (fileId: string, category: FileCategory) => {
    switch (category) {
      case 'google-doc':
        return `https://docs.google.com/document/d/${fileId}/preview`;
      case 'google-sheet':
        return `https://docs.google.com/spreadsheets/d/${fileId}/preview`;
      case 'google-slides':
        return `https://docs.google.com/presentation/d/${fileId}/embed`;
      case 'google-form':
        return `https://docs.google.com/forms/d/${fileId}/viewform?embedded=true`;
      default:
        return null;
    }
  };

  const renderPreviewContent = () => {
    if (loading) {
      return (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p>Loading preview...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <X className="w-8 h-8" />
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={loadPreview}>
            Retry
          </Button>
        </div>
      );
    }

    // Transcription JSON files - use dedicated viewer
    if (transcriptionData && file) {
      return (
        <TranscriptionPreview 
          transcription={transcriptionData} 
          fileName={file.name} 
        />
      );
    }

    // Google Workspace files - open in new tab (cannot be embedded due to X-Frame-Options)
    if (['google-doc', 'google-sheet', 'google-slides', 'google-form'].includes(fileCategory) && file) {
      const viewUrl = getGoogleWorkspaceViewUrl(file.id, fileCategory);
      const getCategoryLabel = () => {
        switch (fileCategory) {
          case 'google-doc': return 'Google Docs';
          case 'google-sheet': return 'Google Sheets';
          case 'google-slides': return 'Google Slides';
          case 'google-form': return 'Google Forms';
          default: return 'Google Drive';
        }
      };
      return (
        <div className="flex flex-col items-center gap-6 p-8 text-center">
          <FileIcon className="w-24 h-24 text-muted-foreground" />
          <div>
            <p className="text-lg font-medium">{file?.name}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {getCategoryLabel()} files open in a new tab
            </p>
          </div>
          {viewUrl && (
            <Button variant="gradient" size="lg" asChild>
              <a href={viewUrl.replace('/preview', '/edit').replace('/embed', '/edit')} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" />
                Open in {getCategoryLabel()}
              </a>
            </Button>
          )}
        </div>
      );
    }

    // Images
    if (fileCategory === 'image' && (previewData?.url || previewData?.thumbnailUrl)) {
      return (
        <img
          src={previewData.url || previewData.thumbnailUrl}
          alt={file?.name}
          className="max-w-full max-h-[70vh] object-contain"
          onError={() => setError('Failed to load image')}
        />
      );
    }

    // Video
    if (fileCategory === 'video' && previewData?.url) {
      return (
        <video
          src={previewData.url}
          controls
          className="max-w-full max-h-[70vh]"
          onError={() => setError('Failed to load video')}
        />
      );
    }

    // Audio
    if (fileCategory === 'audio' && previewData?.url) {
      return (
        <div className="flex flex-col items-center gap-6 p-8">
          <FileAudio className="w-24 h-24 text-muted-foreground" />
          <p className="text-lg font-medium">{file?.name}</p>
          <audio
            src={previewData.url}
            controls
            className="w-full max-w-md"
            onError={() => setError('Failed to load audio')}
          />
        </div>
      );
    }

    // PDF
    if (fileCategory === 'pdf' && previewData?.url) {
      return (
        <iframe
          src={previewData.url}
          className="w-full h-[70vh] border-0 rounded"
          title={file?.name}
        />
      );
    }

    // Office documents (Word, Excel, PowerPoint) - use Google Docs Viewer
    if (['document', 'spreadsheet', 'presentation'].includes(fileCategory) && previewData?.url) {
      return (
        <iframe
          src={getOfficeViewerUrl(previewData.url)}
          className="w-full h-[70vh] border-0 rounded"
          title={file?.name}
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      );
    }

    // Text/Code files
    if (fileCategory === 'text' && textContent) {
      return (
        <div className="w-full h-[70vh] overflow-auto">
          <pre className="p-4 text-sm font-mono whitespace-pre-wrap break-words bg-background rounded border">
            {textContent}
          </pre>
        </div>
      );
    }

    // Fallback: show thumbnail if available
    if (previewData?.thumbnailUrl) {
      return (
        <img
          src={previewData.thumbnailUrl}
          alt={file?.name}
          className="max-w-full max-h-[60vh] object-contain"
        />
      );
    }

    // Unknown file type - show download option
    return (
      <div className="flex flex-col items-center gap-4 text-muted-foreground p-8">
        <FileIcon className="w-16 h-16" />
        <p className="text-lg font-medium">{file?.name}</p>
        <p className="text-sm">Preview not available for this file type</p>
        <p className="text-xs text-muted-foreground/70">{previewData?.mimeType || file?.mimeType}</p>
        {previewData?.url && (
          <Button variant="gradient" onClick={handleDownload}>
            <Download className="w-4 h-4 mr-2" />
            Download File
          </Button>
        )}
      </div>
    );
  };

  // For transcription files, use a simpler dialog layout
  if (transcriptionData) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Transcription: {file?.name}</DialogTitle>
            <DialogDescription>
              Transcription viewer for {file?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {renderPreviewContent()}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex flex-row items-center justify-between">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 truncate">
              <FileIcon className="w-5 h-5 flex-shrink-0" />
              <span className="truncate">{file?.name}</span>
              {previewData?.size && (
                <span className="text-sm text-muted-foreground font-normal flex-shrink-0">
                  ({formatSize(previewData.size)})
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              File preview dialog for {file?.name}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* AI Chat button for supported file types */}
            {(textContent || transcriptionData) && (
              <Button variant="outline" size="sm" onClick={() => setAiChatOpen(true)}>
                <Sparkles className="w-4 h-4 mr-2" />
                Ask AI
              </Button>
            )}
            {previewData?.url && !transcriptionData && (
              <>
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={previewData.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Open
                  </a>
                </Button>
              </>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-[300px] flex items-center justify-center bg-muted/30 rounded-lg">
          {renderPreviewContent()}
        </div>

        {/* AI Chat Panel */}
        <AIChatPanel
          open={aiChatOpen}
          onClose={() => setAiChatOpen(false)}
          fileContext={textContent || transcriptionData ? {
            content: transcriptionData?.transcription || textContent || '',
            fileName: file?.name || 'Unknown',
            fileType: transcriptionData ? 'transcription' : fileCategory,
            metadata: transcriptionData ? {
              duration: transcriptionData.duration,
              callerName: transcriptionData.callerName,
              tags: transcriptionData.tags,
            } : undefined
          } : undefined}
          suggestedPrompts={
            transcriptionData
              ? ["Summarize this call", "What are the key points?", "Extract action items"]
              : ["Summarize this document", "What is this about?", "Explain the main points"]
          }
          title={`Ask AI About ${file?.name || 'File'}`}
        />
      </DialogContent>
    </Dialog>
  );
};
