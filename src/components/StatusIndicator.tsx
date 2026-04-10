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
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-1.5 w-1.5">
        {status === "scanning" && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors[status]} opacity-75`} />
        )}
        <motion.span
          className={`relative inline-flex rounded-full h-1.5 w-1.5 ${colors[status]}`}
          animate={status === "scanning" ? { opacity: [1, 0.4, 1] } : {}}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/70">{label}</span>
    </div>
  );
};
