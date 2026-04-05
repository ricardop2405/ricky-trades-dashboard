import { motion } from "framer-motion";

interface StatusIndicatorProps {
  status: "connected" | "scanning" | "idle";
  label: string;
}

export const StatusIndicator = ({ status, label }: StatusIndicatorProps) => {
  const colors = {
    connected: "bg-success",
    scanning: "bg-warning",
    idle: "bg-muted-foreground",
  };

  return (
    <div className="flex items-center gap-2">
      <motion.div
        className={`h-2 w-2 rounded-full ${colors[status]}`}
        animate={{ opacity: status === "scanning" ? [1, 0.3, 1] : 1 }}
        transition={{ duration: 1.5, repeat: Infinity }}
      />
      <span className="text-xs font-mono text-muted-foreground">{label}</span>
    </div>
  );
};
