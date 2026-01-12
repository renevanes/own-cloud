import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  Copy, 
  Check, 
  Download, 
  Clock, 
  FileAudio,
  User,
  MessageSquare
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { StoredTranscription, TranscriptionSegment } from '@/lib/transcription-storage';

interface TranscriptionPreviewProps {
  transcription: StoredTranscription;
  fileName: string;
}

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatTimestamp = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const getProviderLabel = (provider: string): string => {
  switch (provider) {
    case 'onedrive': return 'OneDrive';
    case 'google_drive': return 'Google Drive';
    case 'recording': return 'Recording';
    default: return 'Local';
  }
};

export const TranscriptionPreview: React.FC<TranscriptionPreviewProps> = ({ 
  transcription, 
  fileName 
}) => {
  const [copied, setCopied] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(transcription.transcription);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadText = () => {
    const blob = new Blob([transcription.transcription], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transcription.fileName.replace(/\.[^/.]+$/, '')}_transcription.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Downloaded as text");
  };

  const handleDownloadSRT = () => {
    if (!transcription.segments || transcription.segments.length === 0) {
      toast.error("No segments available for SRT export");
      return;
    }

    const formatSRTTimestamp = (seconds: number): string => {
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };

    const srtContent = transcription.segments
      .map((segment, index) => {
        return `${index + 1}\n${formatSRTTimestamp(segment.start)} --> ${formatSRTTimestamp(segment.end)}\n${segment.text.trim()}\n`;
      })
      .join('\n');

    const blob = new Blob([srtContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transcription.fileName.replace(/\.[^/.]+$/, '')}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Downloaded as SRT subtitles");
  };

  const handleDownloadJSON = () => {
    const blob = new Blob([JSON.stringify(transcription, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transcription.fileName.replace(/\.[^/.]+$/, '')}_transcription.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Downloaded as JSON");
  };

  const hasSegments = transcription.segments && transcription.segments.length > 0;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header info */}
      <div className="p-4 border-b bg-muted/30">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <FileAudio className="w-5 h-5 text-orange-500 shrink-0" />
              <h3 className="font-medium truncate">{transcription.fileName}</h3>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {new Date(transcription.createdAt).toLocaleString()}
              </span>
              {transcription.duration && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3.5 h-3.5" />
                  {formatDuration(transcription.duration)} duration
                </span>
              )}
              <Badge variant="outline" className="capitalize text-xs">
                {getProviderLabel(transcription.sourceProvider)}
              </Badge>
              {hasSegments && (
                <Badge variant="secondary" className="text-xs">
                  {transcription.segments.length} segments
                </Badge>
              )}
            </div>
          </div>
          
          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              {copied ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              <span className="ml-1.5 hidden sm:inline">Copy</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Transcription content */}
      <ScrollArea className="flex-1 min-h-0">
        {hasSegments ? (
          <div className="p-4 space-y-2">
            {transcription.segments.map((segment) => (
              <div 
                key={segment.id}
                className={cn(
                  "flex gap-3 p-3 rounded-lg transition-colors group",
                  activeSegmentId === segment.id 
                    ? "bg-primary/10" 
                    : "hover:bg-muted/50"
                )}
                onMouseEnter={() => setActiveSegmentId(segment.id)}
                onMouseLeave={() => setActiveSegmentId(null)}
              >
                <div className="shrink-0 text-xs font-mono w-20">
                  <span className="text-primary font-medium">
                    {formatTimestamp(segment.start)}
                  </span>
                  <span className="text-muted-foreground/60 mx-1">→</span>
                  <span className="text-muted-foreground/60">
                    {formatTimestamp(segment.end)}
                  </span>
                </div>
                <p className="text-sm leading-relaxed flex-1">{segment.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-6">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {transcription.transcription}
            </p>
          </div>
        )}
      </ScrollArea>

      {/* Export options */}
      <Separator />
      <div className="p-3 flex flex-wrap gap-2 justify-end bg-muted/20">
        <Button variant="outline" size="sm" onClick={handleDownloadText}>
          <Download className="w-4 h-4 mr-1.5" />
          Text
        </Button>
        {hasSegments && (
          <Button variant="outline" size="sm" onClick={handleDownloadSRT}>
            <Download className="w-4 h-4 mr-1.5" />
            SRT
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={handleDownloadJSON}>
          <Download className="w-4 h-4 mr-1.5" />
          JSON
        </Button>
      </div>
    </div>
  );
};
