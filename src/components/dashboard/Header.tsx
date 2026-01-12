import React from "react";
import { CloudIcon } from "@/components/icons/CloudIcons";
import { Settings, Bell, FolderOpen, FolderSync, Home, Mic, FileText, Sparkles, Mail, Receipt, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserMenu } from "@/components/dashboard/UserMenu";
import { useAuth } from "@/hooks/useAuth";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

export const Header = () => {
  const { user } = useAuth();
  const location = useLocation();

  const navItems = [
    { path: "/", label: "Dashboard", icon: Home },
    { path: "/ai-chat", label: "AI Chat", icon: Sparkles },
    { path: "/files", label: "Files", icon: FolderOpen },
    { path: "/sync", label: "Sync", icon: FolderSync },
    { path: "/transcribe", label: "Transcribe", icon: Mic },
    { path: "/transcribe/view", label: "Transcriptions", icon: FileText },
    { path: "/email", label: "Email", icon: Mail },
    { path: "/messages", label: "Messages", icon: MessageSquare },
    { path: "/invoices", label: "Invoices", icon: Receipt },
  ];

  return (
    <header className="py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary to-accent">
            <CloudIcon className="w-8 h-8 text-primary-foreground" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold gradient-text">CloudSync</h1>
            <p className="text-sm text-muted-foreground">Personal Cloud Manager</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {user ? (
            <>
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="w-5 h-5" />
                <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full" />
              </Button>
              <Link to="/settings">
                <Button variant="ghost" size="icon">
                  <Settings className="w-5 h-5" />
                </Button>
              </Link>
              <UserMenu />
            </>
          ) : (
            <Link to="/auth">
              <Button variant="gradient">Sign In</Button>
            </Link>
          )}
        </div>
      </div>

      {user && (
        <nav className="mt-4 flex items-center gap-1 glass rounded-lg p-1 w-fit">
          {navItems.map(({ path, label, icon: Icon }) => (
            <Link key={path} to={path}>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "gap-2",
                  location.pathname === path && "bg-primary/20 text-primary"
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Button>
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
};
