import React from "react";
import { FileText, Image, FolderOpen, Music, Video } from "lucide-react";

interface ActivityItem {
  id: string;
  name: string;
  type: 'document' | 'image' | 'folder' | 'audio' | 'video';
  action: 'synced' | 'uploaded' | 'modified';
  time: string;
  source: 'onedrive' | 'google-drive';
}

const getIcon = (type: ActivityItem['type']) => {
  const icons = {
    document: FileText,
    image: Image,
    folder: FolderOpen,
    audio: Music,
    video: Video,
  };
  return icons[type];
};

const getActionColor = (action: ActivityItem['action']) => {
  const colors = {
    synced: 'text-primary',
    uploaded: 'text-green-400',
    modified: 'text-accent',
  };
  return colors[action];
};

interface RecentActivityProps {
  activities: ActivityItem[];
  loading?: boolean;
}

export const RecentActivity = ({ activities, loading = false }: RecentActivityProps) => {
  return (
    <div className="glass rounded-xl p-6">
      <h2 className="font-display text-xl font-semibold text-foreground mb-4">Recent Activity</h2>
      
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-secondary/30 animate-pulse">
              <div className="p-2 rounded-lg bg-secondary w-8 h-8" />
              <div className="flex-1">
                <div className="h-4 bg-secondary rounded w-3/4 mb-2" />
                <div className="h-3 bg-secondary rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : activities.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <p>No recent activity</p>
          <p className="text-sm mt-1">Activities will appear here once you start syncing files</p>
        </div>
      ) : (
        <div className="space-y-3">
          {activities.map((activity, index) => {
            const Icon = getIcon(activity.type);
            return (
              <div 
                key={activity.id} 
                className="flex items-center gap-4 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors animate-slide-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className="p-2 rounded-lg bg-secondary">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                </div>
                
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{activity.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className={getActionColor(activity.action)}>{activity.action}</span>
                    {' • '}
                    {activity.source === 'onedrive' ? 'OneDrive' : 'Google Drive'}
                  </p>
                </div>
                
                <span className="text-xs text-muted-foreground whitespace-nowrap">{activity.time}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export type { ActivityItem };
