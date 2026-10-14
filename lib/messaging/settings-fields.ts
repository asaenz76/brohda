// The Messaging policy fields, in one list that both the Super Admin form and its server action read, so a field can never exist in one and not the other. The ranges mirror the table CHECK
// constraints (migration 198), which remain the authority; this only gives a readable message before the round trip. `nullable` fields (retention) clear back to "keep" when left blank.
export interface MessagingSettingField {
  key: string;
  label: string;
  help: string;
  unit: string;
  min: number;
  max: number;
  nullable?: boolean;
  group: "Content" | "Requests" | "Rate limits" | "Delivery" | "Retention";
}

export const MESSAGING_SETTING_FIELDS: readonly MessagingSettingField[] = [
  { key: "messaging_max_message_length", label: "Longest message", help: "Characters in one text message.", unit: "characters", min: 1, max: 4000, group: "Content" },
  { key: "messaging_unsend_window_seconds", label: "Unsend window", help: "How long after sending a Member can delete their own message. 0 turns deleting off.", unit: "seconds", min: 0, max: 86400, group: "Content" },
  { key: "messaging_duplicate_window_seconds", label: "Repeat-message window", help: "An identical message sent again within this time is refused. 0 turns it off.", unit: "seconds", min: 0, max: 3600, group: "Content" },
  { key: "messaging_max_unanswered_requests", label: "Requests before a reply", help: "Messages one Member can send another before the other accepts (each is a request).", unit: "messages", min: 1, max: 10, group: "Requests" },
  { key: "messaging_send_rate_window_seconds", label: "Sending: window", help: "Time window for the sending limit.", unit: "seconds", min: 1, max: 3600, group: "Rate limits" },
  { key: "messaging_send_rate_max", label: "Sending: most actions", help: "Sends, deletes, blocks and mutes allowed per window.", unit: "actions", min: 1, max: 1000, group: "Rate limits" },
  { key: "messaging_request_rate_window_seconds", label: "New requests: window", help: "Time window for the new-request limit.", unit: "seconds", min: 1, max: 86400, group: "Rate limits" },
  { key: "messaging_request_rate_max", label: "New requests: most", help: "Messages to Members who haven't accepted, allowed per window across all of them.", unit: "messages", min: 1, max: 1000, group: "Rate limits" },
  { key: "messaging_report_rate_window_seconds", label: "Reports: window", help: "Time window for the reporting limit.", unit: "seconds", min: 1, max: 86400, group: "Rate limits" },
  { key: "messaging_report_rate_max", label: "Reports: most", help: "Reports one Member can file per window.", unit: "reports", min: 1, max: 1000, group: "Rate limits" },
  { key: "messaging_poll_interval_seconds", label: "Open-conversation refresh", help: "How often an open conversation checks for news while the tab is visible.", unit: "seconds", min: 3, max: 300, group: "Delivery" },
  { key: "messaging_retention_messages_days", label: "Keep ordinary messages", help: "Blank keeps them. Requires owner and counsel approval before it is set.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_unsent_days", label: "Keep deleted messages' originals", help: "Blank keeps them.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_reported_days", label: "Keep report evidence", help: "Blank keeps it.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_deleted_account_days", label: "Keep conversations of removed accounts", help: "Blank keeps them.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_moderation_days", label: "Keep resolved reports", help: "Blank keeps them.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
];
