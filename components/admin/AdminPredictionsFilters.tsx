import { ADMIN_PREDICTION_RESULTS, ADMIN_PREDICTION_STATES, ADMIN_SEARCH_MAX_LENGTH, type AdminPredictionFilters } from "@/lib/predictions/admin-rows";
import { Button } from "@/components/ui/button";

const RESULT_LABELS: Record<(typeof ADMIN_PREDICTION_RESULTS)[number], string> = { CORRECT: "Correct", INCORRECT: "Incorrect", VOID: "Void", NONE: "Not graded" };
const STATE_LABELS: Record<(typeof ADMIN_PREDICTION_STATES)[number], string> = { PENDING: "Pending", GRADED: "Graded" };

const field = "h-9 w-full rounded-lg border border-border-subtle bg-background px-2.5 text-sm text-text-primary";

/**
 * A plain GET form: the filters live in the URL (shareable, back-button friendly, no client state), and the page re-queries on the server.
 * Every control has a visible label; nothing relies on colour. Wraps to one column at 320px and a single row at desktop widths.
 */
export function AdminPredictionsFilters({ filters }: { filters: AdminPredictionFilters }) {
  return (
    <form method="get" role="search" aria-label="Filter predictions" className="space-y-3 rounded-lg border border-border-subtle p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
        <div className="space-y-1">
          <label htmlFor="pred-q" className="text-xs font-medium text-text-secondary">
            Search
          </label>
          <input
            id="pred-q"
            name="q"
            type="search"
            defaultValue={filters.query ?? ""}
            maxLength={ADMIN_SEARCH_MAX_LENGTH}
            placeholder="Username, user id, team or game, Market id"
            autoComplete="off"
            className={field}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="pred-state" className="text-xs font-medium text-text-secondary">
            State
          </label>
          <select id="pred-state" name="state" defaultValue={filters.state ?? ""} className={field}>
            <option value="">Any state</option>
            {ADMIN_PREDICTION_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="pred-result" className="text-xs font-medium text-text-secondary">
            Result
          </label>
          <select id="pred-result" name="result" defaultValue={filters.result ?? ""} className={field}>
            <option value="">Any result</option>
            {ADMIN_PREDICTION_RESULTS.map((r) => (
              <option key={r} value={r}>
                {RESULT_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="pred-from" className="text-xs font-medium text-text-secondary">
            From (UTC date)
          </label>
          <input id="pred-from" name="from" type="date" defaultValue={filters.from ?? ""} className={field} />
        </div>
        <div className="space-y-1">
          <label htmlFor="pred-to" className="text-xs font-medium text-text-secondary">
            To (UTC date)
          </label>
          <input id="pred-to" name="to" type="date" defaultValue={filters.to ?? ""} className={field} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        <a href="/admin/predictions" className="text-sm text-text-secondary underline underline-offset-4 hover:text-text-primary">
          Clear filters
        </a>
      </div>
    </form>
  );
}
