import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatDistanceToNow } from 'date-fns';

export interface FileActivity {
  id: string;
  file_name: string;
  file_type: string;
  action: string;
  source: string;
  created_at: string;
}

export interface FormattedActivity {
  id: string;
  name: string;
  type: 'document' | 'image' | 'folder' | 'audio' | 'video';
  action: 'synced' | 'uploaded' | 'modified';
  time: string;
  source: 'onedrive' | 'google-drive';
}

const mapFileType = (type: string): FormattedActivity['type'] => {
  const typeMap: Record<string, FormattedActivity['type']> = {
    document: 'document',
    image: 'image',
    folder: 'folder',
    audio: 'audio',
    video: 'video',
  };
  return typeMap[type] || 'document';
};

const mapAction = (action: string): FormattedActivity['action'] => {
  const actionMap: Record<string, FormattedActivity['action']> = {
    synced: 'synced',
    uploaded: 'uploaded',
    modified: 'modified',
  };
  return actionMap[action] || 'synced';
};

const mapSource = (source: string): FormattedActivity['source'] => {
  if (source === 'onedrive') return 'onedrive';
  return 'google-drive';
};

export const useFileActivity = (limit = 5) => {
  const { user } = useAuth();
  const [activities, setActivities] = useState<FormattedActivity[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchActivities = useCallback(async () => {
    if (!user) {
      setActivities([]);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("file_activity")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;

      const formatted: FormattedActivity[] = (data || []).map((item: FileActivity) => ({
        id: item.id,
        name: item.file_name,
        type: mapFileType(item.file_type),
        action: mapAction(item.action),
        time: formatDistanceToNow(new Date(item.created_at), { addSuffix: true }),
        source: mapSource(item.source),
      }));

      setActivities(formatted);
    } catch (err) {
      console.error("Failed to fetch file activity:", err);
    } finally {
      setLoading(false);
    }
  }, [user, limit]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  return {
    activities,
    loading,
    refetch: fetchActivities,
  };
};
