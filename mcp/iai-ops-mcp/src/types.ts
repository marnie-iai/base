/**
 * The board API's full response shape isn't documented anywhere in the
 * source skills beyond the fields they reference. Card is intentionally
 * loose (index signature) so unknown fields pass through untouched rather
 * than being silently dropped, and gets tightened once we've seen a real
 * response.
 */
export interface Card {
  id?: number;
  cardId?: string;
  title?: string;
  description?: string;
  owner?: string;
  domain?: string;
  status?: string;
  priority?: "must" | "should" | "could";
  dependsOn?: number[];
  briefRef?: string;
  referenceUrl?: string;
  filedPath?: string;
  outputPath?: string;
  marnieAction?: string;
  sessionNotes?: string;
  [key: string]: unknown;
}

export type DebriefActionFn =
  | "log_activity"
  | "update_module_state"
  | "update_milestone"
  | "set_next_milestone"
  | "update_questionnaire_status"
  | "publish_deliverable";

export interface DebriefAction {
  fn: DebriefActionFn;
  [key: string]: unknown;
}
