import React from "react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface StorageCardProps {
  icon: React.ReactNode;
  name: string;
  used: number;
  total: number;
  color: string;
  connected: boolean;
  accountEmail?: string | null;
  compact?: boolean;
}

export const StorageCard = ({ icon, name, used, total, color, connected, accountEmail, compact }: StorageCardProps) => {
  const percentage = total > 0 ? (used / total) * 100 : 0;
  
  if (compact) {
    return (
      <div className="glass rounded-xl p-4 transition-all duration-300 hover:shadow-lg hover:shadow-primary/10 group">
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg transition-transform duration-300 group-hover:scale-110", color)}>
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display font-semibold text-foreground text-sm">{name}</h3>
              <span className={cn("text-xs shrink-0", connected ? 'text-primary' : 'text-muted-foreground')}>
                {connected ? '● Connected' : '○ Disconnected'}
              </span>
            </div>
            {connected && accountEmail && (
              <p className="text-xs text-muted-foreground truncate" title={accountEmail}>
                {accountEmail}
              </p>
            )}
            <div className="mt-2">
              <Progress value={connected ? percentage : 0} className="h-1.5" />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>{connected ? `${used.toFixed(1)} GB` : '-'}</span>
                <span>{total.toFixed(0)} GB</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  return (
    <div className="glass rounded-xl p-6 transition-all duration-300 hover:shadow-lg hover:shadow-primary/10 group">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={cn("p-3 rounded-lg transition-transform duration-300 group-hover:scale-110", color)}>
            {icon}
          </div>
          <div>
            <h3 className="font-display font-semibold text-foreground">{name}</h3>
            <span className={cn("text-xs", connected ? 'text-primary' : 'text-muted-foreground')}>
              {connected ? '● Connected' : '○ Disconnected'}
            </span>
            {connected && accountEmail && (
              <p className="text-xs text-muted-foreground truncate max-w-[150px]" title={accountEmail}>
                {accountEmail}
              </p>
            )}
          </div>
        </div>
      </div>
      
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {connected ? `${used.toFixed(1)} GB used` : 'Not connected'}
          </span>
          <span className="text-foreground font-medium">{total.toFixed(0)} GB</span>
        </div>
        <Progress value={connected ? percentage : 0} className="h-2" />
        <p className="text-xs text-muted-foreground text-right">
          {connected ? `${(total - used).toFixed(1)} GB free` : 'Connect to see storage'}
        </p>
      </div>
    </div>
  );
};
