export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      arb_executions: {
        Row: {
          amount_usd: number
          error_message: string | null
          executed_at: string
          fees: number
          id: string
          opportunity_id: string
          realized_pnl: number
          side_a_fill_price: number | null
          side_a_tx: string | null
          side_b_fill_price: number | null
          side_b_tx: string | null
          status: string
        }
        Insert: {
          amount_usd?: number
          error_message?: string | null
          executed_at?: string
          fees?: number
          id?: string
          opportunity_id: string
          realized_pnl?: number
          side_a_fill_price?: number | null
          side_a_tx?: string | null
          side_b_fill_price?: number | null
          side_b_tx?: string | null
          status?: string
        }
        Update: {
          amount_usd?: number
          error_message?: string | null
          executed_at?: string
          fees?: number
          id?: string
          opportunity_id?: string
          realized_pnl?: number
          side_a_fill_price?: number | null
          side_a_tx?: string | null
          side_b_fill_price?: number | null
          side_b_tx?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "arb_executions_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "arb_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      arb_opportunities: {
        Row: {
          detected_at: string
          expired_at: string | null
          id: string
          market_a_id: string
          market_b_id: string
          price_a: number
          price_b: number
          side_a: string
          side_b: string
          spread: number
          status: string
        }
        Insert: {
          detected_at?: string
          expired_at?: string | null
          id?: string
          market_a_id: string
          market_b_id: string
          price_a: number
          price_b: number
          side_a: string
          side_b: string
          spread: number
          status?: string
        }
        Update: {
          detected_at?: string
          expired_at?: string | null
          id?: string
          market_a_id?: string
          market_b_id?: string
          price_a?: number
          price_b?: number
          side_a?: string
          side_b?: string
          spread?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "arb_opportunities_market_a_id_fkey"
            columns: ["market_a_id"]
            isOneToOne: false
            referencedRelation: "prediction_markets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arb_opportunities_market_b_id_fkey"
            columns: ["market_b_id"]
            isOneToOne: false
            referencedRelation: "prediction_markets"
            referencedColumns: ["id"]
          },
        ]
      }
      bundle_results: {
        Row: {
          created_at: string
          entry_amount: number
          exit_amount: number
          id: string
          jito_tip: number
          latency_ms: number
          profit: number
          route: string
          status: string
          trigger_tx: string
          tx_signature: string | null
        }
        Insert: {
          created_at?: string
          entry_amount: number
          exit_amount: number
          id?: string
          jito_tip: number
          latency_ms: number
          profit?: number
          route: string
          status: string
          trigger_tx: string
          tx_signature?: string | null
        }
        Update: {
          created_at?: string
          entry_amount?: number
          exit_amount?: number
          id?: string
          jito_tip?: number
          latency_ms?: number
          profit?: number
          route?: string
          status?: string
          trigger_tx?: string
          tx_signature?: string | null
        }
        Relationships: []
      }
      gnosis_arb_opportunities: {
        Row: {
          combined_price: number
          cow_order_id: string | null
          created_at: string
          error_message: string | null
          id: string
          market_id: string
          market_question: string
          no_price: number
          platform: string
          profit_usd: number
          settling_at: string | null
          spread: number
          status: string
          strategy: string
          tx_hash: string | null
          yes_price: number
        }
        Insert: {
          combined_price?: number
          cow_order_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          market_id: string
          market_question: string
          no_price?: number
          platform: string
          profit_usd?: number
          settling_at?: string | null
          spread?: number
          status?: string
          strategy?: string
          tx_hash?: string | null
          yes_price?: number
        }
        Update: {
          combined_price?: number
          cow_order_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          market_id?: string
          market_question?: string
          no_price?: number
          platform?: string
          profit_usd?: number
          settling_at?: string | null
          spread?: number
          status?: string
          strategy?: string
          tx_hash?: string | null
          yes_price?: number
        }
        Relationships: []
      }
      prediction_markets: {
        Row: {
          category: string | null
          created_at: string
          end_date: string | null
          external_id: string
          id: string
          last_synced_at: string
          no_price: number
          platform: string
          question: string
          url: string | null
          volume: number
          yes_price: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          end_date?: string | null
          external_id: string
          id?: string
          last_synced_at?: string
          no_price?: number
          platform: string
          question: string
          url?: string | null
          volume?: number
          yes_price?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          end_date?: string | null
          external_id?: string
          id?: string
          last_synced_at?: string
          no_price?: number
          platform?: string
          question?: string
          url?: string | null
          volume?: number
          yes_price?: number
        }
        Relationships: []
      }
      whale_trades: {
        Row: {
          amount_usd: number
          created_at: string
          direction: string
          id: string
          token_in: string
          token_out: string
          tx_signature: string
          wallet: string
        }
        Insert: {
          amount_usd: number
          created_at?: string
          direction: string
          id?: string
          token_in: string
          token_out: string
          tx_signature: string
          wallet: string
        }
        Update: {
          amount_usd?: number
          created_at?: string
          direction?: string
          id?: string
          token_in?: string
          token_out?: string
          tx_signature?: string
          wallet?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
