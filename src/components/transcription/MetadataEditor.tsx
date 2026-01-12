import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Plus } from "lucide-react";
import { StoredTranscription } from "@/lib/transcription-storage";

interface MetadataEditorProps {
  transcription: StoredTranscription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (updates: Partial<StoredTranscription>) => void;
}

export const MetadataEditor: React.FC<MetadataEditorProps> = ({
  transcription,
  open,
  onOpenChange,
  onSave,
}) => {
  const [callDate, setCallDate] = useState(transcription.callDate || "");
  const [callerName, setCallerName] = useState(transcription.callerName || "");
  const [callerPhone, setCallerPhone] = useState(transcription.callerPhone || "");
  const [callDirection, setCallDirection] = useState<'inbound' | 'outbound' | undefined>(transcription.callDirection);
  const [callType, setCallType] = useState<'phone' | 'meeting' | 'voice_memo' | 'other' | undefined>(transcription.callType);
  const [notes, setNotes] = useState(transcription.notes || "");
  const [tags, setTags] = useState<string[]>(transcription.tags || []);
  const [newTag, setNewTag] = useState("");

  useEffect(() => {
    setCallDate(transcription.callDate || "");
    setCallerName(transcription.callerName || "");
    setCallerPhone(transcription.callerPhone || "");
    setCallDirection(transcription.callDirection);
    setCallType(transcription.callType);
    setNotes(transcription.notes || "");
    setTags(transcription.tags || []);
  }, [transcription]);

  const handleAddTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      setTags([...tags, newTag.trim()]);
      setNewTag("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleSave = () => {
    onSave({
      callDate: callDate || undefined,
      callerName: callerName || undefined,
      callerPhone: callerPhone || undefined,
      callDirection,
      callType,
      notes: notes || undefined,
      tags: tags.length > 0 ? tags : undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Call Metadata</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Call Date/Time */}
          <div className="grid gap-2">
            <Label htmlFor="callDate">Call Date & Time</Label>
            <Input
              id="callDate"
              type="datetime-local"
              value={callDate ? new Date(callDate).toISOString().slice(0, 16) : ""}
              onChange={(e) => setCallDate(e.target.value ? new Date(e.target.value).toISOString() : "")}
            />
            <p className="text-xs text-muted-foreground">When the original call took place</p>
          </div>

          {/* Caller Name */}
          <div className="grid gap-2">
            <Label htmlFor="callerName">Caller Name</Label>
            <Input
              id="callerName"
              placeholder="Enter caller name"
              value={callerName}
              onChange={(e) => setCallerName(e.target.value)}
            />
          </div>

          {/* Phone Number */}
          <div className="grid gap-2">
            <Label htmlFor="callerPhone">Phone Number</Label>
            <Input
              id="callerPhone"
              placeholder="+1 (555) 123-4567"
              value={callerPhone}
              onChange={(e) => setCallerPhone(e.target.value)}
            />
          </div>

          {/* Call Direction & Type Row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Call Direction</Label>
              <Select
                value={callDirection}
                onValueChange={(value: 'inbound' | 'outbound') => setCallDirection(value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select direction" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inbound">Inbound</SelectItem>
                  <SelectItem value="outbound">Outbound</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label>Call Type</Label>
              <Select
                value={callType}
                onValueChange={(value: 'phone' | 'meeting' | 'voice_memo' | 'other') => setCallType(value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="phone">Phone Call</SelectItem>
                  <SelectItem value="meeting">Meeting</SelectItem>
                  <SelectItem value="voice_memo">Voice Memo</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Notes */}
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Add notes about this call..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>

          {/* Tags */}
          <div className="grid gap-2">
            <Label>Tags</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Add a tag"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={handleKeyDown}
                className="flex-1"
              />
              <Button type="button" variant="secondary" size="icon" onClick={handleAddTag}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="hover:bg-muted rounded-full p-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
