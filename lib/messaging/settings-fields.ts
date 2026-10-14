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
  group: "Content" | "Requests" | "Rate limits" | "Delivery" | "Retention" | "Abuse signals";
}

// On/off policy switches (checkboxes). An unchecked box is OFF.
export interface MessagingBooleanField {
  key: string;
  label: string;
  help: string;
  group: MessagingSettingField["group"] | "Moderation";
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
  { key: "messaging_retention_messages_days", label: "Delete ordinary messages after", help: "Blank (the default) means no age-based deletion while the accounts and conversation stay active.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_unsent_days", label: "Keep deleted messages' originals", help: "Counted from when the message was deleted. Never applied to a message on an open report or under a hold. Blank keeps them.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_reported_days", label: "Keep report evidence after the case closes", help: "Counted from case closure. An open report is never purged. Blank keeps it.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_closed_account_days", label: "Delete messages after an account closes", help: "Counted from the account's recorded closure. A hold preserves only what it names. Blank keeps them.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_moderation_days", label: "Delete closed report records after", help: "The decision record itself, not the evidence. Blank keeps it.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_retention_audit_days", label: "Keep security metadata", help: "Resolved abuse signals, ended restrictions and released holds. The audit log itself is permanent. Blank keeps it.", unit: "days", min: 1, max: 36500, nullable: true, group: "Retention" },
  { key: "messaging_abuse_window_seconds", label: "Signals: look-back window", help: "How far back the abuse checks count.", unit: "seconds", min: 60, max: 604800, group: "Abuse signals" },
  { key: "messaging_abuse_requests_threshold", label: "Signal: many new requests", help: "Message Requests sent within the window before this is flagged.", unit: "requests", min: 1, max: 1000, group: "Abuse signals" },
  { key: "messaging_abuse_declines_threshold", label: "Signal: repeated declines", help: "Requests declined within the window before this is flagged.", unit: "declines", min: 1, max: 1000, group: "Abuse signals" },
  { key: "messaging_abuse_blocks_threshold", label: "Signal: repeated blocks", help: "Different Members who blocked someone within the window.", unit: "Members", min: 1, max: 1000, group: "Abuse signals" },
  { key: "messaging_abuse_reports_threshold", label: "Signal: repeated reports", help: "Different Members who reported someone within the window.", unit: "Members", min: 1, max: 1000, group: "Abuse signals" },
  { key: "messaging_abuse_duplicate_threshold", label: "Signal: duplicate bursts", help: "Identical messages from one Member within the window.", unit: "messages", min: 2, max: 1000, group: "Abuse signals" },
  { key: "messaging_abuse_rapid_window_seconds", label: "Signal: rapid messaging window", help: "Window for the rapid-messaging check.", unit: "seconds", min: 10, max: 86400, group: "Abuse signals" },
  { key: "messaging_abuse_rapid_threshold", label: "Signal: rapid messaging", help: "Messages from one Member within that window.", unit: "messages", min: 2, max: 10000, group: "Abuse signals" },
  { key: "messaging_abuse_coordinated_threshold", label: "Signal: many people asking one Member", help: "Different Members sending requests to one Member within the window. Flag only.", unit: "Members", min: 2, max: 1000, group: "Abuse signals" },
  { key: "messaging_abuse_restrict_hours", label: "Temporary restriction length", help: "How long an automatic restriction on new requests lasts, if that rule is switched on.", unit: "hours", min: 1, max: 168, group: "Abuse signals" },
];

export const MESSAGING_BOOLEAN_FIELDS: readonly MessagingBooleanField[] = [
  { key: "messaging_retention_purge_enabled", label: "Run the retention purge", help: "Off by default. Nothing is deleted until this is on, whatever the durations say.", group: "Retention" },
  { key: "messaging_report_outcome_notifications_enabled", label: "Tell reporters when a report is reviewed", help: "A generic notification: reviewed, and whether action was taken. Nothing else.", group: "Moderation" },
  { key: "messaging_abuse_restrict_enabled", label: "Allow a temporary restriction on new requests", help: "Off by default: signals are only flagged for moderators. When on, only the sender-behaviour signals can restrict, for a short bounded time, and a Super Admin can lift it.", group: "Abuse signals" },
];
