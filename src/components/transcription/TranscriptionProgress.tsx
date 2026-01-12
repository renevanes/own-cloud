import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, XCircle, Clock, X, Mic } from "lucide-react";
import { toast } from "sonner";

interface TranscriptionJob {
  id: string;
  status: string;
  files_processed: number | null;
  files_total: number | null;
  files_skipped: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

interface TranscriptionLog {
  id: string;
  status: string;
  source_file_name: string | null;
  created_at: string;
}

const RESUME_INTERVAL_MS = 3000; // Poll every 3 seconds to resume processing

export const TranscriptionProgress: React.FC = () => {
  const { user } = useAuth();
  const [activeJob, setActiveJob] = useState<TranscriptionJob | null>(null);
  const [recentLogs, setRecentLogs] = useState<TranscriptionLog[]>([]);
  const [isResuming, setIsResuming] = useState(false);
  const resumeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastResumeRef = useRef<number>(0);

  // Resume the job by calling the edge function
  const resumeJob = useCallback(async () => {
    if (!user || !activeJob || activeJob.status !== "running" || isResuming) return;
    
    // Prevent rapid-fire resume calls
    const now = Date.now();
    if (now - lastResumeRef.current < 2000) return;
    lastResumeRef.current = now;
    
    setIsResuming(true);
    try {
      console.log("Resuming transcription job:", activeJob.id);
      const { data, error } = await supabase.functions.invoke("transcribe-batch", {
        body: { action: "resume", userId: user.id, jobId: activeJob.id },
      });

      if (error) {
        console.error("Resume error:", error);
        return;
      }

      console.log("Resume result:", data);

      // If job is complete or no more files, stop polling
      if (data.status === "completed" || data.remaining === 0) {
        console.log("Job completed, stopping resume loop");
        if (resumeIntervalRef.current) {
          clearInterval(resumeIntervalRef.current);
          resumeIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.error("Failed to resume job:", err);
    } finally {
      setIsResuming(false);
    }
  }, [user, activeJob, isResuming]);

  // Set up resume polling when there's an active running job
  useEffect(() => {
    if (activeJob?.status === "running") {
      // Clear any existing interval
      if (resumeIntervalRef.current) {
        clearInterval(resumeIntervalRef.current);
      }

      // Start polling to resume the job
      resumeIntervalRef.current = setInterval(() => {
        resumeJob();
      }, RESUME_INTERVAL_MS);

      // Initial resume call
      resumeJob();
    } else {
      // Clear interval when job is not running
      if (resumeIntervalRef.current) {
        clearInterval(resumeIntervalRef.current);
        resumeIntervalRef.current = null;
      }
    }

    return () => {
      if (resumeIntervalRef.current) {
        clearInterval(resumeIntervalRef.current);
        resumeIntervalRef.current = null;
      }
    };
  }, [activeJob?.id, activeJob?.status, resumeJob]);

  useEffect(() => {
    if (!user) return;

    const fetchActiveJob = async () => {
      const { data } = await supabase
        .from("transcription_jobs")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "running")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (data) {
        setActiveJob(data);
      }
    };

    fetchActiveJob();

    const jobChannel = supabase
      .channel("transcription-jobs-progress")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "transcription_jobs",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          console.log("Transcription job update:", payload);
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const job = payload.new as TranscriptionJob;
            if (job.status === "running") {
              setActiveJob(job);
            } else if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
              setActiveJob(job);
              setTimeout(() => setActiveJob(null), 5000);
            }
          }
        }
      )
      .subscribe();

    const logChannel = supabase
      .channel("transcription-logs-progress")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "transcription_logs",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          console.log("Transcription log:", payload);
          const log = payload.new as TranscriptionLog;
          setRecentLogs((prev) => [log, ...prev.slice(0, 4)]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(jobChannel);
      supabase.removeChannel(logChannel);
    };
  }, [user]);

  const handleStopJob = async () => {
    if (!activeJob || !user) return;
    
    // Stop the resume loop
    if (resumeIntervalRef.current) {
      clearInterval(resumeIntervalRef.current);
      resumeIntervalRef.current = null;
    }
    
    try {
      const { error } = await supabase.functions.invoke("transcribe-batch", {
        body: { action: "stop", userId: user.id, jobId: activeJob.id },
      });

      if (error) throw error;
      toast.success("Transcription job cancelled");
    } catch (err) {
      console.error("Failed to stop job:", err);
      toast.error("Failed to stop transcription job");
    }
  };

  const handleDismiss = () => {
    if (resumeIntervalRef.current) {
      clearInterval(resumeIntervalRef.current);
      resumeIntervalRef.current = null;
    }
    setActiveJob(null);
  };

  if (!activeJob) return null;

  const progress = activeJob.files_total 
    ? Math.round(((activeJob.files_processed || 0) + (activeJob.files_skipped || 0)) / activeJob.files_total * 100) 
    : 0;

  const isRunning = activeJob.status === "running";
  const isCompleted = activeJob.status === "completed";
  const isFailed = activeJob.status === "failed";
  const isCancelled = activeJob.status === "cancelled";

  const getElapsedTime = () => {
    if (!activeJob.started_at) return null;
    const elapsed = Date.now() - new Date(activeJob.started_at).getTime();
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <Card className="glass border-primary/20 animate-in slide-in-from-top-2 duration-300">
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-3">
          {isRunning && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
          {isCompleted && <CheckCircle2 className="w-5 h-5 text-green-500" />}
          {(isFailed || isCancelled) && <XCircle className="w-5 h-5 text-destructive" />}
          
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">
                {isRunning && "Transcribing files..."}
                {isCompleted && "Transcription completed!"}
                {isFailed && "Transcription failed"}
                {isCancelled && "Transcription cancelled"}
              </span>
              <div className="flex items-center gap-2">
                {isRunning && (
                  <span className="text-xs text-muted-foreground">
                    {getElapsedTime()}
                  </span>
                )}
                <Badge variant={isCompleted ? "default" : isFailed || isCancelled ? "destructive" : "secondary"}>
                  {(activeJob.files_processed || 0) + (activeJob.files_skipped || 0)} / {activeJob.files_total || 0}
                </Badge>
                {isResuming && (
                  <span className="text-xs text-muted-foreground">processing...</span>
                )}
              </div>
            </div>
          </div>

          {isRunning && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleStopJob}
              className="h-7 px-2 text-destructive hover:text-destructive"
            >
              Stop
            </Button>
          )}

          {(isCompleted || isFailed || isCancelled) && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleDismiss}
              className="h-7 px-2"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>

        <Progress value={progress} className="h-2 mb-3" />

        {activeJob.files_skipped && activeJob.files_skipped > 0 && (
          <p className="text-xs text-muted-foreground mb-2">
            {activeJob.files_skipped} file(s) skipped due to errors
          </p>
        )}

        {recentLogs.length > 0 && isRunning && (
          <div className="space-y-1 max-h-24 overflow-hidden">
            {recentLogs.slice(0, 3).map((log) => (
              <div key={log.id} className="flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-200">
                <Mic className="w-3 h-3" />
                <span className="truncate">{log.source_file_name}</span>
                <Badge variant="outline" className="text-[10px] h-4">
                  {log.status}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {activeJob.error_message && (
          <p className="text-xs text-destructive mt-2">{activeJob.error_message}</p>
        )}
      </CardContent>
    </Card>
  );
};
