import React, { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, CheckCircle2, XCircle, Clock, FileText, Loader2 } from 'lucide-react';
import { OneDriveIcon, GoogleDriveIcon } from '@/components/icons/CloudIcons';

interface SyncLog {
  id: string;
  status: string;
  action: string;
  source_file_name: string | null;
  target_file_name: string | null;
  file_size: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  sync_folders?: {
    source_provider: string;
    target_provider: string;
  };
}

export const SyncLogs: React.FC = () => {
  const { user } = useAuth();
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLogs = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sync_logs')
        .select(`
          *,
          sync_folders (
            source_provider,
            target_provider
          )
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      setLogs(data || []);
    } catch (error) {
      console.error('Error fetching sync logs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [user]);

  const formatSize = (bytes: number | null) => {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-destructive" />;
      case 'started':
        return <Clock className="w-4 h-4 text-yellow-500" />;
      default:
        return <FileText className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getProviderIcon = (provider: string | undefined) => {
    if (provider === 'onedrive') return <OneDriveIcon className="w-4 h-4" />;
    if (provider === 'google_drive') return <GoogleDriveIcon className="w-4 h-4" />;
    return null;
  };

  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Sync Logs
          </CardTitle>
          <CardDescription>
            Recent file synchronization activity
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No sync activity yet. Start a sync to see logs here.
          </div>
        ) : (
          <ScrollArea className="h-[300px]">
            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  {getStatusIcon(log.status)}
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {getProviderIcon(log.sync_folders?.source_provider)}
                      <span className="text-sm font-medium truncate">
                        {log.source_file_name || 'Unknown file'}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      {getProviderIcon(log.sync_folders?.target_provider)}
                    </div>
                    {log.error_message && (
                      <p className="text-xs text-destructive mt-1 truncate" title={log.error_message}>
                        {log.error_message}
                      </p>
                    )}
                  </div>

                  <div className="text-right shrink-0">
                    <Badge
                      variant={log.status === 'completed' ? 'default' : log.status === 'failed' ? 'destructive' : 'secondary'}
                      className="text-xs"
                    >
                      {log.status}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatTime(log.created_at)}
                    </p>
                  </div>

                  {log.file_size && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatSize(log.file_size)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
};
