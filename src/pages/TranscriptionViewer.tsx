import React, { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { 
  ArrowLeft, 
  Clock, 
  FileAudio, 
  Loader2, 
  Copy,
  Check,
  Download,
  Trash2,
  FileText,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  User,
  Calendar,
  Pencil,
  Search,
  Filter,
  Video,
  Mic,
  MessageSquare,
  X,
  RefreshCw,
  Sparkles
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  getStoredTranscriptions, 
  deleteTranscription, 
  StoredTranscription,
  saveTranscription
} from "@/lib/transcription-storage";
import { toast } from "sonner";
import { OneDriveIcon, GoogleDriveIcon, LocalStorageIcon } from "@/components/icons/CloudIcons";
import { cn } from "@/lib/utils";
import { MetadataEditor } from "@/components/transcription/MetadataEditor";
import { supabase } from "@/integrations/supabase/client";
import { AIChatPanel } from "@/components/ai/AIChatPanel";

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatTimestamp = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

const getProviderIcon = (provider: string) => {
  switch (provider) {
    case 'onedrive':
      return OneDriveIcon;
    case 'google_drive':
      return GoogleDriveIcon;
    default:
      return LocalStorageIcon;
  }
};

const getCallTypeIcon = (callType?: string) => {
  switch (callType) {
    case 'phone':
      return Phone;
    case 'meeting':
      return Video;
    case 'voice_memo':
      return Mic;
    default:
      return MessageSquare;
  }
};

const formatDate = (dateStr: string): string => {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

const formatTime = (dateStr: string): string => {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
};

const getDateGroup = (dateStr: string): string => {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  const lastMonth = new Date(today);
  lastMonth.setMonth(lastMonth.getMonth() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (date > lastWeek) return "This Week";
  if (date > lastMonth) return "This Month";
  return "Older";
};

type GroupedTranscriptions = {
  [key: string]: StoredTranscription[];
};

const TranscriptionViewer: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  
  const [transcriptions, setTranscriptions] = useState<StoredTranscription[]>([]);
  const [selectedTranscription, setSelectedTranscription] = useState<StoredTranscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const [metadataEditorOpen, setMetadataEditorOpen] = useState(false);
  
  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);

  const handleRefresh = async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const stored = await getStoredTranscriptions(user.id);
      setTranscriptions(stored);
      if (stored.length > 0 && !selectedTranscription) {
        setSelectedTranscription(stored[0]);
      }
      toast.success(`Loaded ${stored.length} transcription(s)`);
    } catch (error) {
      console.error("Error refreshing:", error);
      toast.error("Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const loadTranscriptions = async () => {
      if (!user) return;
      
      setLoading(true);
      try {
        const stored = await getStoredTranscriptions(user.id);
        setTranscriptions(stored);
        
        const transcriptionId = searchParams.get('id');
        if (transcriptionId) {
          const found = stored.find(t => t.id === transcriptionId);
          if (found) {
            setSelectedTranscription(found);
          }
        } else if (stored.length > 0) {
          setSelectedTranscription(stored[0]);
        }
      } catch (error) {
        console.error("Error loading transcriptions:", error);
        toast.error("Failed to load transcriptions");
      } finally {
        setLoading(false);
      }
    };
    
    loadTranscriptions();
  }, [user, searchParams]);

  // Filter and group transcriptions
  const filteredAndGrouped = useMemo(() => {
    let filtered = transcriptions;

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t => 
        t.fileName.toLowerCase().includes(query) ||
        t.callerName?.toLowerCase().includes(query) ||
        t.callerPhone?.includes(query) ||
        t.transcription.toLowerCase().includes(query) ||
        t.notes?.toLowerCase().includes(query) ||
        t.tags?.some(tag => tag.toLowerCase().includes(query))
      );
    }

    // Apply direction filter
    if (directionFilter !== "all") {
      filtered = filtered.filter(t => t.callDirection === directionFilter);
    }

    // Apply type filter
    if (typeFilter !== "all") {
      filtered = filtered.filter(t => t.callType === typeFilter);
    }

    // Group by original call date (fallback to createdAt if callDate not set)
    const grouped: GroupedTranscriptions = {};
    const dateOrder = ["Today", "Yesterday", "This Week", "This Month", "Older"];
    
    filtered.forEach(t => {
      const dateToUse = t.callDate || t.createdAt;
      const group = getDateGroup(dateToUse);
      if (!grouped[group]) {
        grouped[group] = [];
      }
      grouped[group].push(t);
    });

    // Sort within groups by original call date descending
    Object.keys(grouped).forEach(key => {
      grouped[key].sort((a, b) => {
        const dateA = a.callDate || a.createdAt;
        const dateB = b.callDate || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });
    });

    // Return ordered groups
    const orderedGroups: { group: string; items: StoredTranscription[] }[] = [];
    dateOrder.forEach(group => {
      if (grouped[group] && grouped[group].length > 0) {
        orderedGroups.push({ group, items: grouped[group] });
      }
    });

    return orderedGroups;
  }, [transcriptions, searchQuery, directionFilter, typeFilter]);

  const handleDelete = async (transcription: StoredTranscription) => {
    if (!user) return;
    
    const success = await deleteTranscription(user.id, transcription.id);
    if (success) {
      toast.success("Transcription deleted");
      const updated = transcriptions.filter(t => t.id !== transcription.id);
      setTranscriptions(updated);
      
      if (selectedTranscription?.id === transcription.id) {
        setSelectedTranscription(updated.length > 0 ? updated[0] : null);
      }
    } else {
      toast.error("Failed to delete transcription");
    }
  };

  const handleCopy = async () => {
    if (!selectedTranscription) return;
    
    await navigator.clipboard.writeText(selectedTranscription.transcription);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!selectedTranscription) return;
    
    const blob = new Blob([selectedTranscription.transcription], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedTranscription.fileName.replace(/\.[^/.]+$/, '')}_transcription.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Downloaded transcription");
  };

  const handleDownloadJSON = () => {
    if (!selectedTranscription) return;
    
    const blob = new Blob([JSON.stringify(selectedTranscription, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedTranscription.fileName.replace(/\.[^/.]+$/, '')}_transcription.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Downloaded JSON");
  };

  const handleSaveMetadata = async (updates: Partial<StoredTranscription>) => {
    if (!selectedTranscription || !user) return;

    const updatedTranscription = { ...selectedTranscription, ...updates };
    
    // Save to storage
    const content = JSON.stringify(updatedTranscription, null, 2);
    const { error } = await supabase.storage
      .from("user-files")
      .upload(`${user.id}/Transcriptions/${updatedTranscription.id}.json`, content, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      toast.error("Failed to save metadata");
      return;
    }

    // Update local state
    setTranscriptions(prev => prev.map(t => 
      t.id === updatedTranscription.id ? updatedTranscription : t
    ));
    setSelectedTranscription(updatedTranscription);
    toast.success("Metadata saved");
  };

  const clearFilters = () => {
    setSearchQuery("");
    setDirectionFilter("all");
    setTypeFilter("all");
  };

  const hasActiveFilters = searchQuery || directionFilter !== "all" || typeFilter !== "all";

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const totalFiltered = filteredAndGrouped.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={() => navigate("/transcribe")}>
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div>
                <h1 className="text-xl font-semibold">Call Transcriptions</h1>
                <p className="text-sm text-muted-foreground">View, organize, and manage your call recordings</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setAiChatOpen(true)}
                className="gap-2"
              >
                <Sparkles className="w-4 h-4" />
                Ask AI
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleRefresh} 
                disabled={refreshing}
                className="gap-2"
              >
                <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-180px)]">
          {/* Left sidebar - Transcription list with search/filters */}
          <Card className="lg:col-span-1 flex flex-col">
            <CardHeader className="pb-3 space-y-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Phone className="w-4 h-4" />
                Call History
                <Badge variant="secondary" className="ml-auto">{totalFiltered}</Badge>
              </CardTitle>
              
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search calls..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              
              {/* Filters */}
              <div className="flex gap-2">
                <Select value={directionFilter} onValueChange={setDirectionFilter}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Direction" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Directions</SelectItem>
                    <SelectItem value="inbound">Inbound</SelectItem>
                    <SelectItem value="outbound">Outbound</SelectItem>
                  </SelectContent>
                </Select>
                
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="phone">Phone</SelectItem>
                    <SelectItem value="meeting">Meeting</SelectItem>
                    <SelectItem value="voice_memo">Voice Memo</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="w-full">
                  <X className="w-4 h-4 mr-2" />
                  Clear Filters
                </Button>
              )}
            </CardHeader>
            
            <CardContent className="p-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                {filteredAndGrouped.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 px-4 text-muted-foreground">
                    <FileAudio className="w-10 h-10 mb-3 opacity-50" />
                    <p className="text-sm text-center">
                      {hasActiveFilters ? "No calls match your filters" : "No transcriptions saved yet"}
                    </p>
                    {hasActiveFilters ? (
                      <Button variant="link" size="sm" className="mt-2" onClick={clearFilters}>
                        Clear Filters
                      </Button>
                    ) : (
                      <Button variant="link" size="sm" className="mt-2" onClick={() => navigate("/transcribe")}>
                        Go to Transcribe
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="px-4 pb-4">
                    {filteredAndGrouped.map(({ group, items }) => (
                      <div key={group} className="mb-4">
                        <div className="sticky top-0 bg-card/95 backdrop-blur-sm py-2 z-[1]">
                          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                            <Calendar className="w-3 h-3" />
                            {group}
                            <Badge variant="outline" className="ml-auto text-[10px]">{items.length}</Badge>
                          </h3>
                        </div>
                        <div className="space-y-1">
                          {items.map((t) => {
                            const isSelected = selectedTranscription?.id === t.id;
                            const CallTypeIcon = getCallTypeIcon(t.callType);
                            
                            return (
                              <button
                                key={t.id}
                                onClick={() => setSelectedTranscription(t)}
                                className={cn(
                                  "w-full text-left p-3 rounded-lg transition-all",
                                  isSelected 
                                    ? "bg-primary/10 ring-1 ring-primary shadow-sm" 
                                    : "hover:bg-muted/50"
                                )}
                              >
                                <div className="flex items-start gap-3">
                                  {/* Direction Icon */}
                                  <div className={cn(
                                    "shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
                                    t.callDirection === 'inbound' 
                                      ? "bg-green-500/10 text-green-600" 
                                      : t.callDirection === 'outbound'
                                        ? "bg-blue-500/10 text-blue-600"
                                        : "bg-muted text-muted-foreground"
                                  )}>
                                    {t.callDirection === 'inbound' ? (
                                      <PhoneIncoming className="w-4 h-4" />
                                    ) : t.callDirection === 'outbound' ? (
                                      <PhoneOutgoing className="w-4 h-4" />
                                    ) : (
                                      <CallTypeIcon className="w-4 h-4" />
                                    )}
                                  </div>
                                  
                                  <div className="flex-1 min-w-0">
                                    {/* Caller info or filename */}
                                    <p className="font-medium text-sm truncate">
                                      {t.callerName || t.fileName}
                                    </p>
                                    {t.callerPhone && (
                                      <p className="text-xs text-muted-foreground truncate">
                                        {t.callerPhone}
                                      </p>
                                    )}
                                    {!t.callerName && !t.callerPhone && (
                                      <p className="text-xs text-muted-foreground truncate">
                                        {t.sourcePath}
                                      </p>
                                    )}
                                    
                                    {/* Time and duration - show call date */}
                                    <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                                      <span>{formatTime(t.callDate || t.createdAt)}</span>
                                      {t.duration && (
                                        <>
                                          <span className="opacity-50">•</span>
                                          <span className="flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            {formatDuration(t.duration)}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                    
                                    {/* Tags */}
                                    {t.tags && t.tags.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-2">
                                        {t.tags.slice(0, 2).map(tag => (
                                          <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                                            {tag}
                                          </Badge>
                                        ))}
                                        {t.tags.length > 2 && (
                                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                            +{t.tags.length - 2}
                                          </Badge>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Right side - Transcription viewer */}
          <Card className="lg:col-span-2 flex flex-col">
            {selectedTranscription ? (
              <>
                <CardHeader className="pb-3">
                  {/* Call Metadata Header */}
                  <div className="space-y-4">
                    {/* Main Info Row */}
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-4">
                        {/* Large avatar/icon */}
                        <div className={cn(
                          "shrink-0 w-14 h-14 rounded-full flex items-center justify-center",
                          selectedTranscription.callDirection === 'inbound' 
                            ? "bg-green-500/10 text-green-600" 
                            : selectedTranscription.callDirection === 'outbound'
                              ? "bg-blue-500/10 text-blue-600"
                              : "bg-orange-500/10 text-orange-600"
                        )}>
                          {selectedTranscription.callerName ? (
                            <User className="w-7 h-7" />
                          ) : selectedTranscription.callDirection === 'inbound' ? (
                            <PhoneIncoming className="w-7 h-7" />
                          ) : selectedTranscription.callDirection === 'outbound' ? (
                            <PhoneOutgoing className="w-7 h-7" />
                          ) : (
                            <FileAudio className="w-7 h-7" />
                          )}
                        </div>
                        
                        <div>
                          <h2 className="text-lg font-semibold">
                            {selectedTranscription.callerName || selectedTranscription.fileName}
                          </h2>
                          {selectedTranscription.callerPhone && (
                            <p className="text-sm text-muted-foreground">
                              {selectedTranscription.callerPhone}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            {selectedTranscription.callDirection && (
                              <Badge 
                                variant={selectedTranscription.callDirection === 'inbound' ? 'default' : 'secondary'}
                                className={cn(
                                  "text-xs",
                                  selectedTranscription.callDirection === 'inbound' 
                                    ? "bg-green-500/20 text-green-700 hover:bg-green-500/30" 
                                    : "bg-blue-500/20 text-blue-700 hover:bg-blue-500/30"
                                )}
                              >
                                {selectedTranscription.callDirection === 'inbound' ? 'Inbound' : 'Outbound'}
                              </Badge>
                            )}
                            {selectedTranscription.callType && (
                              <Badge variant="outline" className="text-xs capitalize">
                                {selectedTranscription.callType.replace('_', ' ')}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="icon" onClick={() => setMetadataEditorOpen(true)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={handleCopy}>
                          {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" onClick={handleDownload}>
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          onClick={() => handleDelete(selectedTranscription)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    
                    {/* Metadata Row */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5" />
                        {formatDate(selectedTranscription.createdAt)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        {formatTime(selectedTranscription.createdAt)}
                      </span>
                      {selectedTranscription.duration && (
                        <span>Duration: {formatDuration(selectedTranscription.duration)}</span>
                      )}
                      {selectedTranscription.sourceProvider && (
                        <span className="flex items-center gap-1.5">
                          {(() => {
                            const ProviderIcon = getProviderIcon(selectedTranscription.sourceProvider);
                            return <ProviderIcon className="w-3.5 h-3.5" />;
                          })()}
                          <span className="capitalize">{selectedTranscription.sourceProvider.replace('_', ' ')}</span>
                        </span>
                      )}
                    </div>
                    
                    {/* Tags */}
                    {selectedTranscription.tags && selectedTranscription.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedTranscription.tags.map(tag => (
                          <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                    
                    {/* Notes */}
                    {selectedTranscription.notes && (
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="text-sm text-muted-foreground">{selectedTranscription.notes}</p>
                      </div>
                    )}
                  </div>
                </CardHeader>
                
                <Separator />
                
                <CardContent className="p-0 flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    {selectedTranscription.segments && selectedTranscription.segments.length > 0 ? (
                      <div className="p-6 space-y-1">
                        {selectedTranscription.segments.map((segment, index) => {
                          const isNewParagraph = index === 0 || 
                            (segment.start - selectedTranscription.segments![index - 1].end) > 2;
                          
                          return (
                            <div key={segment.id}>
                              {isNewParagraph && index > 0 && <div className="h-4" />}
                              <div 
                                className={cn(
                                  "group flex gap-4 py-1.5 px-3 -mx-3 rounded-lg transition-all",
                                  activeSegmentId === segment.id 
                                    ? "bg-primary/10" 
                                    : "hover:bg-muted/30"
                                )}
                                onMouseEnter={() => setActiveSegmentId(segment.id)}
                                onMouseLeave={() => setActiveSegmentId(null)}
                              >
                                <span className="shrink-0 text-[11px] text-muted-foreground/60 font-mono pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity w-16 text-right">
                                  {formatTimestamp(segment.start)}
                                </span>
                                <p className="text-[15px] leading-relaxed flex-1 text-foreground/90">
                                  {segment.text}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-6">
                        <p className="text-[15px] leading-[1.8] whitespace-pre-wrap text-foreground/90">
                          {selectedTranscription.transcription}
                        </p>
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
                
                <Separator />
                
                <div className="p-4 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={handleDownloadJSON}>
                    <Download className="w-4 h-4 mr-2" />
                    Export JSON
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleDownload}>
                    <Download className="w-4 h-4 mr-2" />
                    Export Text
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Phone className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">Select a call to view transcription</p>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Metadata Editor Dialog */}
      {selectedTranscription && (
        <MetadataEditor
          transcription={selectedTranscription}
          open={metadataEditorOpen}
          onOpenChange={setMetadataEditorOpen}
          onSave={handleSaveMetadata}
        />
      )}

      {/* AI Chat Panel */}
      <AIChatPanel
        open={aiChatOpen}
        onClose={() => setAiChatOpen(false)}
        fileContext={selectedTranscription ? {
          content: selectedTranscription.transcription || 
            (selectedTranscription.segments?.map(s => s.text).join(' ') || 'No transcription content available'),
          fileName: selectedTranscription.fileName,
          fileType: 'transcription',
          metadata: {
            duration: selectedTranscription.duration,
            callerName: selectedTranscription.callerName,
            callerPhone: selectedTranscription.callerPhone,
            callDirection: selectedTranscription.callDirection,
            callType: selectedTranscription.callType,
            tags: selectedTranscription.tags,
            notes: selectedTranscription.notes,
          }
        } : undefined}
        suggestedPrompts={[
          "Summarize this call",
          "What are the key action items?",
          "What topics were discussed?",
          "Generate meeting notes",
        ]}
        title="Ask AI About This Call"
      />
    </div>
  );
};

export default TranscriptionViewer;
