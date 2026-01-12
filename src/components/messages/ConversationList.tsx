import { MessageSquare, Phone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface Conversation {
  id: string;
  name: string;
  phone_number?: string;
  source_type: 'whatsapp' | 'sms';
  message_count: number;
  first_message_at?: string;
  last_message_at?: string;
  source_file: string;
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (conversation: Conversation) => void;
  onDelete: (id: string) => void;
  isLoading?: boolean;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
  isLoading,
}: ConversationListProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading conversations...
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 text-center">
        <MessageSquare className="w-12 h-12 mb-3 opacity-50" />
        <p className="text-sm">No conversations imported yet</p>
        <p className="text-xs mt-1">Import a WhatsApp or SMS backup to get started</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={cn(
              "group flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors",
              selectedId === conv.id
                ? "bg-primary/10 border border-primary/20"
                : "hover:bg-muted/50"
            )}
            onClick={() => onSelect(conv)}
          >
            <div
              className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium",
                conv.source_type === "whatsapp"
                  ? "bg-green-500/20 text-green-600"
                  : "bg-blue-500/20 text-blue-600"
              )}
            >
              {conv.source_type === "whatsapp" ? (
                <MessageSquare className="w-5 h-5" />
              ) : (
                <Phone className="w-5 h-5" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{conv.name}</span>
                <Badge variant="outline" className="text-xs shrink-0">
                  {conv.source_type === "whatsapp" ? "WhatsApp" : "SMS"}
                </Badge>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{conv.message_count} messages</span>
                {conv.last_message_at && (
                  <>
                    <span>•</span>
                    <span>{format(new Date(conv.last_message_at), "MMM d, yyyy")}</span>
                  </>
                )}
              </div>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conv.id);
              }}
            >
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
