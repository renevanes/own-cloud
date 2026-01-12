import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Clock } from "lucide-react";

interface SyncScheduleSelectorProps {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

const scheduleOptions = [
  { value: "manual", label: "Manual only" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export const SyncScheduleSelector: React.FC<SyncScheduleSelectorProps> = ({
  value,
  onChange,
  disabled,
}) => {
  return (
    <div className="flex items-center gap-2">
      <Clock className="h-4 w-4 text-muted-foreground" />
      <Select
        value={value || "manual"}
        onValueChange={(v) => onChange(v === "manual" ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger className="w-36 h-8 text-sm">
          <SelectValue placeholder="Schedule" />
        </SelectTrigger>
        <SelectContent>
          {scheduleOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};