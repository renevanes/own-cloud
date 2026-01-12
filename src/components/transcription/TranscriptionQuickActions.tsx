import React, { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, Search, Play, Mic, FileAudio } from "lucide-react";

interface TranscriptionQuickActionsProps {
  onJobStarted?: () => void;
}

export const TranscriptionQuickActions: React.FC<TranscriptionQuickActionsProps> = ({ onJobStarted }) => {
  const { user } = useAuth();
  const [scanning, setScanning] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [scanResult, setScanResult] = useState<{ count: number; files: any[] } | null>(null);

  const handleScan = async () => {
    if (!user) return;
    setScanning(true);
    setScanResult(null);

    try {
      const { data, error } = await supabase.functions.invoke("transcribe-batch", {
        body: { action: "scan", userId: user.id },
      });

      if (error) throw error;

      setScanResult({ count: data.count, files: data.files });
      
      if (data.count === 0) {
        toast.info("No new audio files found");
      } else {
        toast.success(`Found ${data.count} new audio file(s) to transcribe`);
      }
    } catch (err: any) {
      console.error("Scan failed:", err);
      toast.error(err.message || "Failed to scan for audio files");
    } finally {
      setScanning(false);
    }
  };

  const handleTranscribeAll = async () => {
    if (!user) return;
    setTranscribing(true);

    try {
      const { data, error } = await supabase.functions.invoke("transcribe-batch", {
        body: { action: "scan-and-transcribe", userId: user.id },
      });

      if (error) throw error;

      if (data.message) {
        toast.info(data.message);
      } else {
        toast.success(`Transcription job started for ${data.filesProcessed + data.filesSkipped} file(s)`);
        onJobStarted?.();
      }
      
      setScanResult(null);
    } catch (err: any) {
      console.error("Transcription failed:", err);
      toast.error(err.message || "Failed to start transcription");
    } finally {
      setTranscribing(false);
    }
  };

  const handleTranscribeScanned = async () => {
    if (!user || !scanResult?.files?.length) return;
    setTranscribing(true);

    try {
      const { data, error } = await supabase.functions.invoke("transcribe-batch", {
        body: { action: "start", userId: user.id, sourceIds: scanResult.files },
      });

      if (error) throw error;

      toast.success(`Transcription job started for ${scanResult.count} file(s)`);
      onJobStarted?.();
      setScanResult(null);
    } catch (err: any) {
      console.error("Transcription failed:", err);
      toast.error(err.message || "Failed to start transcription");
    } finally {
      setTranscribing(false);
    }
  };

  return (
    <Card className="glass border-border/50">
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          <Mic className="w-5 h-5" />
          Quick Actions
        </CardTitle>
        <CardDescription>Scan for new audio files and start batch transcription</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={handleScan}
              disabled={scanning || transcribing}
              className="gap-2"
            >
              {scanning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              Scan for New Files
            </Button>

            <Button
              onClick={handleTranscribeAll}
              disabled={scanning || transcribing}
              className="gap-2"
            >
              {transcribing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Transcribe All New
            </Button>
          </div>

          {scanResult && scanResult.count > 0 && (
            <div className="p-4 rounded-lg bg-secondary/30 border border-border/30">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <FileAudio className="w-5 h-5 text-primary" />
                  <span className="font-medium">{scanResult.count} new audio file(s) found</span>
                </div>
                <Button
                  size="sm"
                  onClick={handleTranscribeScanned}
                  disabled={transcribing}
                  className="gap-2"
                >
                  {transcribing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  Transcribe These
                </Button>
              </div>
              
              <div className="max-h-32 overflow-y-auto space-y-1">
                {scanResult.files.slice(0, 10).map((file, index) => (
                  <div key={index} className="text-xs text-muted-foreground truncate flex items-center gap-2">
                    <FileAudio className="w-3 h-3 shrink-0" />
                    {file.name}
                  </div>
                ))}
                {scanResult.files.length > 10 && (
                  <div className="text-xs text-muted-foreground">
                    ...and {scanResult.files.length - 10} more
                  </div>
                )}
              </div>
            </div>
          )}

          {scanResult && scanResult.count === 0 && (
            <div className="p-4 rounded-lg bg-secondary/20 text-center text-muted-foreground text-sm">
              All audio files in configured sources have been transcribed
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
