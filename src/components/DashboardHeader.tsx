import { StatusIndicator } from "./StatusIndicator";
import { NavLink } from "./NavLink";
import { Zap, LayoutDashboard, GitCompare, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { motion } from "framer-motion";

export const DashboardHeader = () => {
  return (
    <header className="relative border-b border-border/30 px-6 py-3">
      {/* Subtle gradient background */}
      <div className="absolute inset-0 bg-gradient-to-r from-primary/[0.03] via-transparent to-accent/[0.03]" />
      {/* Bottom glow line */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-4">
          <motion.div
            className="flex items-center justify-center h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 glow-primary"
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400 }}
          >
            <Zap className="h-5 w-5 text-primary" />
          </motion.div>
          <div>
            <h1 className="text-base font-bold tracking-tight font-mono text-glow-primary text-primary">
              RICKY TRADES
            </h1>
            <p className="text-[10px] font-mono text-muted-foreground tracking-[0.2em] uppercase">
              MEV Command Center
            </p>
          </div>

          <div className="h-8 w-px bg-border/50 mx-2" />

          <nav className="flex items-center gap-1">
            <NavLink
              to="/"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all"
              activeClassName="text-primary bg-primary/10 border border-primary/20"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Dashboard
            </NavLink>
            <NavLink
              to="/arbitrage"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all"
              activeClassName="text-accent bg-accent/10 border border-accent/20"
            >
              <GitCompare className="h-3.5 w-3.5" />
              Arbitrage
            </NavLink>
          </nav>
        </div>

        <div className="flex items-center gap-5">
          <div className="flex items-center gap-4">
            <StatusIndicator status="connected" label="RPC" />
            <StatusIndicator status="scanning" label="Scanning" />
            <StatusIndicator status="connected" label="Jito" />
          </div>
          <div className="h-6 w-px bg-border/40" />
          <span className="text-[10px] font-mono text-muted-foreground/60 tracking-wider">
            MAINNET
          </span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
