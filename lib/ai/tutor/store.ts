import type { SupabaseClient } from "@supabase/supabase-js";
import type { TutorConversation, TutorMessage, TutorRole, TutorSource } from "./types";

// Where conversations are kept. The tutor flow depends on this interface
// only, so it can be tested with an in-memory stand-in.
//
// A store always acts for ONE signed-in user. Whatever the backend, it must
// behave as if other users' rows do not exist: lookups return null and writes
// are refused. The caller never passes a user id to choose whose data to use.
export interface TutorStore {
  // Null for an unknown subject and for another user's subject alike.
  getSubject(id: string): Promise<{ id: string; name: string } | null>;
  // Null for an unknown conversation and for another user's alike.
  getConversation(id: string): Promise<TutorConversation | null>;
  createConversation(input: { title: string; subjectId: string | null }): Promise<TutorConversation>;
  setConversationSubject(id: string, subjectId: string | null): Promise<void>;
  // The last `limit` messages of a conversation, oldest first.
  recentMessages(conversationId: string, limit: number): Promise<TutorMessage[]>;
  addMessage(input: { conversationId: string; role: TutorRole; content: string; sources?: TutorSource[] }): Promise<TutorMessage>;
  // How many messages this user has sent since a moment in time.
  countUserMessagesSince(since: Date): Promise<number>;
}

type ConversationRow = { id: string; title: string; subject_id: string | null; updated_at: string };
type MessageRow = { id: string; role: TutorRole; content: string; sources: unknown; created_at: string };

export const CONVERSATION_COLUMNS = "id, title, subject_id, updated_at";
export const MESSAGE_COLUMNS = "id, role, content, sources, created_at";

export function toConversation(row: ConversationRow): TutorConversation {
  return { id: row.id, title: row.title, subjectId: row.subject_id, updatedAt: row.updated_at };
}

export function toMessage(row: MessageRow): TutorMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sources: Array.isArray(row.sources) ? (row.sources as TutorSource[]) : [],
    createdAt: row.created_at,
  };
}

// Conversations in the app's own Supabase database, reached with the signed-in
// user's own client. Row Level Security is what limits every query to that
// user; the user_id filters state the intent and let Postgres use its
// indexes. user_id is never written: the database fills it in from the
// session, and clients have no privilege to set it.
export class SupabaseTutorStore implements TutorStore {
  private readonly supabase: SupabaseClient;
  private readonly userId: string;

  constructor(supabase: SupabaseClient, userId: string) {
    this.supabase = supabase;
    this.userId = userId;
  }

  async getSubject(id: string) {
    const { data, error } = await this.supabase
      .from("subjects")
      .select("id, name")
      .eq("user_id", this.userId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`subjects select: ${error.code}`);
    return data as { id: string; name: string } | null;
  }

  async getConversation(id: string) {
    const { data, error } = await this.supabase
      .from("tutor_conversations")
      .select(CONVERSATION_COLUMNS)
      .eq("user_id", this.userId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`tutor_conversations select: ${error.code}`);
    return data ? toConversation(data as ConversationRow) : null;
  }

  async createConversation({ title, subjectId }: { title: string; subjectId: string | null }) {
    const { data, error } = await this.supabase
      .from("tutor_conversations")
      .insert({ title, subject_id: subjectId })
      .select(CONVERSATION_COLUMNS)
      .single();
    if (error) throw new Error(`tutor_conversations insert: ${error.code}`);
    return toConversation(data as ConversationRow);
  }

  async setConversationSubject(id: string, subjectId: string | null) {
    const { error } = await this.supabase
      .from("tutor_conversations")
      .update({ subject_id: subjectId })
      .eq("user_id", this.userId)
      .eq("id", id);
    if (error) throw new Error(`tutor_conversations update: ${error.code}`);
  }

  async recentMessages(conversationId: string, limit: number) {
    const { data, error } = await this.supabase
      .from("tutor_messages")
      .select(MESSAGE_COLUMNS)
      .eq("user_id", this.userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`tutor_messages select: ${error.code}`);
    return (data as MessageRow[]).map(toMessage).reverse();
  }

  async addMessage({ conversationId, role, content, sources = [] }: Parameters<TutorStore["addMessage"]>[0]) {
    const { data, error } = await this.supabase
      .from("tutor_messages")
      .insert({ conversation_id: conversationId, role, content, sources })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw new Error(`tutor_messages insert: ${error.code}`);
    return toMessage(data as MessageRow);
  }

  async countUserMessagesSince(since: Date) {
    const { count, error } = await this.supabase
      .from("tutor_messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", this.userId)
      .eq("role", "user")
      .gte("created_at", since.toISOString());
    if (error) throw new Error(`tutor_messages count: ${error.code}`);
    return count ?? 0;
  }
}
