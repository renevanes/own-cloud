import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, XCircle, FileText, Clock, X } from "lucide-react";
import { toast } from "sonner";

interface SyncJob {
  id: string;
  status: string;
  files_synced: number | null;
  files_total: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

interface SyncLog {
  id: string;
  status: string;
  source_file_name: string | null;
  created_at: string;
}

// Jobs running longer than 10 minutes are considered stale
const STALE_JOB_THRESHOLD_MS = 10 * 60 * 1000;

export const SyncProgress: React.FC = () => {
  const { user } = useAuth();
  const [activeJob, setActiveJob] = useState<SyncJob | null>(null);
  const [recentLogs, setRecentLogs] = useState<SyncLog[]>([]);
  const [isStale, setIsStale] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  // Check if job is stale
  useEffect(() => {
    if (!activeJob || activeJob.status !== "running") {
      setIsStale(false);
      return;
    }

    const checkStale = () => {
      if (activeJob.started_at) {
        const startTime = new Date(activeJob.started_at).getTime();
        const elapsed = Date.now() - startTime;
        setIsStale(elapsed > STALE_JOB_THRESHOLD_MS);
      }
    };

    checkStale();
    const interval = setInterval(checkStale, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [activeJob]);

  useEffect(() => {
    if (!user) return;

    // Fetch active job on mount
    const fetchActiveJob = async () => {
      const { data } = await supabase
        .from("sync_jobs")
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

    // Subscribe to sync_jobs changes
    const jobChannel = supabase
      .channel("sync-jobs-progress")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sync_jobs",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          console.log("Sync job update:", payload);
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const job = payload.new as SyncJob;
            if (job.status === "running") {
              setActiveJob(job);
            } else if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
              setActiveJob(job);
              // Clear after a delay
              setTimeout(() => setActiveJob(null), 5000);
            }
          }
        }
      )
      .subscribe();

    // Subscribe to sync_logs for live file progress
    const logChannel = supabase
      .channel("sync-logs-progress")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sync_logs",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          console.log("Sync log:", payload);
          const log = payload.new as SyncLog;
          setRecentLogs((prev) => [log, ...prev.slice(0, 4)]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(jobChannel);
      supabase.removeChannel(logChannel);
    };
  }, [user]);

  const handleDismissStaleJob = async () => {
    if (!activeJob) return;
    
    setDismissing(true);
    try {
      const { error } = await supabase
        .from("sync_jobs")
        .update({ 
          status: "failed", 
          error_message: "Job timed out - dismissed by user",
          completed_at: new Date().toISOString()
        })
        .eq("id", activeJob.id);
      
      if (error) throw error;
      
      toast.success("Stale job dismissed");
      setActiveJob(null);
    } catch (err) {
      console.error("Failed to dismiss job:", err);
      toast.error("Failed to dismiss job");
    } finally {
      setDismissing(false);
    }
  };

  if (!activeJob) return null;

  const progress = activeJob.files_total 
    ? Math.round((activeJob.files_synced || 0) / activeJob.files_total * 100) 
    : 0;

  const isRunning = activeJob.status === "running";
  const isCompleted = activeJob.status === "completed";
  const isFailed = activeJob.status === "failed";

  // Calculate elapsed time
  const getElapsedTime = () => {
    if (!activeJob.started_at) return null;
    const elapsed = Date.now() - new Date(activeJob.started_at).getTime();
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <Card className={`glass border-primary/20 animate-in slide-in-from-top-2 duration-300 ${isStale ? 'border-orange-500/50' : ''}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-3">
          {isRunning && !isStale && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
          {isRunning && isStale && <Clock className="w-5 h-5 text-orange-500" />}
          {isCompleted && <CheckCircle2 className="w-5 h-5 text-green-500" />}
          {isFailed && <XCircle className="w-5 h-5 text-destructive" />}
          
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">
                {isRunning && !isStale && "Syncing files..."}
                {isRunning && isStale && "Job appears stale"}
                {isCompleted && "Sync completed!"}
                {isFailed && "Sync failed"}
              </span>
              <div className="flex items-center gap-2">
                {isRunning && (
                  <span className="text-xs text-muted-foreground">
                    {getElapsedTime()}
                  </span>
                )}
                <Badge variant={isCompleted ? "default" : isFailed ? "destructive" : isStale ? "outline" : "secondary"}>
                  {activeJob.files_synced || 0} / {activeJob.files_total || 0}
                </Badge>
              </div>
            </div>
          </div>

          {isStale && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleDismissStaleJob}
              disabled={dismissing}
              className="h-7 px-2"
            >
              {dismissing ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
            </Button>
          )}
        </div>

        <Progress value={progress} className={`h-2 mb-3 ${isStale ? '[&>div]:bg-orange-500' : ''}`} />

        {isStale && (
          <p className="text-xs text-orange-500 mb-2">
            This job has been running for over 10 minutes without completing. It may have timed out.
          </p>
        )}

        {recentLogs.length > 0 && isRunning && !isStale && (
          <div className="space-y-1 max-h-24 overflow-hidden">
            {recentLogs.slice(0, 3).map((log) => (
              <div key={log.id} className="flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-200">
                <FileText className="w-3 h-3" />
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