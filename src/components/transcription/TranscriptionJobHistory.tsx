import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  Clock, 
  RefreshCw, 
  ChevronDown,
  Mic,
  AlertCircle,
  AlertTriangle,
  Square,
  Ban
} from "lucide-react";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { toast } from "sonner";
import { format } from "date-fns";

interface TranscriptionJob {
  id: string;
  status: string;
  files_processed: number | null;
  files_total: number | null;
  files_skipped: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

interface TranscriptionLog {
  id: string;
  status: string;
  source_provider: string;
  source_file_name: string | null;
  file_size: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export const TranscriptionJobHistory: React.FC = () => {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<TranscriptionJob[]>([]);
  const [selectedJobLogs, setSelectedJobLogs] = useState<Record<string, TranscriptionLog[]>>({});
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState<Set<string>>(new Set());
  const [stoppingJobId, setStoppingJobId] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      fetchJobs();
    }
  }, [user]);

  const fetchJobs = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("transcription_jobs")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      setJobs(data || []);
    } catch (err) {
      console.error("Failed to fetch transcription jobs:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchLogsForJob = async (jobId: string) => {
    if (!user) return;
    
    setLoadingLogs((prev) => new Set(prev).add(jobId));
    try {
      const { data, error } = await supabase
        .from("transcription_logs")
        .select("*")
        .eq("user_id", user.id)
        .eq("transcription_job_id", jobId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      
      setSelectedJobLogs((prev) => ({ ...prev, [jobId]: data || [] }));
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    } finally {
      setLoadingLogs((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const toggleJob = (jobId: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
        if (!selectedJobLogs[jobId]) {
          fetchLogsForJob(jobId);
        }
      }
      return next;
    });
  };

  const handleStopJob = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    
    setStoppingJobId(jobId);
    
    try {
      const { error } = await supabase.functions.invoke("transcribe-batch", {
        body: { action: "stop", userId: user.id, jobId },
      });

      if (error) throw error;

      toast.success("Transcription job cancelled");
      fetchJobs();
    } catch (err) {
      console.error("Failed to stop job:", err);
      toast.error("Failed to stop transcription job");
    } finally {
      setStoppingJobId(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "failed":
        return <XCircle className="w-4 h-4 text-destructive" />;
      case "running":
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case "cancelled":
        return <Ban className="w-4 h-4 text-orange-500" />;
      default:
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge variant="default" className="bg-green-500/20 text-green-500 border-green-500/30">Completed</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "running":
        return <Badge variant="secondary">Running</Badge>;
      case "cancelled":
        return <Badge variant="outline" className="bg-orange-500/20 text-orange-500 border-orange-500/30">Cancelled</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const ProviderIcon = ({ provider }: { provider: string }) => {
    switch (provider) {
      case "onedrive":
        return <OneDriveIcon className="w-3 h-3 text-onedrive" />;
      case "google_drive":
        return <GoogleDriveIcon className="w-3 h-3 text-google-drive" />;
      case "local":
        return <LocalStorageIcon className="w-3 h-3 text-primary" />;
      default:
        return null;
    }
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (startedAt: string | null, completedAt: string | null) => {
    if (!startedAt || !completedAt) return "-";
    const start = new Date(startedAt);
    const end = new Date(completedAt);
    const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  if (loading) {
    return (
      <Card className="glass border-border/50">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass border-border/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-xl">Transcription History</CardTitle>
          <CardDescription>View past transcription jobs and their logs</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={fetchJobs}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Mic className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No transcription jobs found</p>
          </div>
        ) : (
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {jobs.map((job) => (
                <Collapsible
                  key={job.id}
                  open={expandedJobs.has(job.id)}
                  onOpenChange={() => toggleJob(job.id)}
                >
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/30 cursor-pointer hover:bg-secondary/50 transition-colors">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {getStatusIcon(job.status)}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">
                              {job.started_at
                                ? format(new Date(job.started_at), "MMM d, yyyy h:mm a")
                                : "Pending"}
                            </span>
                            {getStatusBadge(job.status)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {job.files_processed ?? 0}/{job.files_total ?? 0} files transcribed • 
                            {job.files_skipped ? ` ${job.files_skipped} skipped • ` : " "}
                            Duration: {formatDuration(job.started_at, job.completed_at)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {job.status === "running" && (
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 gap-1"
                            onClick={(e) => handleStopJob(job.id, e)}
                            disabled={stoppingJobId === job.id}
                          >
                            {stoppingJobId === job.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Square className="w-3 h-3" />
                            )}
                            Stop
                          </Button>
                        )}
                        <ChevronDown
                          className={`w-4 h-4 text-muted-foreground transition-transform ${
                            expandedJobs.has(job.id) ? "rotate-180" : ""
                          }`}
                        />
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 ml-6 pl-4 border-l-2 border-border/50">
                      {job.error_message && (
                        <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 text-destructive text-xs mb-2">
                          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                          <span>{job.error_message}</span>
                        </div>
                      )}
                      
                      {loadingLogs.has(job.id) ? (
                        <div className="flex items-center gap-2 p-3 text-muted-foreground text-sm">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading logs...
                        </div>
                      ) : selectedJobLogs[job.id]?.length ? (
                        <div className="space-y-1 py-2">
                          {selectedJobLogs[job.id].map((log) => (
                            <div
                              key={log.id}
                              className={`flex items-center gap-2 p-2 rounded text-xs ${
                                log.status === "failed"
                                  ? "bg-destructive/10"
                                  : log.status === "skipped"
                                  ? "bg-orange-500/10"
                                  : log.status === "completed"
                                  ? "bg-green-500/5"
                                  : "bg-secondary/20"
                              }`}
                            >
                              {log.status === "completed" ? (
                                <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                              ) : log.status === "failed" ? (
                                <XCircle className="w-3 h-3 text-destructive shrink-0" />
                              ) : log.status === "skipped" ? (
                                <AlertTriangle className="w-3 h-3 text-orange-500 shrink-0" />
                              ) : (
                                <Loader2 className="w-3 h-3 text-muted-foreground animate-spin shrink-0" />
                              )}
                              <ProviderIcon provider={log.source_provider} />
                              <span className="truncate flex-1">{log.source_file_name || "Unknown file"}</span>
                              <span className="text-muted-foreground shrink-0">
                                {formatFileSize(log.file_size)}
                              </span>
                              <span className="text-muted-foreground shrink-0 text-[10px]">
                                {log.completed_at 
                                  ? format(new Date(log.completed_at), "h:mm:ss a")
                                  : format(new Date(log.created_at), "h:mm:ss a")}
                              </span>
                              {log.error_message && (
                                <span className={`truncate max-w-[200px] ${log.status === "skipped" ? "text-orange-500" : "text-destructive"}`} title={log.error_message}>
                                  {log.error_message}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-3 text-muted-foreground text-xs">
                          No file logs for this job
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
};
