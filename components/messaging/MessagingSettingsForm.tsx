"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setMessagingConfigAction, type MessagingAdminResult } from "@/lib/actions/messaging-admin";
import { MESSAGING_BOOLEAN_FIELDS, MESSAGING_SETTING_FIELDS } from "@/lib/messaging/settings-fields";

export function MessagingSettingsForm({ enabled, values }: { enabled: boolean; values: Record<string, number | boolean | null> }) {
  const [state, action, pending] = useActionState<MessagingAdminResult | null, FormData>(setMessagingConfigAction, null);
  const groups = [...new Set([...MESSAGING_SETTING_FIELDS.map((f) => f.group), ...MESSAGING_BOOLEAN_FIELDS.map((f) => f.group)])];
  return (
    <form action={action} className="space-y-4" data-slot="messaging-settings-form">
      <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <input type="checkbox" name="messaging_enabled" defaultChecked={enabled} className="size-4" />
        Members can send messages
      </label>
      {groups.map((group) => (
        <fieldset key={group} className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-text-muted">{group}</legend>
          {MESSAGING_BOOLEAN_FIELDS.filter((f) => f.group === group).map((f) => (
            <label key={f.key} className="flex items-start gap-2 text-xs font-medium text-text-secondary">
              <input type="checkbox" name={f.key} defaultChecked={values[f.key] === true} className="mt-0.5 size-4" />
              <span>
                {f.label}
                <span className="block font-normal text-text-muted">{f.help}</span>
              </span>
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            {MESSAGING_SETTING_FIELDS.filter((f) => f.group === group).map((f) => (
              <label key={f.key} className="space-y-1 text-xs font-medium text-text-secondary">
                {f.label} ({f.unit})
                <input
                  type="number"
                  name={f.key}
                  min={f.min}
                  max={f.max}
                  defaultValue={values[f.key] === null || values[f.key] === undefined ? "" : String(values[f.key])}
                  placeholder={f.nullable ? "Keep" : undefined}
                  aria-describedby={`${f.key}-help`}
                  className="block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary"
                />
                <span id={`${f.key}-help`} className="block font-normal text-text-muted">
                  {f.help}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <Button type="submit" variant="outline" disabled={pending}>
        Save
      </Button>
      {state && (
        <p role={state.success ? "status" : "alert"} className={state.success ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
