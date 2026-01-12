import React from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Shield, ShieldCheck } from "lucide-react";

interface PermissionSelectorProps {
  value: "read_only" | "read_write";
  onChange: (value: "read_only" | "read_write") => void;
}

export const PermissionSelector: React.FC<PermissionSelectorProps> = ({
  value,
  onChange,
}) => {
  return (
    <RadioGroup
      value={value}
      onValueChange={(val) => onChange(val as "read_only" | "read_write")}
      className="grid grid-cols-2 gap-4"
    >
      <div
        className={`relative flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-all ${
          value === "read_only"
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50"
        }`}
        onClick={() => onChange("read_only")}
      >
        <RadioGroupItem value="read_only" id="read_only" className="mt-1" />
        <div className="flex-1">
          <Label htmlFor="read_only" className="flex items-center gap-2 cursor-pointer font-medium">
            <Shield className="w-4 h-4 text-muted-foreground" />
            Read Only
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            Browse and download files. Cannot modify, upload, or delete files.
          </p>
        </div>
      </div>

      <div
        className={`relative flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-all ${
          value === "read_write"
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50"
        }`}
        onClick={() => onChange("read_write")}
      >
        <RadioGroupItem value="read_write" id="read_write" className="mt-1" />
        <div className="flex-1">
          <Label htmlFor="read_write" className="flex items-center gap-2 cursor-pointer font-medium">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Read & Write
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            Full access. Browse, upload, download, sync, and delete files.
          </p>
        </div>
      </div>
    </RadioGroup>
  );
};
